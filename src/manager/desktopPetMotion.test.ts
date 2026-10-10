import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleDesktopPetMotion, parseDesktopPetMotion } from "./desktopPetMotion.js";
import { authorizeAgentApiOperation as authorizeAgentApiRequest } from "./agentApiPolicy.js";
import { normalizeDesktopSettings } from "../shared/desktopSettingsContract.js";

test("motion validates coordinates, target fields and reviewed Agent boundary", () => {
  for (const target of [{ kind: "position", x: NaN, y: 1 }, { kind: "position", x: 0, y: 0, command: "shell" },
    { kind: "active-window", corner: "unknown" }, { kind: "active-window", corner: "top-left", screenName: "other" }]) {
    assert.throws(() => parseDesktopPetMotion({ requestId: "sample-motion-1", target }));
  }
  assert.equal(parseDesktopPetMotion({ requestId: "sample-motion-1", target: { kind: "position", x: -1920, y: 100 } }).mode, "auto");
  assert.equal(authorizeAgentApiRequest("POST", "/api/desktop-pet/roles/sample/motion").allowed, true);
  assert.equal(authorizeAgentApiRequest("POST", "/api/desktop-pet/roles/sample/motion/runtime").allowed, false);
  assert.equal(authorizeAgentApiRequest("GET", "/api/desktop-pet/roles/sample/motion/runtime").allowed, false);
});

test("motion runs once, verifies renderer claim and arrival, retains interruptions", async t => {
  let settingsValue = normalizeDesktopSettings({ pets: { sample: { enabled: true, packId: "sample-pack" } } });
  const settings = { read: () => settingsValue, write: (value: unknown) => normalizeDesktopSettings(value) };
  const events: string[] = [];
  const server = http.createServer((req, res) => {
    if (!handleDesktopPetMotion(req, new URL(req.url!, "http://localhost"), res, settings, event => events.push(event))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/desktop-pet/roles/sample/motion`;
  const requestId = "sample-motion-1";
  const request = { requestId, target: { kind: "position", x: 100, y: 200 } };
  const post = (url: string, value: unknown, id = requestId) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify(value) });
  assert.equal((await post(base, request, "wrong-key")).status, 400);
  assert.equal((await post(base, request)).status, 202);
  assert.equal((await post(base, request)).status, 200);
  assert.equal(events.filter(e => e === "desktop_pet_motion_requested").length, 1);
  assert.equal((await post(base, { ...request, target: { kind: "position", x: 101, y: 200 } })).status, 409);
  assert.equal((await post(base, { ...request, requestId: "sample-motion-2" }, "sample-motion-2")).status, 409);
  const claim = (await (await post(`${base}/runtime`, {})).json()).data;
  assert.equal(claim.status, "running");
  assert.equal((await (await post(`${base}/runtime`, {})).json()).data, null);
  const publicReceipt = (await (await fetch(`${base}/${requestId}`)).json()).data;
  assert.equal(publicReceipt.token, undefined);
  const realNow = Date.now;
  let clock = realNow();
  t.mock.method(Date, "now", () => clock);
  for (let index = 0; index < 10; index++) {
    clock += 5000;
    assert.equal((await post(`${base}/runtime`, { requestId, token: claim.token, status: "running",
      position: { x: index * 10, y: 200 } })).status, 200);
    assert.equal((await (await fetch(`${base}/${requestId}`)).json()).data.status, "running");
  }
  assert.equal(events.filter(e => e === "desktop_pet_motion_result").length, 0);
  assert.equal((await post(`${base}/runtime`, { requestId, token: "wrong", status: "succeeded", position: { x: 100, y: 200 } })).status, 409);
  const result = { requestId, token: claim.token, status: "succeeded", position: { x: 100, y: 200 }, destination: { x: 100, y: 200 }, travelKind: "move" };
  assert.equal((await post(`${base}/runtime`, { ...result, position: { x: 1, y: 1 } })).status, 400);
  assert.equal((await post(`${base}/runtime`, result)).status, 200);
  assert.equal((await post(`${base}/runtime`, result)).status, 200);
  assert.equal(events.filter(e => e === "desktop_pet_motion_result").length, 1);
  assert.equal((await (await post(base, request)).json()).data.status, "succeeded");
  assert.equal((await (await fetch(`${base}/${requestId}`)).json()).data.position.x, 100);
  const stalledId = "sample-motion-stalled";
  assert.equal((await post(base, { ...request, requestId: stalledId }, stalledId)).status, 202);
  await post(`${base}/runtime`, {});
  clock += 31000;
  assert.equal((await (await fetch(`${base}/${stalledId}`)).json()).data.status, "uncertain");
  settingsValue = normalizeDesktopSettings({ pets: { sample: { enabled: true, packId: "sample-pack", locked: true } } });
  assert.equal((await post(base, { ...request, requestId: "sample-motion-3" }, "sample-motion-3")).status, 409);
});
