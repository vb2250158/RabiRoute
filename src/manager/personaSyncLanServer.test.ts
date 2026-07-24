import assert from "node:assert/strict";
import fs from "node:fs";
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
