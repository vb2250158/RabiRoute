import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "../personaSync.js";
import { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import { PersonaSyncLanServer, type PersonaSyncLanStatus } from "./personaSyncLanServer.js";

test("dedicated persona sync LAN listener exposes only the merge data plane", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-lan-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"));
  const coordinator = new PersonaSyncCoordinator(service, path.join(root, "state"), () => ({
    url: "http://127.0.0.1:1",
    token: "shared-app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
  const statuses: PersonaSyncLanStatus[] = [];
  const server = new PersonaSyncLanServer({
    service,
    coordinator,
    token: () => "shared-app-token",
    relay: () => ({ url: "http://127.0.0.1:1", token: "shared-app-token", deviceId: "pc-a", deviceGuid: "guid-a" })
  }, {
    host: "127.0.0.1",
    port: 0,
    addresses: () => ["127.0.0.1"],
    onStatus: status => statuses.push(status)
  });
  t.after(() => server.stop());

  await server.start();
  const status = server.status();
  assert.equal(status.state, "listening");
  assert.equal(status.urls.length, 1);
  assert.match(status.urls[0], /^http:\/\/127\.0\.0\.1:\d+$/);

  const manifest = await fetch(`${status.urls[0]}/api/persona-sync/manifest`, {
    headers: { "x-rabilink-token": "shared-app-token" }
  });
  assert.equal(manifest.status, 200);
  const body = await manifest.json() as { data: { roles: Array<{ roleId: string }> } };
  assert.deepEqual(body.data.roles.map(role => role.roleId), ["Rabi"]);

  const orchestration = await fetch(`${status.urls[0]}/api/persona-sync/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rabilink-token": "shared-app-token" },
    body: JSON.stringify({ peerId: "pc-b" })
  });
  assert.equal(orchestration.status, 404);
  const conflictControl = await fetch(`${status.urls[0]}/api/persona-sync/conflicts`, {
    headers: { "x-rabilink-token": "shared-app-token" }
  });
  assert.equal(conflictControl.status, 404);
  assert.equal(statuses.some(item => item.state === "starting"), true);
  assert.equal(statuses.some(item => item.state === "listening"), true);
});


test("stopping an in-flight LAN listener cannot revive it after a new generation starts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-lan-generation-"));
  const rolesRoot = path.join(root, "roles");
  fs.mkdirSync(rolesRoot, { recursive: true });
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"));
  const coordinator = new PersonaSyncCoordinator(service, path.join(root, "state"), () => ({
    url: "http://127.0.0.1:1", token: "token", deviceId: "pc-a", deviceGuid: "guid-a"
  }));
  const server = new PersonaSyncLanServer({
    service, coordinator, token: () => "token",
    relay: () => ({ url: "http://127.0.0.1:1", token: "token", deviceId: "pc-a", deviceGuid: "guid-a" })
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  t.after(() => server.stop());

  const staleStart = server.start();
  await server.stop();
  await staleStart;
  assert.equal(server.status().state, "disabled");

  await server.start();
  assert.equal(server.status().state, "listening");
});


test("stop waits for active LAN connections, is idempotent, and permits restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-lan-stop-"));
  const rolesRoot = path.join(root, "roles");
  fs.mkdirSync(rolesRoot, { recursive: true });
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"));
  const coordinator = new PersonaSyncCoordinator(service, path.join(root, "state"), () => ({
    url: "http://127.0.0.1:1", token: "token", deviceId: "pc-a", deviceGuid: "guid-a"
  }));
  const server = new PersonaSyncLanServer({
    service, coordinator, token: () => "token",
    relay: () => ({ url: "http://127.0.0.1:1", token: "token", deviceId: "pc-a", deviceGuid: "guid-a" })
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  t.after(() => server.stop());

  await server.start();
  const port = server.status().port;
  assert.ok(port);
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    "POST /api/persona-sync/merge HTTP/1.1",
    "Host: 127.0.0.1",
    "Content-Type: application/json",
    "X-RabiLink-Token: token",
    "Content-Length: 100",
    "",
    "{"
  ].join("\r\n"));
  await new Promise<void>(resolve => setImmediate(resolve));

  let stopped = false;
  const firstStop = server.stop();
  const secondStop = server.stop();
  assert.strictEqual(firstStop, secondStop);
  void firstStop.then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);

  socket.destroy();
  await firstStop;
  assert.equal(stopped, true);
  assert.equal(server.status().state, "disabled");

  await server.start();
  assert.equal(server.status().state, "listening");
  await server.stop();
});
