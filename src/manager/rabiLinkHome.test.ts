import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { RabiApiContext } from "../plugins/io.rabiroute.manager.route-control/src/manager/rabiApi.js";
import { createRabiControlOperations } from "../plugins/io.rabiroute.manager.route-control/src/manager/rabiApiOperations.js";
import type { DeviceComputerPort } from "../plugins/io.rabiroute.manager.route-control/src/manager/deviceControlOperations.js";
import { createLanAgentComputerOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { readRabiLinkHome, RabiLinkHomeError } from "./rabiLinkHome.js";
import type { RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { createUnifiedSearchOperation } from "./unifiedSearchOperations.js";
import { createApiDiscoveryOperations } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js";


test("route-control installs link home from the same executable operation definitions", () => {
  const plugin = fs.readFileSync(new URL("../plugins/io.rabiroute.manager.route-control/manager.mjs", import.meta.url), "utf8");
  assert.match(plugin, /host\.manager\.route-control@2/);
  assert.match(plugin, /await shared\.prepareModules\(hostModules\)/);
  assert.match(plugin, /createImplementation\(shared\)\.createOwnedRuntime\(shared\)/);
  assert.match(plugin, /await runtime\.managerPluginRoutes\.registerOperationsAsync\(context\.identity\.instanceId, runtime\.createRabiControlOperations\(\), context\.lifecycle\.signal\)/);
  const owned = fs.readFileSync(new URL("../plugins/io.rabiroute.manager.route-control/hostRuntime.mjs", import.meta.url), "utf8");
  assert.match(owned, /createRabiControlOperations:\s*\(\) => createRabiControlOperations\(/);
  assert.doesNotMatch(plugin, /handleRabiApi|pathPrefix:|routeId:/);
});

async function server(t: TestContext, handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
function config(url: string): RabiLinkRelayGlobalConfig {
  return { enabled: true, url, token: "test-only-app-token", deviceId: "test-device", claimWaitMs: 1000, replyIdleTimeoutMs: 1000, speechServiceUrl: "" };
}
const peer = { id: "device-a", guid: "guid-a", name: "Device A", online: true, capabilities: ["peer-rpc-v1"] };
function send(response: http.ServerResponse, body: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
async function manager(t: TestContext, read: () => RabiLinkRelayGlobalConfig, readGuid = () => "local-guid",
  fixtureRoot?: string, computer?: DeviceComputerPort): Promise<string> {
  const rootDir = fixtureRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-home-"));
  if (!fixtureRoot) t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const context = { rootDir, applicationGenerationId: "test-generation", managerInstanceId: "test-manager", version: () => "0.3.19", globalConfig: { read: () => ({ rabiLinkRelay: read(), rabiGuid: readGuid() }) } } as unknown as RabiApiContext;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("route-control-home-test", [
    ...createRabiControlOperations(context, undefined, computer),
    ...(computer ? createApiDiscoveryOperations(registry) : []),
    createUnifiedSearchOperation(registry, {
      roles: () => [{ roleId: "fixture-role" }], roleDirectory: () => rootDir,
      queryHistory: async () => [], entities: async () => { throw new Error("entity source not requested"); }
    })
  ]);
  t.after(() => registration.dispose());
  return server(t, (request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url || "/", "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
}

test("link home uses only saved app header and returns a positive allowlist", async t => {
  let calls = 0;
  const upstream = await server(t, (request, response) => {
    calls++;
    assert.equal(request.url, "/api/rabilink/peers?includePortable=phone");
    assert.equal(request.headers["x-rabilink-token"], "test-only-app-token");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    send(response, { code: 0, ok: true, appId: "private-app", peers: [{ ...peer, token: "private", tokenPreview: "private", appTokenPreview: "private", ownerAccountId: "private", notes: "private", deviceBindings: ["private"], peerUrls: ["http://private.invalid"] }] });
  });
  const base = await manager(t, () => config(upstream));
  const response = await fetch(`${base}/api/rabi/link-home`, { headers: { cookie: "private-cookie", authorization: "Bearer private-caller", "x-rabilink-token": "caller-token" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 0);
  assert.match(body.data.devices[0].labelRevision, /^[a-f0-9]{64}$/);
  const { labelRevision: _revision, ...publicDevice } = body.data.devices[0];
  assert.deepEqual(publicDevice, { ...peer, deviceKind: "unknown", rabiPcVersion: null, isLocal: false });
  assert.ok(Number.isFinite(Date.parse(body.data.checkedAt)));
  assert.doesNotMatch(JSON.stringify(body), /private|token|cookie|peerUrls|appId/);
  assert.equal(calls, 1);
  const invalid = await fetch(`${base}/api/rabi/link-home?url=http://example.invalid&token=caller`);
  assert.equal(invalid.status, 400);
  assert.equal(calls, 1);
});

test("authorized phone labels survive restart, stay scoped to their app, and are searchable from a role", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-label-fixture-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let appId: string | undefined;
  let token = "test-only-app-token";
  let revoked = false;
  const upstream = await server(t, (request, response) => {
    if (revoked) { response.writeHead(401); response.end(); return; }
    assert.equal(request.headers["x-rabilink-token"], token);
    send(response, { code: 0, ok: true, appId, peers: [
    { ...peer, guid: "", deviceKind: "phone", name: "Workshop Android Phone" },
    { ...peer, id: "device-b", guid: "guid-b", deviceKind: "pc", name: "Another PC" }
    ] });
  });
  const start = () => manager(t, () => ({ ...config(upstream), token }), () => "local-guid", rootDir);
  const getDevice = async (base: string) => (await (await fetch(base + "/api/rabi/link-home/devices/device-a")).json()).data;
  const change = (base: string, expectedRevision: string, alias: string, tags: string[], guid = "") =>
    fetch(base + "/api/rabi/link-home/devices/device-a/labels", { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias, tags, guid, expectedRevision }) });
  const search = async (base: string, q: string) => (await (await fetch(base + "/api/search?" + new URLSearchParams({ q, agent: "fixture-role", scope: "devices", match: "all" }))).json()).data;
  const base = await start(), previous = await getDevice(base);
  assert.equal((await change(base, previous.labelRevision, "蓝鲸机", [], "wrong-guid")).status, 409);
  const saved = await change(base, previous.labelRevision, " 蓝鲸机 ", ["开发", "QA", "qa", ""]);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await change(base, previous.labelRevision, "stale", [])).status, 409);
  const labelDirectory = path.join(rootDir, "data", "rabilink-device-labels");
  const savedFiles = fs.readdirSync(labelDirectory);
  assert.equal(savedFiles.length, 1);
  appId = "fixture-app-a";
  const reopened = await start();
  const labeled = await getDevice(reopened);
  assert.deepEqual(labeled.labels, { alias: "蓝鲸机", tags: ["开发", "QA"] });
  assert.notEqual(labeled.labelRevision, (await saved.json()).data.labelRevision);
  assert.deepEqual(fs.readdirSync(labelDirectory), savedFiles);
  const concurrent = await Promise.all([change(reopened, labeled.labelRevision, "first", []), change(reopened, labeled.labelRevision, "second", [])]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const winner = await getDevice(reopened);
  assert.equal((await change(reopened, winner.labelRevision, "蓝鲸机", ["开发", "QA"])).status, 200);
  assert.deepEqual(fs.readdirSync(labelDirectory), savedFiles);
  for (const query of ["蓝鲸", "Workshop Android Phone", "开发", "蓝鲸机 QA"]) {
    const data = await search(reopened, query);
    assert.equal(data.items.length, 1, query);
    assert.equal(data.items[0].label, "蓝鲸机");
    assert.equal(data.items[0].kind, "device");
    assert.equal(data.items[0].handle.deviceId, "device-a");
    assert.equal(data.items[0].detailUrl, "/api/rabi/link-home/devices/device-a");
    assert.equal(data.coverage.state, "complete");
  }
  assert.deepEqual((await search(reopened, "无关名字")).items, []);
  revoked = true;
  assert.equal((await change(reopened, labeled.labelRevision, "revoked", [])).status, 502);
  revoked = false;
  token = "second-test-only-app-token";
  assert.equal((await getDevice(reopened)).labels, undefined);
  assert.equal((await change(reopened, labeled.labelRevision, "wrong token", [])).status, 409);
  appId = "fixture-app-b";
  assert.equal((await getDevice(reopened)).labels, undefined);
  assert.equal((await change(reopened, labeled.labelRevision, "wrong app", [])).status, 409);
  token = "test-only-app-token";
  appId = "fixture-app-a";
  assert.equal((await change(reopened, labeled.labelRevision, "", [])).status, 200);
  assert.deepEqual((await search(reopened, "蓝鲸")).items, []);
  assert.deepEqual(fs.readdirSync(labelDirectory), savedFiles);
  appId = undefined;
  assert.equal((await getDevice(reopened)).labels, undefined);
  assert.equal((await search(reopened, "Workshop Android Phone")).items[0].label, "Workshop Android Phone");
});

test("home versions come from each PC advertisement and local identity requires both saved identifiers", async t => {
  const peers = [
    { ...peer, id: "test-device", guid: "local-guid", name: "Renamed local PC", deviceKind: "pc", capabilities: ["webgui", "rabi-pc-version-0.3.18"] },
    { ...peer, id: "remote", guid: "remote-guid", deviceKind: "pc", capabilities: ["webgui", "rabi-pc-version-0.3.17"] },
    { ...peer, id: "legacy", deviceKind: "pc", rabiPcVersion: "99.9.9" },
    { ...peer, id: "test-device", guid: "other-guid", deviceKind: "pc" },
    { ...peer, id: "other-device", guid: "local-guid", deviceKind: "pc" },
    { ...peer, id: "phone", deviceKind: "phone", capabilities: ["rabi-pc-version-0.3.17"] }
  ];
  const upstream = await server(t, (_request, response) => send(response, { code: 0, ok: true, peers }));
  const base = await manager(t, () => config(upstream));
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.devices.map((item: { isLocal: boolean; rabiPcVersion: string | null }) => [item.isLocal, item.rabiPcVersion]), [
    [true, "0.3.19"], [false, "0.3.17"], [false, null], [false, null], [false, null], [false, null]
  ]);
  assert.deepEqual(data.devices[1].capabilities, ["webgui"]);
  assert.equal(data.devices[5].deviceKind, "phone");
});

test("phone files use only the saved Relay credential and forward the original target and transfer identity", async t => {
  let calls = 0;
  const upstream = await server(t, async (request, response) => {
    calls++;
    assert.equal(request.url, "/api/rabilink/mobile/files");
    assert.equal(request.headers["x-rabilink-token"], "test-only-app-token");
    assert.equal(request.headers.authorization, undefined);
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    assert.deepEqual(JSON.parse(body), { action: "upload.status", targetGuid: "", targetId: "rabi-phone-fixture",
      uploadId: "1cbfd2c8-a532-4ee3-8b25-49321de09675" });
    send(response, { code: 0, data: { state: "receiving", offset: 65536 } });
  });
  const base = await manager(t, () => config(upstream));
  const endpoint = base + "/api/rabi/link-home/devices/rabi-phone-fixture/files";
  const post = (body: unknown) => fetch(endpoint, { method: "POST", headers: {
    "content-type": "application/json", authorization: "Bearer caller", "x-rabilink-token": "caller"
  }, body: JSON.stringify(body) });
  assert.equal((await post({ action: "shell.exec", targetGuid: "" })).status, 400);
  const response = await post({ action: "upload.status", targetGuid: "", uploadId: "1cbfd2c8-a532-4ee3-8b25-49321de09675" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: 0, data: { state: "receiving", offset: 65536 } });
  assert.equal(calls, 1);
});

test("unsafe and conflicting version metadata does not fail the device directory", async t => {
  const upstream = await server(t, (_request, response) => send(response, { code: 0, ok: true, peers: [
    { ...peer, deviceKind: "pc", capabilities: ["webgui", "rabi-pc-version-0.3.19", "rabi-pc-version-0.3.18"] },
    { ...peer, id: "unsafe", deviceKind: "pc", capabilities: ["rabi-pc-version-" + "<script>".repeat(100)] }
  ] }));
  const result = await readRabiLinkHome(config(upstream));
  assert.equal(result.devices.length, 2);
  assert.deepEqual(result.devices.map(item => item.rabiPcVersion), [null, null]);
  assert.deepEqual(result.devices.map(item => item.capabilities), [["webgui"], []]);
});

test("phone location forwards one authorized fix and rejects fields for other actions", async t => {
  const position = { state: "ok", coordinateSystem: "WGS84", latitude: 45, longitude: 12, placeState: "not-configured" };
  let calls = 0;
  const upstream = await server(t, async (request, response) => {
    calls++;
    assert.equal(request.url, "/api/rabilink/mobile/location");
    assert.equal(request.headers["x-rabilink-token"], "test-only-app-token");
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    assert.deepEqual(JSON.parse(body), { targetId: "rabi-phone-fixture", targetGuid: "", action: "location.read", includePlace: true });
    send(response, { code: 0, data: position });
  });
  const base = await manager(t, () => config(upstream));
  const url = base + "/api/rabi/link-home/devices/rabi-phone-fixture/location";
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ targetGuid: "", action: "location.read", enabled: true })).status, 400);
  assert.equal((await post({ targetGuid: "", action: "location.settings.update" })).status, 400);
  assert.equal((await post({ targetGuid: "", action: "upload.status" })).status, 400);
  const response = await post({ targetGuid: "", action: "location.read", includePlace: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: 0, data: position });
  assert.equal(calls, 1);
});

