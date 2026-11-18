import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ManagerPluginRouteRegistry } from "@rabiroute/host-api/manager/managerPluginRouteRegistry";
import { createNapCatAdapter } from "../adapters/napcatAdapter.js";
import { appendNapcatApiEvent, napcatApiEventCatalog, projectNapcatApiEvent, type NapcatEventManifest } from "./napcatApiEvents.js";

const manifest: NapcatEventManifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8"));
const source = { routeId: "fixture-route", instanceId: "fixture-instance", botUserId: "12345" };

test("event catalog excludes base classes and retains all 25 instantiated classes", () => {
  const catalog = napcatApiEventCatalog(manifest);
  assert.equal(catalog.events.length, 25);
  assert.equal(catalog.baseClassesExcluded.length, 6);
  assert.deepEqual(catalog.message.postTypes, ["message", "message_sent"]);
});

test("all instantiated event classes project declared metadata and omit credential/raw payload fields", () => {
  for (const row of manifest.events.filter(row => row.instantiated)) {
    const selectors = Object.fromEntries(Object.entries(row.selectors).filter(([, value]) => value?.resolved).map(([key, value]) => [key, value?.value]));
    const event = { ...selectors, self_id: 12345, user_id: 456, time: 42, token: "private-token", data: { cookie: "private-cookie" }, raw_info: "private-raw",
      ...(row.fields.includes("group_id") ? { group_id: 789 } : {}),
      ...(row.className === "OB11OnlineFileReceiveEvent" ? { notice_type: "online_file_receive", sub_type: "cancel" } : {}) };
    const record = projectNapcatApiEvent(manifest, source, event);
    assert.ok(record?.eventClasses.includes(row.className), row.className);
    assert.equal(JSON.stringify(record).includes("private-"), false, row.className);
  }
});

test("request flags remain with the original request owner and outbound messages expose metadata only", () => {
  const request = projectNapcatApiEvent(manifest, source, { post_type: "request", request_type: "friend", self_id: 12345,
    user_id: 456, flag: "private-acceptance-capability", comment: "fixture request", message: "private-content" });
  assert.equal(request?.requestFlagPresent, true);
  assert.equal(request?.fields.comment, undefined, "request bodies stay with their original private request owner");
  assert.equal(JSON.stringify(request).includes("private-"), false);
  const sent = projectNapcatApiEvent(manifest, source, { post_type: "message_sent", message_type: "group", self_id: 12345, group_id: 789,
    message_id: 12, message: [{ type: "image", data: { url: "https://private.invalid/?token=secret" } }], raw_message: "secret" });
  assert.equal(sent?.fields.message_id, "12");
  assert.equal(JSON.stringify(sent).includes("secret"), false);
  assert.equal(projectNapcatApiEvent(manifest, source, { post_type: "notice", notice_type: "not_registered", self_id: 12345 }), undefined);
  assert.equal(projectNapcatApiEvent(manifest, source, { post_type: "message", message_type: "group", self_id: 999 }), undefined);
});

test("typed records reuse the original napcat adapter history with no second event ledger", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-event-archive-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const event = { post_type: "meta_event", meta_event_type: "heartbeat", self_id: 12345, interval: 30000,
    status: { online: true, good: true, cookie: "private" } };
  const result = appendNapcatApiEvent(manifest, source, event, dataDir);
  assert.deepEqual(result?.fields.status, { online: true, good: true });
  const lines = (await fs.readFile(path.join(dataDir, "napcat-adapter.log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const stored = JSON.parse(lines[0]!);
  assert.equal(stored.event, "typed_event");
  assert.deepEqual(stored.data, result);
  assert.equal(JSON.stringify(stored).includes("private"), false);
  assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith("jsonl")), ["napcat-adapter.log.jsonl"]);
});

test("the real isolated WS ingress archives the typed event before the existing handler", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-event-ingress-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const registry = new ManagerPluginRouteRegistry();
  let received!: () => void;
  let handledCount = 0;
  const eventHandled = new Promise<void>(resolve => { received = resolve; });
  const adapter = createNapCatAdapter({ routeId: source.routeId, apiOperations: registry, dataDir: () => dataDir, eventBotUserId: () => "12345",
    instances: () => [{ id: source.instanceId, name: "Fixture", enabled: true, autoLoginOnRabiStart: false, gatewayPort: 0,
      httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:2", accessToken: "" }],
    refreshProfile() {}, async handleEvent() { if (++handledCount === 2) received(); } });
  const dispose = await adapter.start();
  t.after(() => dispose?.());
  const port = registry.catalogSnapshot().listeners[0]!.binding.address.port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ post_type: "request", request_type: "friend", self_id: 99999, user_id: 456, flag: "wrong-account" }));
  socket.send(JSON.stringify({ post_type: "request", request_type: "friend", self_id: 12345, user_id: 456,
    flag: "private-request-capability", comment: "fixture request" }));
  await eventHandled;
  const rows = (await fs.readFile(path.join(dataDir, "napcat-adapter.log.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  const typed = rows.filter(row => row.event === "typed_event");
  assert.equal(typed.length, 1);
  assert.equal(typed[0].data.source.routeId, source.routeId);
  assert.equal(typed[0].data.eventClasses[0], "OB11FriendRequestEvent");
  assert.equal(JSON.stringify(typed[0]).includes("private-request-capability"), false);
  assert.equal(rows.some(row => row.event === "inbound_event"), true);
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  await dispose?.();
  await closed;
});
