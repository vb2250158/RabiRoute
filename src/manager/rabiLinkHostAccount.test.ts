import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { RabiLinkHostAccount } from "./rabiLinkHostAccount.js";
import { fetchAccountHost } from "./rabiLinkHostAccountProxy.js";
import { readRabiLinkHome } from "./rabiLinkHome.js";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";
import { validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { ACCOUNT_OFFER_PATH, RabiLinkAccountTunnel } from "./rabiLinkAccountTunnel.js";
import { discoverRabiPeers } from "../rabiPeerDiscovery.js";
import { proxyTunnelUpgrade } from "../peerTunnel/http.js";

const pairingHash = (value: string) => createHash("sha256").update(value).digest("hex");

test("account-only hosts join automatically, call a legacy PC, and isolate other accounts", { timeout: 30000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rabi-host-accounts-"));
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", RABILINK_RELAY_DATA_DIR: root }, stdio: ["ignore", "pipe", "ignore"]
  });
  const stop: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    await Promise.allSettled(stop.map(dispose => dispose()));
    if (child.exitCode === null) { const closed = once(child, "exit"); child.kill(); await closed; }
    assert.equal(path.dirname(root), os.tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  let relay = "";
  for await (const line of lines) {
    const ready = /^RABILINK_RELAY_READY:(.+)$/.exec(line);
    if (ready) { relay = `http://127.0.0.1:${JSON.parse(ready[1]!).port}`; break; }
  }
  assert.ok(relay);
  const send = (base: string, pathname: string, body?: object, headers: Record<string, string> = {}) => fetch(base + pathname, {
    method: body ? "POST" : "GET", headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined
  });
  async function host(name: string, deviceId = name, token = "", deviceGuid = randomUUID(), speech = false, advertiseLan = true) {
    const file = path.join(root, name, "host-account.json");
    const legacy = { enabled: true, url: relay, token, deviceId, claimWaitMs: 10, replyIdleTimeoutMs: 25000, speechServiceUrl: "" };
    const generation = randomUUID();
    const runtime = new RabiLinkRelayRuntime({ onEvent: (eventType, data) => {
      if (eventType === "account_peer_revoked" && typeof data.peerId === "string" && typeof data.revokedAt === "number") tunnel.invalidatePeer(data.peerId, data.revokedAt);
    } });
    let calls = 0;
    let url = "";
    let loseResponse: "login" | "confirm" | undefined;
    let suspendRecovery = false;
    const observedLogins: string[] = [];
    const config = () => ({ relay: legacy, deviceName: name, deviceGuid });
    const unusedHttp = { readJson: async () => { throw new Error("The restored fixture uses only the startup recovery entry."); }, json: () => {} };
    const account = new RabiLinkHostAccount({ file, config, changed: async () => { await start(); },
      request: async (input, init) => {
        const action = new URL(String(input)).pathname.split("/").at(-1);
        if (action === "recover" && suspendRecovery) throw new Error("Fixture connection is offline");
        if (action === "login") observedLogins.push(JSON.parse(String(init?.body)).requestId);
        const response = await fetch(input, init);
        if (loseResponse && action === loseResponse) {
          loseResponse = undefined;
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          throw new Error("Fixture dropped the response after the Relay committed it");
        }
        return response;
      },
      readJson: async request => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); },
      json: (response, status, payload) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload)) });
    const tunnel = new RabiLinkAccountTunnel({ dataDir: path.join(root, name), generation, relay: () => account.relay(),
      discover: () => discoverRabiPeers({ ...account.relay()!, deviceGuid }), services: () => ({ manager: { baseUrl: url } }), onStatus: () => {} });
    const server = http.createServer(async (request, response) => {
      if (await account.handle(request, new URL(request.url || "/", url), response, false)) return;
      if (request.url === ACCOUNT_OFFER_PATH) {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const result = await tunnel.receive(request, JSON.parse(Buffer.concat(chunks).toString()));
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch { response.writeHead(403).end(); }
      } else if (request.url === "/fixture/live") {
        const target = validateInternalManagerHop(request, { generation });
        if (!target || target.kind !== "peer") { response.writeHead(403).end(); return; }
        response.writeHead(200, { "content-type": "text/event-stream" }).write("data: first\n\n");
        const delayed = setTimeout(() => response.write("data: second\n\n"), 60);
        response.once("close", () => clearTimeout(delayed));
      } else if (request.url?.startsWith("/meta")) {
        const target = validateInternalManagerHop(request, { generation });
        if (!target) { response.writeHead(403).end(); return; }
        calls++;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, source: target.deviceId, calls }));
      } else if (speech && request.url === "/api/speech/events") {
        response.writeHead(200, { "content-type": "text/event-stream" }).write("event: ready\ndata: {}\n\n");
      } else if (speech && request.url === "/v1/capabilities") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ providers: { asr: { fixture: { enabled: true } } } }));
      } else if (speech && request.url === "/v1/audio/speech") {
        assert.equal(request.headers["x-rabilink-tunnel-local"], "relay-speech");
        response.writeHead(200, { "content-type": "audio/wav" }).end("fixture-wave");
      } else response.writeHead(404).end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/fixture/socket") {
        if (validateInternalManagerHop(request, { generation })?.kind !== "peer") { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, connection => connection.on("message", (bytes, binary) => connection.send(bytes, { binary })));
      } else if (request.url === "/fixture/connect") {
        void tunnel.runtime()!.session("pc-b").then(session => proxyTunnelUpgrade(session, "manager", "/fixture/socket", request, socket, head)).catch(() => socket.destroy());
      } else if (!tunnel.upgrade(request, socket, head)) socket.destroy();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const endpoint = server.address(); assert.ok(endpoint && typeof endpoint !== "string");
    url = `http://127.0.0.1:${endpoint.port}`;
    async function start() {
      tunnel.runtime();
      const config = account.relay() ?? legacy;
      if (!config.token) { await runtime.stop(); return; }
      await runtime.sync({ ...config, deviceGuid, deviceName: name, localWebguiUrl: url, localSpeechUrl: speech ? url : "", applicationGenerationId: generation,
        accountTunnel: Boolean(account.relay()), peerUrls: account.relay() && advertiseLan ? [url] : [],
        rabiPcVersion: token ? "0.15.30" : "0.16.0" });
    }
    stop.push(async () => { await tunnel.stop(); await runtime.stop(); sockets.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const sign = (action: string, credentials?: { username: string; password: string }) => send(url, "/api/rabilink/host-account", { action, ...credentials });
    return { account, sign, url, file, start, calls: () => calls, legacy, tunnel, observedLogins,
      dropNext(action: "login" | "confirm") { loseResponse = action; suspendRecovery = true; }, resume() { suspendRecovery = false; },
      restoredAccount: () => new RabiLinkHostAccount({ file, config, changed: async () => {}, ...unusedHttp }) };
  }
  const alpha = { username: "fixture-alpha", password: randomUUID() }, beta = { username: "fixture-beta", password: randomUUID() };
  const first = await host("pc-a"), second = await host("pc-b"), other = await host("other-b", "pc-b"), stranger = await host("other-c", "pc-c");
  assert.equal((await first.sign("register", alpha)).status, 200);
  assert.equal((await second.sign("login", alpha)).status, 200);
  assert.equal((await other.sign("register", beta)).status, 200);
  assert.equal((await stranger.sign("login", beta)).status, 200);
  assert.equal((await first.sign("login", { ...alpha, password: "wrong-password" })).status, 401);
  const privateState = readFileSync(second.file, "utf8");
  assert.ok(!privateState.includes(alpha.password));
  assert.notEqual(first.account.relay()?.token, second.account.relay()?.token);
  const session = await send(second.url, "/api/rabilink/host-account");
  assert.equal((await session.json()).account.username, alpha.username);
  const spoof = await send(second.url, "/api/rabilink/host-account", undefined, { "sec-fetch-site": "cross-site" });
  assert.equal(spoof.status, 403);

  const consoleSession = await send(relay, "/manage/api/login", alpha);
  const cookie = consoleSession.headers.get("set-cookie")!.split(";")[0]!;
  const created = await send(relay, "/manage/api/apps", { name: "Existing integration" }, { cookie });
  const { app } = await created.json();
  assert.ok(app.token);
  const legacy = await host("pc-legacy", "pc-legacy", app.token, randomUUID(), true);
  await legacy.start();
  const firstRelay = first.account.relay()!;
  const waitForDirectory = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const listing = await readRabiLinkHome(firstRelay);
      if (listing.devices.some(row => row.name === "pc-legacy" && row.online && row.capabilities.includes("speech")) && listing.devices.some(row => row.name === "pc-b" && row.online)) return listing.devices;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("both workers must become visible");
  };
  const devices = await waitForDirectory();
  assert.deepEqual(devices.map(item => item.name).sort(), ["pc-a", "pc-b", "pc-legacy"]);
  const legacyId = devices.find(item => item.name === "pc-legacy")!.id;
  const oldMeta = await fetchAccountHost(firstRelay, legacyId, "manager", "/meta", {}, () => {});
  assert.equal(oldMeta.status, 200);
  assert.equal((await oldMeta.json()).name, "pc-legacy");
  const voice = await fetchAccountHost(firstRelay, legacyId, "speech", "/v1/audio/speech", { method: "POST", body: "{}" }, () => {});
  const voiceBody = await voice.text();
  assert.equal(voice.status, 200, `${voiceBody} ${JSON.stringify((await readRabiLinkHome(firstRelay)).devices.find(item => item.id === legacyId))}`);
  assert.equal(voiceBody, "fixture-wave");
  const blockedVoice = await fetchAccountHost(stranger.account.relay()!, legacyId, "speech", "/v1/audio/speech", { method: "POST", body: "{}" }, () => {});
  assert.equal(blockedVoice.status, 404);
  const currentMeta = await fetchAccountHost(firstRelay, "pc-b", "manager", "/meta", {}, () => {});
  assert.deepEqual(await currentMeta.json(), { name: "pc-b", source: "pc-a", calls: 1 });
  const native = first.tunnel.runtime()!;
  const live = await native.fetch("pc-b", "manager", "/fixture/live");
  assert.equal(live.status, 200);
  const reader = live.body!.getReader();
  const firstFrame = await reader.read();
  assert.equal(Buffer.from(firstFrame.value!).toString(), "data: first\n\n");
  const secondFrame = await reader.read();
  assert.equal(Buffer.from(secondFrame.value!).toString(), "data: second\n\n");
  await reader.cancel();
  assert.equal((await native.directory()).peers.find(peer => peer.deviceId === "pc-b")?.transport, "lan");
  const p2pOnly = await host("pc-without-lan", "pc-without-lan", "", randomUUID(), false, false);
  assert.equal((await p2pOnly.sign("login", alpha)).status, 200);
  let p2pPeer;
  for (let attempt = 0; attempt < 25 && !p2pPeer; attempt++) {
    p2pPeer = (await native.directory(true)).peers.find(peer => peer.deviceId === "pc-without-lan" && peer.online);
    if (!p2pPeer) await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(p2pPeer);
  const remoteP2P = await native.fetch("pc-without-lan", "manager", "/meta");
  assert.equal((await remoteP2P.json()).name, "pc-without-lan");
  assert.equal((await native.directory()).peers.find(peer => peer.deviceId === "pc-without-lan")?.transport, "p2p");
  const socket = new WebSocket(first.url.replace("http:", "ws:") + "/fixture/connect");
  await once(socket, "open");
  socket.send("live echo");
  const [echo] = await once(socket, "message");
  assert.equal(echo.toString(), "live echo");
  assert.equal(other.calls(), 0);
  const isolated = await send(relay, "/api/rabilink/device/api", { targetDeviceId: "pc-c", request: { method: "GET", path: "/meta" } }, { "x-rabilink-token": firstRelay.token });
  assert.equal(isolated.status, 404);
  const impersonatedSignal = await send(relay, "/api/rabilink/peer/account-signal", { targetDeviceId: "pc-a", offer: { kind: "relay", source: "pc-c", room: randomUUID() } }, { "x-rabilink-token": firstRelay.token });
  assert.equal(impersonatedSignal.status, 403);
  const consoleState = await send(relay, "/manage/api/state?integration=1", undefined, { cookie });
  assert.deepEqual((await consoleState.json()).apps.map((item: { id: string }) => item.id), [app.id]);
  await legacy.account.tryMigrate();
  assert.equal(legacy.account.status().account, null);
  assert.equal((await legacy.sign("login", beta)).status, 409);

  const pairingTicket = `rpt_${randomBytes(32).toString("base64url")}`;
  const ticket = await send(relay, `/manage/api/apps/${app.id}/pc-pairing-tickets`, { id: randomUUID(), ticketHash: pairingHash(pairingTicket) }, { cookie, origin: relay, "x-rabilink-pairing-write": "1" });
  assert.equal(ticket.status, 200);
  const pairedGuid = randomUUID(), pairedToken = `rbw_${randomBytes(32).toString("base64url")}`;
  const paired = await send(relay, "/api/rabilink/pc-pairings", { id: randomUUID(), deviceId: "pc-paired", deviceGuid: pairedGuid, deviceName: "Paired PC",
    proofHash: pairingHash(randomUUID()), credentialHash: pairingHash(pairedToken) }, { authorization: `Bearer ${pairingTicket}` });
  assert.equal(paired.status, 200);
  const pairedHost = await host("pc-paired", "pc-paired", pairedToken, pairedGuid);
  await pairedHost.account.tryMigrate();
  assert.equal(pairedHost.account.status().account?.username, alpha.username);
  const replay = await send(relay, "/api/rabilink/host-account/migrate", { deviceId: "pc-paired", deviceGuid: randomUUID(), deviceName: "Wrong identity" }, { "x-rabilink-token": pairedToken });
  assert.equal(replay.status, 403);

  const closed = once(socket, "close");
  const revoked = await send(relay, "/api/rabilink/host-account/logout", {}, { "x-rabilink-token": JSON.parse(privateState).session.token });
  assert.equal(revoked.status, 200);
  await closed;
  assert.equal((await second.sign("logout")).status, 200);
  assert.ok(!(await readRabiLinkHome(firstRelay)).devices.some(item => item.name === "pc-b"));
  assert.equal((await send(relay, "/api/rabilink/peers", undefined, { "x-rabilink-token": JSON.parse(privateState).session.token })).status, 401);

  const rekeyed = await host("pc-recovery");
  assert.equal((await rekeyed.sign("login", alpha)).status, 200);
  const originalToken = rekeyed.account.relay()!.token;
  const directoryStatus = async (token: string) => (await send(relay, "/api/rabilink/peers", undefined, { "x-rabilink-token": token })).status;
  rekeyed.dropNext("login");
  assert.equal((await rekeyed.sign("login", alpha)).status, 502);
  const staged = JSON.parse(readFileSync(rekeyed.file, "utf8"));
  assert.ok(staged.rotation?.requestId);
  assert.equal(await directoryStatus(originalToken), 200);
  assert.equal(await directoryStatus(staged.rotation.token), 401);
  const mismatched = await send(relay, "/api/rabilink/host-account/recover", { requestId: staged.rotation.requestId, deviceId: "another-pc", deviceGuid: staged.rotation.deviceGuid }, { "x-rabilink-token": staged.rotation.token });
  assert.equal(mismatched.status, 404);
  rekeyed.resume();
  await rekeyed.account.tryRecover();
  assert.equal(rekeyed.account.relay()?.token, staged.rotation.token);
  assert.equal(await directoryStatus(originalToken), 401);
  assert.equal(await directoryStatus(staged.rotation.token), 200);
  assert.equal(rekeyed.observedLogins.length, 2);

  rekeyed.dropNext("confirm");
  assert.equal((await rekeyed.sign("login", alpha)).status, 502);
  const confirmed = JSON.parse(readFileSync(rekeyed.file, "utf8"));
  assert.notEqual(confirmed.rotation.requestId, staged.rotation.requestId);
  assert.equal(await directoryStatus(staged.rotation.token), 401);
  assert.equal(await directoryStatus(confirmed.rotation.token), 200);
  const restored = rekeyed.restoredAccount();
  await restored.tryRecover();
  assert.equal(restored.relay()?.token, confirmed.rotation.token);
  assert.equal(rekeyed.observedLogins.length, 3);
  assert.equal(JSON.parse(readFileSync(rekeyed.file, "utf8")).rotation, undefined);
});