test("unified device control keeps the selected owner, action, and receipt identity", async t => {
  const phoneId = "legacy-fixture-route";
  const phoneWorkerId = "rabi-phone-fixture";
  const status = { state: "sharing", layoutRevision: "projection-1",
    activity: {
      observations: [{ id: "capture-view", label: "查看会话" }],
      operation: { requestId: "original-request", label: "操作会话" },
      pointer: { requestId: "original-request", label: "操作会话", kind: "swipe", x: .3, y: .5, startX: .2, startY: .5, remainingMs: 350 }
    } };
  const upstream = await server(t, async (request, response) => {
    if (request.method === "GET") {
      send(response, { code: 0, ok: true, appId: "fixture", peers: [{ id: phoneId, guid: "", name: "Phone",
        deviceKind: "phone", online: true, capabilities: ["phone-location-v1", "phone-screen-v1"] }] });
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    if (request.url === "/api/rabilink/mobile/screen") {
      const bounds = { x: 0, y: 0, width: 1080, height: 1688 };
      const source = { instanceId: phoneWorkerId, kind: "desktop", coordinateSpace: "capture", width: 32, height: 50, bounds, layoutRevision: "projection-1", frameId: "frame-1" };
      const image = { mimeType: "image/png", width: 32, height: 50, bounds, capturedAt: "2026-11-27T12:00:00.000Z", source, data: "aW1hZ2U=" };
      const input = JSON.parse(raw);
      if (input.action === "screen.status") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "screen.status" });
        send(response, { code: 0, data: status });
      } else if (input.action === "input.cancel") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "input.cancel", requestId: "original-request" });
        send(response, { code: 0, data: { state: "cancel-requested", requestId: "original-request" } });
      } else if (input.action === "screen.wait") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "screen.wait", waitMs: 250, source, observerLabel: "测试会话" });
        send(response, { code: 0, data: { state: "changed", capture: { ...image, source: { ...source, frameId: "frame-2" } } } });
      } else if (input.action === "input.perform") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "input.perform", requestId: "original-request",
          source, actions: [{ type: "click", x: 10, y: 14 }], captureAfter: { waitMs: 800 }, observerLabel: "测试会话" });
        send(response, { code: 0, data: { state: "completed", requestId: "original-request", completedActions: 1,
          capture: { ...image, state: "captured", frameId: "touch-frame" } } });
      } else if (input.action === "input.status") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "input.status", requestId: "original-request" });
        send(response, { code: 0, data: { state: "completed", requestId: "original-request", completedActions: 1,
          capture: { state: "captured", frameId: "touch-frame" } } });
      } else if (input.action === "apps.list") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "apps.list" });
        send(response, { code: 0, data: { state: "ready", apps: [{ appId: "com.android.settings/.Settings", name: "Settings", packageName: "com.android.settings" }] } });
      } else if (input.action === "apps.open") {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "apps.open", requestId: "original-launch", appId: "com.android.settings/.Settings",
          source, captureAfter: { waitMs: 800 }, observerLabel: "测试会话" });
        send(response, { code: 0, data: { state: "completed", requestId: "original-launch", completedActions: 1,
          appId: "com.android.settings/.Settings", launchState: "requested", capture: { ...image, state: "captured", frameId: "launch-frame" } } });
      } else {
        assert.deepEqual(input, { targetId: phoneId, targetGuid: "", action: "screen.capture", maxWidth: 32, observerLabel: "测试会话" });
        send(response, { code: 0, data: image });
      }
      return;
    }
    assert.equal(request.url, "/api/rabilink/mobile/location");
    assert.deepEqual(JSON.parse(raw), { targetId: phoneId, targetGuid: "", action: "location.settings.read" });
    send(response, { code: 0, data: { enabled: true, permission: "approximate" } });
  });
  const desktopOperation = createLanAgentComputerOperations({
    registry: {} as LanAgentRegistry, isManagementRequestAuthorized: () => false
  })[0]!;
  const calls: unknown[] = [];
  const computer: DeviceComputerPort = {
    operation: desktopOperation,
    observationLabel: async () => "测试会话",
    list: async () => ({ computers: [
      { instanceId: "local-instance", name: "Local PC", status: "online", capabilities: ["input"] },
      { instanceId: "remote-instance", ownerDeviceId: "remote-host", name: "Remote PC", status: "online", capabilities: ["input"] },
    ], sourceErrors: [] }),
    async invoke(input, target) {
      calls.push({ target, body: input.body });
      return { status: 200, body: { code: 0, data: { state: "completed" } } };
    }
  };
  const base = await manager(t, () => config(upstream), undefined, undefined, computer);
  const directory = await fetch(base + "/api/device-control/targets");
  assert.equal(directory.status, 200, await directory.clone().text());
  const { data } = await directory.json();
  assert.deepEqual(data.targets.map((row: { target: unknown }) => row.target), [
    { kind: "computer", instanceId: "local-instance" },
    { kind: "computer", instanceId: "remote-instance", ownerDeviceId: "remote-host" },
    { kind: "phone", deviceId: phoneId, guid: "" },
  ]);
  const post = (body: unknown) => fetch(base + "/api/device-control/execute", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const body = { action: "input.status", requestId: "original-request" };
  for (const target of data.targets.slice(0, 2).map((row: { target: unknown }) => row.target)) {
    const response = await post({ target, ...body });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls.at(-1), { target, body });
  }
  assert.equal((await post({ target: data.targets[2].target, ...body })).status, 200);
  const phoneStatus = await post({ target: data.targets[2].target, action: "screen.status" });
  assert.equal(phoneStatus.status, 200);
  assert.deepEqual((await phoneStatus.json()).data, status);
  const stop = await post({ target: data.targets[2].target, action: "input.cancel", requestId: status.activity.operation.requestId });
  assert.equal((await stop.json()).data.state, "cancel-requested");
  const setting = await post({ target: data.targets[2].target, action: "location.settings.read" });
  assert.equal(setting.status, 200, await setting.clone().text());
  assert.deepEqual(await setting.json(), { code: 0, data: { enabled: true, permission: "approximate" } });
  const capture = await post({ target: data.targets[2].target, action: "screen.capture", maxWidth: 32 });
  assert.equal(capture.status, 200, await capture.clone().text());
  const frame = (await capture.json()).data;
  assert.equal(frame.mimeType, "image/png");
  assert.equal(frame.source.instanceId, phoneWorkerId);
  const touch = await post({ target: data.targets[2].target, action: "input.perform", requestId: "original-request",
    source: frame.source, actions: [{ type: "click", x: 10, y: 14 }], captureAfter: { waitMs: 800 } });
  assert.equal(touch.status, 200, await touch.clone().text());
  const touchReceipt = (await touch.json()).data;
  assert.equal(touchReceipt.completedActions, 1);
  assert.equal(touchReceipt.capture.mimeType, "image/png");
  assert.deepEqual((await (await post({ target: data.targets[2].target, ...body })).json()).data.capture,
    { state: "captured", frameId: "touch-frame" });
  assert.equal((await post({ target: data.targets[2].target, action: "input.perform", requestId: "invalid",
    source: frame.source, actions: [{ type: "text", text: "test" }] })).status, 400);
  const apps = await post({ target: data.targets[2].target, action: "apps.list" });
  assert.equal(apps.status, 200, await apps.clone().text());
  const appId = (await apps.json()).data.apps[0].appId;
  const openBody = { target: data.targets[2].target, action: "apps.open", appId, requestId: "original-launch", captureAfter: { waitMs: 800 } };
  assert.equal((await post(openBody)).status, 400);
  const openApp = await post({ ...openBody, source: frame.source });
  assert.equal(openApp.status, 200, await openApp.clone().text());
  assert.equal((await openApp.json()).data.launchState, "requested");
  const waiting = await post({ target: data.targets[2].target, action: "screen.wait", source: frame.source, waitMs: 250 });
  assert.equal(waiting.status, 200, await waiting.clone().text());
  assert.equal((await waiting.json()).data.capture.source.frameId, "frame-2");
  assert.equal((await post({ target: data.targets[2].target, action: "screen.wait", source: { ...frame.source, frameId: "" } })).status, 400);
  assert.equal((await post({ target: data.targets[2].target, action: "screen.capture", observerLabel: "Spoofed" })).status, 400);
  const search = await fetch(base + "/api/search?" + new URLSearchParams({ q: "设备控制", scope: "operations", agent: "fixture-role" }));
  assert.equal(search.status, 200, await search.clone().text());
  const found = (await search.json()).data.items as Array<{ handle: { operationId?: string } }>;
  assert.ok(found.some(item => item.handle.operationId === "manager.device-control.execute"));
});

