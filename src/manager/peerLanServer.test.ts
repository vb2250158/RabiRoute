import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { PeerLanServer, type PeerLanStatus } from "./peerLanServer.js";
import { PEER_RPC_PATH } from "../rabiPeerProtocol.js";

const localOptions = { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] };

test("peer LAN only delegates encrypted RPC ingress, never sync or Manager control routes", async t => {
  const statuses: PeerLanStatus[] = [];
  let calls = 0;
  const server = new PeerLanServer({ ...localOptions,
    onStatus: status => statuses.push(status),
    peerHandler: (_request, _url, response) => {
      calls++;
      // The actual peer runtime is responsible for authenticating the encrypted packet.
      response.writeHead(400); response.end("rejected"); return true;
    }
  });
  t.after(() => server.stop());
  await server.start();
  const base = server.peerUrls()[0];
  assert.equal((await fetch(`${base}${PEER_RPC_PATH}`, { method: "POST" })).status, 400);
  for (const [method, url] of [
    ["GET", PEER_RPC_PATH], ["GET", "/meta"], ["GET", "/api/rabilink/peer/list"],
    ["POST", "/api/rabilink/peer/call"], ["GET", "/api/persona-sync/manifest"],
    ["GET", "/api/persona-sync/files/Example/persona.md"], ["POST", "/api/persona-sync/merge"],
    ["POST", "/api/persona-sync/plan-packages/active"], ["POST", "/api/persona-sync/plan-packages/archive"]
  ]) {
    const response = await fetch(`${base}${url}`, { method });
    assert.equal(response.status, 404, `${method} ${url}`);
    await response.text();
  }
  assert.equal(calls, 1);
  assert.ok(statuses.some(status => status.state === "starting"));
  assert.ok(statuses.some(status => status.state === "listening"));
  const copy = server.status(); copy.urls.length = 0;
  assert.equal(server.peerUrls().length, 1);
});

test("stopping an in-flight listener does not revive a stale generation", async t => {
  const server = new PeerLanServer({ ...localOptions, peerHandler: () => false });
  t.after(() => server.stop());
  const starting = server.start();
  await server.stop(); await starting;
  assert.equal(server.status().state, "disabled");
  await server.start();
  assert.equal(server.status().state, "listening");
});

test("peer tunnel upgrade is delegated and stop waits for the upgraded connection", async t => {
  let upgraded!: () => void;
  const accepted = new Promise<void>(resolve => { upgraded = resolve; });
  let upgradedSocket: import("node:stream").Duplex | undefined;
  const server = new PeerLanServer({ ...localOptions, peerHandler: () => false,
    peerUpgrade: (_request, socket) => {
      upgradedSocket = socket;
      socket.on("error", () => socket.destroy());
      socket.once("end", () => socket.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.resume();
      upgraded(); return true;
    }
  });
  let socket: net.Socket | undefined;
  t.after(async () => {
    socket?.destroy();
    upgradedSocket?.destroy();
    await server.stop();
  });
  await server.start();
  socket = net.connect(server.status().port!, "127.0.0.1");
  socket.on("error", () => {});
  socket.resume();
  await once(socket, "connect");
  socket.write("GET /peer-tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await accepted;
  let stopped = false;
  const stop = server.stop();
  assert.strictEqual(server.stop(), stop);
  void stop.then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  socket.destroy();
  await stop;
  assert.equal(stopped, true);
  await server.start();
  assert.equal(server.status().state, "listening");
});