test("disabled and missing configuration fail explicitly without an empty success", async t => {
  for (const saved of [{ ...config(""), enabled: false }, config("")]) {
    const base = await manager(t, () => saved);
    const response = await fetch(`${base}/api/rabi/link-home`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, -1);
    assert.equal(body.data, undefined);
  }
});

test("redirect is rejected without leaking the app token to its target", async t => {
  let targetCalls = 0;
  const target = await server(t, (_request, response) => { targetCalls++; response.end("unexpected"); });
  const upstream = await server(t, (_request, response) => { response.writeHead(302, { location: target }); response.end(); });
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 502);
  assert.equal(targetCalls, 0);
});

test("deadline includes an unfinished response body", async t => {
  const upstream = await server(t, (_request, response) => { response.writeHead(200); response.write('{"code":0,'); });
  const start = Date.now();
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 504);
  assert.ok(Date.now() - start < 6000);
});

test("upstream failures, malformed JSON and invalid contracts never become zero devices", async t => {
  const cases = ["not json", { code: -1, ok: false, peers: [] }, { code: 0, ok: true }, { code: 0, ok: true, peers: [{ ...peer, online: "true" }] }];
  for (const payload of cases) {
    const upstream = await server(t, (_request, response) => { if (typeof payload === "string") response.end(payload); else send(response, payload); });
    await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 502);
  }
  const upstream = await server(t, (_request, response) => { response.statusCode = 401; response.end("private-token-cookie-raw-error"); });
  const base = await manager(t, () => config(upstream));
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /private-token-cookie-raw-error|devices/);
  assert.equal(JSON.parse(text).code, -1);
});

test("streaming oversized body is bounded even without content length", async t => {
  const upstream = await server(t, (_request, response) => { response.writeHead(200); response.write(" ".repeat(256 * 1024)); response.end("extra"); });
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.errorCode === "RABILINK_HOME_RESPONSE_TOO_LARGE");
});

test("configuration changes during discovery reject the old authorization result", async t => {
  let saved: RabiLinkRelayGlobalConfig;
  const upstream = await server(t, (_request, response) => { saved = { ...saved, token: "changed-test-token" }; send(response, { code: 0, ok: true, peers: [peer] }); });
  saved = config(upstream);
  const base = await manager(t, () => saved);
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.errorCode, "RABILINK_HOME_CONFIG_CHANGED");
  assert.equal(body.data, undefined);
});

test("a local GUID change during discovery cannot label the old registration as this PC", async t => {
  let guid = "local-guid";
  const upstream = await server(t, (_request, response) => {
    guid = "new-guid";
    send(response, { code: 0, ok: true, peers: [{ ...peer, id: "test-device", guid: "local-guid", deviceKind: "pc" }] });
  });
  const base = await manager(t, () => config(upstream), () => guid);
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "RABILINK_HOME_CONFIG_CHANGED");
});
