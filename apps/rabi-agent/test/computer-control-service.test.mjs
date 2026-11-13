import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ComputerControlService } from "../lib/computer-control-service.mjs";
import { DEFAULT_COMPUTER_SETTINGS } from "../lib/computer-control-contract.mjs";

class NativeFixture extends EventEmitter {
  calls = [];
  closed = false;
  async request(action, body) {
    this.calls.push({ action, body });
    if (action === "control.begin") return { visible: true, hotkey: { registered: false, error: "fixture does not register OS shortcuts" } };
    if (action === "input.execute") return this.inject ? this.inject(body) : { state: "injected", injectedEvents: 2 };
    if (action === "annotation.track.start") return { trackingId: body.trackingId, state: "tracking", targets: body.targets, objects: [] };
    if (action === "annotation.track.stop") return { trackingId: body.trackingId, state: "stopped" };
    if (action === "screen.capture") return this.capture ? this.capture(body) : { frameId: "fixture-frame", data: "fixture", source: body.source };
    return { state: "completed", releaseState: "released" };
  }
  async close() { this.closed = true; }
}
function fixture(options = {}) {
  const native = new NativeFixture();
  const settings = structuredClone(DEFAULT_COMPUTER_SETTINGS);
  const context = { sourceId: "trusted-connection-A", sourceLabel: "Fixture", getSettings: () => settings };
  const owner = new ComputerControlService({ native, instanceId: "fixture-computer", ...options });
  return { native, settings, context, owner };
}
const request = (action, extra = {}) => ({ action, requestId: randomUUID(), ...extra });

test("one control intent joins concurrent same-ID requests and returns the ended original session", async () => {
  const f = fixture();
  const begin = request("control.begin");
  const [a, b] = await Promise.all([f.owner.execute(begin, f.context), f.owner.execute(begin, f.context)]);
  assert.equal(a.controlSessionId, b.controlSessionId);
  assert.equal(f.native.calls.filter(call => call.action === "control.begin").length, 1);
  await assert.rejects(f.owner.execute({ ...begin, captureAfter: true }, f.context), /different content/);
  await assert.rejects(f.owner.execute(request("control.begin"), { ...f.context, sourceId: "connection-B" }), /control source/);
  await f.owner.execute({ action: "control.end", controlSessionId: a.controlSessionId }, f.context);
  assert.equal((await f.owner.execute(begin, f.context)).state, "ended");
  await f.owner.stop();
});

test("native input needs control and same-ID batches inject each accepted action only once", async () => {
  const f = fixture();
  await assert.rejects(f.owner.execute(request("input.execute", { controlSessionId: "none", actions: [{ type: "text", text: "中文" }] }), f.context), /Enter control/);
  const control = await f.owner.execute(request("control.begin"), f.context);
  const batch = request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "move", x: -10, y: 40 }, { type: "text", text: "中文\n!" }, { type: "key", keys: ["Ctrl", "A"] }] });
  const results = await Promise.all([f.owner.execute(batch, f.context), f.owner.execute(batch, f.context)]);
  assert.equal(results[0].state, "injected");
  assert.equal(results[0].completedActions, 3);
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 3);
  await f.owner.stop();
});

test("latest trusted settings and stop guard are checked between input actions", async () => {
  const f = fixture();
  const control = await f.owner.execute(request("control.begin"), f.context);
  f.native.inject = async () => { f.settings.features.input = false; return { state: "injected", injectedEvents: 1 }; };
  await assert.rejects(f.owner.execute(request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "move", x: 1, y: 2 }, { type: "move", x: 2, y: 3 }] }), f.context), /disabled/);
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 1);
  assert.equal((await f.owner.execute({ action: "control.status" }, f.context)).state, "active");
  await f.owner.reconcile(f.context);
  assert.equal((await f.owner.execute({ action: "control.status", controlSessionId: control.controlSessionId }, f.context)).state, "ended");
  await f.owner.stop();
});

test("status polling and slow capture do not block input cancellation or renew idle", async () => {
  let now = 0;
  const f = fixture({ now: () => now });
  const control = await f.owner.execute(request("control.begin"), f.context);
  now = 10000;
  assert.equal((await f.owner.execute({ action: "control.status" }, f.context)).remainingMs, 110000);
  let finishCapture;
  f.native.capture = () => new Promise(resolve => { finishCapture = resolve; });
  const capture = f.owner.capture({ action: "screen.capture", background: true }, f.context);
  await new Promise(resolve => setImmediate(resolve));
  await f.owner.execute({ action: "control.end", controlSessionId: control.controlSessionId }, f.context);
  assert.equal(f.owner.controlStatus(control.controlSessionId).state, "ended");
  finishCapture({ frameId: "fixture-frame" }); await capture;
  await f.owner.stop();
});

test("cancel preserves the executed prefix and prevents the remainder of a queued batch", async () => {
  const f = fixture();
  const control = await f.owner.execute(request("control.begin"), f.context);
  let finish;
  f.native.inject = () => new Promise(resolve => { finish = resolve; });
  const batch = request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
  const running = f.owner.execute(batch, f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.owner.execute({ action: "input.status", requestId: batch.requestId }, f.context)).state, "running");
  await f.owner.execute({ action: "input.cancel", requestId: batch.requestId }, f.context);
  finish({ state: "injected", injectedEvents: 2 });
  const result = await running;
  assert.equal(result.state, "cancelled"); assert.equal(result.completedActions, 1);
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 1);
  await f.owner.stop();
});

test("restart preserves a submitted receipt as uncertain and does not replay native effects", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-computer-receipt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture({ receiptRoot: directory });
  const control = await f.owner.execute(request("control.begin"), f.context);
  f.native.inject = async () => { throw Object.assign(new Error("pipe closed after submission"), { code: "COMPUTER_RESULT_UNCERTAIN", uncertain: true }); };
  const batch = request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "text", text: "once" }] });
  await assert.rejects(f.owner.execute(batch, f.context), /pipe closed/);
  const restored = fixture({ receiptRoot: directory });
  assert.equal((await restored.owner.execute({ action: "input.status", requestId: batch.requestId }, restored.context)).state, "uncertain");
  assert.equal((await restored.owner.execute(batch, restored.context)).state, "uncertain");
  assert.equal(restored.native.calls.filter(call => call.action === "input.execute").length, 0);
  await Promise.all([f.owner.stop(), restored.owner.stop()]);
});

test("static annotations do not enter input control; clear invalidates stale updates", async () => {
  const f = fixture();
  const show = request("annotation.show", { layerId: "fixture-layer", source: { instanceId: "fixture-computer", kind: "desktop", coordinateSpace: "desktop" }, objects: [{ id: "one", type: "text", text: "<script>plain text</script>", bounds: { x: 1, y: 2, width: 3, height: 4 } }], durationMs: null });
  const layer = await f.owner.execute(show, f.context);
  assert.equal(layer.state, "visible"); assert.equal(layer.version, 1);
  assert.equal(f.native.calls.some(call => call.action === "control.begin" || call.action === "input.execute"), false);
  await f.owner.execute({ action: "annotation.clear", layerId: show.layerId }, f.context);
  await assert.rejects(f.owner.execute({ action: "annotation.update", layerId: show.layerId, expectedVersion: 1, objects: [] }, f.context), /cleared or newer/);
  await f.owner.stop();
});

test("tracking is explicitly enabled, belongs to its task, and all-layer clear stops its worker", async () => {
  const f = fixture();
  const start = request("annotation.track.start", { layerId: "tracking-layer", source: { frameId: "fixture-frame" }, targets: [{ id: "moving", bounds: { x: 1, y: 1, width: 20, height: 20 } }] });
  await assert.rejects(f.owner.execute(start, f.context), /Dynamic annotation is disabled/);
  f.settings.annotation.dynamicEnabled = true;
  const tracked = await f.owner.execute({ ...start, requestId: randomUUID() }, { ...f.context, taskId: "task-A" });
  const layers = await f.owner.execute({ action: "annotation.status" }, f.context);
  assert.equal(layers.layers[0].trackingId, tracked.trackingId);
  await f.owner.endTask("task-B"); assert.equal(f.native.calls.some(call => call.action === "annotation.track.stop"), false);
  await f.owner.execute({ action: "annotation.clear" }, f.context);
  assert.equal(f.native.calls.filter(call => call.action === "annotation.track.stop").length, 1);
  assert.equal((await f.owner.execute({ action: "annotation.status" }, f.context)).layers.length, 0);
  await f.owner.stop();
});

test("captureAfter records unavailable observation separately from successful input", async () => {
  const f = fixture();
  const control = await f.owner.execute(request("control.begin"), f.context);
  f.settings.features.observation = false;
  const result = await f.owner.execute(request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "text", text: "A" }], captureAfter: true }), f.context);
  assert.equal(result.state, "injected"); assert.equal(result.capture.state, "unavailable");
  await f.owner.stop();
});

test("clear retires an admitted layer before a late native show can repaint it", async () => {
  const f = fixture();
  const original = f.native.request.bind(f.native);
  let showReturned;
  f.native.request = async (action, body) => {
    const result = await original(action, body);
    return action === "annotation.show" ? new Promise(resolve => { showReturned = () => resolve(result); }) : result;
  };
  const pending = f.owner.execute(request("annotation.show", { layerId: "late", source: { coordinateSpace: "desktop" }, objects: [], durationMs: null }), f.context);
  await new Promise(resolve => setImmediate(resolve));
  const cleared = await f.owner.execute({ action: "annotation.clear", layerId: "late" }, f.context);
  assert.equal(cleared.state, "cleared");
  showReturned();
  assert.equal((await pending).state, "cleared");
  assert.deepEqual((await f.owner.execute({ action: "annotation.status" }, f.context)).layers, []);
  const show = f.native.calls.find(call => call.action === "annotation.show");
  const clear = f.native.calls.find(call => call.action === "annotation.clear");
  assert.ok(clear.body.version > show.body.version);
  await f.owner.stop();
});

test("clear cancels an admitted native tracking start and never installs its late worker", async () => {
  const f = fixture(); f.settings.annotation.dynamicEnabled = true;
  const original = f.native.request.bind(f.native); let finish;
  f.native.request = async (action, body) => {
    const result = await original(action, body);
    return action === "annotation.track.start" ? new Promise(resolve => { finish = () => resolve(result); }) : result;
  };
  const pending = f.owner.execute(request("annotation.track.start", { layerId: "late-track", source: { frameId: "fixture" }, targets: [] }), f.context);
  await new Promise(resolve => setImmediate(resolve));
  await f.owner.execute({ action: "annotation.clear", layerId: "late-track" }, f.context);
  finish(); const result = await pending;
  assert.equal(result.state, "stopped");
  assert.equal(f.owner.trackers.size, 0);
  assert.equal(f.owner.activeCount, 0);
  assert.ok(f.native.calls.some(call => call.action === "annotation.track.stop" && call.body.trackingId === result.trackingId));
  await f.owner.stop();
});

test("a previously accepted input receipt remains readable when the feature is subsequently closed", async () => {
  const f = fixture();
  const control = await f.owner.execute(request("control.begin"), f.context);
  const batch = request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "text", text: "once" }] });
  assert.equal((await f.owner.execute(batch, f.context)).state, "injected");
  f.settings.enabled = false; f.settings.features.input = false;
  assert.equal((await f.owner.execute(batch, f.context)).state, "injected");
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 1);
  await f.owner.stop();
});

test("an explicit coordinate source cannot name another target computer", async () => {
  const f = fixture(); const control = await f.owner.execute(request("control.begin"), f.context);
  await assert.rejects(f.owner.execute(request("input.execute", { controlSessionId: control.controlSessionId,
    source: { instanceId: "another-computer", coordinateSpace: "desktop" }, actions: [{ type: "move", x: 1, y: 2 }] }), f.context), /another computer/);
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 0);
  await f.owner.stop();
});

test("status reads and frame positions emit no structural control changes; end and clear are deduplicated", async () => {
  let changes = 0;
  const f = fixture({ onChange: () => { changes++; } });
  const control = await f.owner.execute(request("control.begin"), f.context);
  const beforeReads = changes;
  for (let n = 0; n < 50; n++) await f.owner.execute({ action: "control.status" }, f.context);
  assert.equal(changes, beforeReads);
  f.native.emit("control-ended", { controlSessionId: control.controlSessionId, reason: "user-exit" });
  await Promise.resolve();
  assert.equal(changes, beforeReads + 1);
  f.native.emit("control-ended", { controlSessionId: control.controlSessionId, reason: "user-exit" });
  await Promise.resolve();
  assert.equal(changes, beforeReads + 1);
  const show = request("annotation.show", { layerId: "events", source: { coordinateSpace: "desktop" }, objects: [], durationMs: null });
  await f.owner.execute(show, f.context);
  const beforeClear = changes;
  await f.owner.execute({ action: "annotation.clear", layerId: "events" }, f.context);
  assert.equal(changes, beforeClear + 1);
  await f.owner.execute({ action: "annotation.clear", layerId: "events" }, f.context);
  assert.equal(changes, beforeClear + 1);
  f.settings.annotation.dynamicEnabled = true;
  const tracked = await f.owner.execute(request("annotation.track.start", { layerId: "event-track", source: { frameId: "fixture" }, targets: [{ id: "moving", state: "tracking" }] }), f.context);
  f.native.emit("tracking", { trackingId: tracked.trackingId, state: "tracking", effective: { rateHz: 10, maxAnalysisWidth: 1280 }, targets: [{ id: "moving", state: "tracking", bounds: { x: 1 } }] });
  await Promise.resolve();
  const beforeFrames = changes;
  for (let n = 0; n < 30; n++) f.native.emit("tracking", { trackingId: tracked.trackingId, state: "tracking", effective: { rateHz: 10, maxAnalysisWidth: 1280 }, targets: [{ id: "moving", state: "tracking", bounds: { x: n } }], metrics: { processingMs: n } });
  assert.equal(changes, beforeFrames);
  await f.owner.stop();
});

test("source retirement cancels only already captured queued work and fresh unscoped or new connections remain usable", async () => {
  const f = fixture(); const sourceA = { ...f.context, connectionId: "connection-A" };
  const pending = f.owner.execute(request("control.begin"), sourceA).then(result => ({ result }), error => ({ error }));
  await f.owner.endSource("connection-A");
  assert.equal((await pending).error.code, "COMPUTER_SOURCE_CLOSED");
  assert.equal(f.native.calls.filter(call => call.action === "control.begin").length, 0);
  assert.equal(f.owner.inflight.size, 0);
  const fresh = await f.owner.execute(request("control.begin"), { ...f.context, connectionId: "connection-B" });
  assert.equal(fresh.state, "active");
  await f.owner.execute({ action: "control.end", controlSessionId: fresh.controlSessionId }, f.context);
  assert.equal((await f.owner.execute(request("control.begin"), f.context)).state, "active", "HTTP without a WS scope stays available");
  await f.owner.stop();
});

test("a late old disconnect cannot clear a new source's reused layer ID or control session", async () => {
  const f = fixture();
  const sourceA = { ...f.context, connectionId: "connection-A" }, sourceB = { ...f.context, connectionId: "connection-B" };
  const old = await f.owner.execute(request("control.begin"), sourceA);
  await f.owner.execute(request("annotation.show", { layerId: "reused", source: {}, objects: [], durationMs: null }), sourceA);
  const original = f.native.request.bind(f.native); let finishEnd;
  f.native.request = async (action, body) => {
    const result = await original(action, body);
    return action === "control.end" && body.controlSessionId === old.controlSessionId ? new Promise(resolve => { finishEnd = () => resolve(result); }) : result;
  };
  const disconnect = f.owner.endSource("connection-A");
  await new Promise(resolve => setImmediate(resolve));
  f.native.emit("control-ended", { controlSessionId: old.controlSessionId, reason: "connection-closed" });
  const current = await f.owner.execute(request("control.begin"), sourceB);
  const layer = await f.owner.execute(request("annotation.show", { layerId: "reused", source: {}, objects: [], durationMs: null }), sourceB);
  finishEnd(); await disconnect;
  assert.equal(f.owner.controlStatus().controlSessionId, current.controlSessionId);
  assert.equal(f.owner.controlStatus().state, "active");
  const after = await f.owner.execute({ action: "annotation.status", layerId: "reused" }, sourceB);
  assert.equal(after.state, "visible"); assert.equal(after.version, layer.version);
  await f.owner.stop();
});

test("matching task IDs from another source do not participate in task-end cleanup", async () => {
  const f = fixture(); f.settings.annotation.dynamicEnabled = true;
  const a = { ...f.context, taskId: "shared-task-id", sourceId: "A" }, b = { ...f.context, taskId: "shared-task-id", sourceId: "B" };
  await f.owner.execute(request("annotation.show", { layerId: "A", source: {}, objects: [], durationMs: null }), a);
  await f.owner.execute(request("annotation.show", { layerId: "B", source: {}, objects: [], durationMs: null }), b);
  await f.owner.endTask("shared-task-id", "A");
  const layers = (await f.owner.execute({ action: "annotation.status" }, f.context)).layers;
  assert.deepEqual(layers.map(layer => layer.layerId), ["B"]);
  await f.owner.stop();
});

test("tracking position updates and activeCount never traverse completed receipt or layer history", async () => {
  let changes = 0;
  const f = fixture({ onChange: () => { changes++; } }); f.settings.annotation.dynamicEnabled = true;
  const current = await f.owner.execute(request("annotation.track.start", { layerId: "live", source: { frameId: "fixture" }, targets: [{ id: "one", state: "tracking" }] }), f.context);
  const event = { trackingId: current.trackingId, state: "tracking", effective: { rateHz: 10, maxAnalysisWidth: 1280 }, targets: [{ id: "one", state: "tracking", bounds: { x: 0 } }] };
  f.native.emit("tracking", event); await Promise.resolve();
  for (let index = 0; index < 10000; index++) {
    f.owner.receipts.set(`history-${index}`, { requestId: `history-${index}`, state: "injected" });
    f.owner.layers.set(`history-${index}`, { layerId: `history-${index}`, version: 2, state: "cleared" });
    f.owner.trackers.set(`history-${index}`, { trackingId: `history-${index}`, state: "stopped", stopped: true });
  }
  let traversals = 0; const maps = [f.owner.receipts, f.owner.layers, f.owner.trackers];
  const originals = maps.map(map => map.values);
  maps.forEach(map => { map.values = function () { traversals++; throw new Error("Hot path traversed completed history"); }; });
  try {
    const before = changes;
    for (let index = 0; index < 200; index++) {
      f.native.emit("tracking", { ...event, targets: [{ id: "one", state: "tracking", bounds: { x: index } }], metrics: { processingMs: index } });
      assert.equal(f.owner.activeCount, 2);
    }
    await Promise.resolve();
    assert.equal(changes, before);
    assert.equal(traversals, 0);
    assert.equal((await f.owner.execute({ action: "annotation.status" }, f.context)).layers.length, 1);
  } finally { maps.forEach((map, index) => { map.values = originals[index]; }); await f.owner.stop(); }
});

test("bad settings do not block original state, exit or layer cleanup and do not default-enable new work", async () => {
  const f = fixture();
  const control = await f.owner.execute(request("control.begin"), f.context);
  const input = request("input.execute", { controlSessionId: control.controlSessionId, actions: [{ type: "text", text: "before-corruption" }] });
  await f.owner.execute(input, f.context);
  await f.owner.execute(request("annotation.show", { layerId: "bad-settings", source: {}, objects: [], durationMs: null }), f.context);
  const broken = { ...f.context, getSettings: () => { throw new Error("original settings JSON is invalid"); } };
  f.owner.session.context = broken;
  assert.equal((await f.owner.execute({ action: "control.status" }, broken)).state, "active");
  assert.equal((await f.owner.execute({ action: "input.status", requestId: input.requestId }, broken)).state, "injected");
  await f.owner.execute({ action: "annotation.clear", layerId: "bad-settings" }, broken);
  await f.owner.execute({ action: "control.end", controlSessionId: control.controlSessionId }, broken);
  await assert.rejects(f.owner.execute(request("control.begin"), broken), /settings JSON is invalid/);
  assert.equal(f.native.calls.filter(call => call.action === "input.execute").length, 1);
  assert.equal(f.native.calls.filter(call => call.action === "control.begin").length, 1);
  await f.owner.stop();
});

test("a second authenticated source may update an exact layer version without taking its lifecycle ownership", async () => {
  const f = fixture();
  const a = { ...f.context, sourceId: "A", connectionId: "A-connection" }, b = { ...f.context, sourceId: "B", connectionId: "B-connection" };
  const first = await f.owner.execute(request("annotation.show", { layerId: "shared-edit", source: {}, objects: [], durationMs: null }), a);
  const next = await f.owner.execute({ action: "annotation.update", layerId: first.layerId, expectedVersion: first.version, objects: [{ id: "B-edit", type: "text", text: "updated", bounds: { x: 1, y: 2 } }] }, b);
  assert.equal(next.version, 2);
  assert.equal(f.owner.layers.get(first.layerId).sourceId, "A");
  assert.equal(f.owner.layers.get(first.layerId).connectionId, "A-connection");
  await assert.rejects(f.owner.execute({ action: "annotation.update", layerId: first.layerId, expectedVersion: 1, objects: [] }, b), /newer layer/);
  await f.owner.execute({ action: "annotation.clear", layerId: first.layerId }, b);
  await assert.rejects(f.owner.execute({ action: "annotation.update", layerId: first.layerId, expectedVersion: 2, objects: [] }, a), /cleared or newer/);
  await f.owner.stop();
});

test("begin remains starting until native acknowledgment and a failed old request never returns another session", async () => {
  const f = fixture(); f.settings.features.input = false;
  const failed = request("control.begin"); await assert.rejects(f.owner.execute(failed, f.context), /disabled/);
  f.settings.features.input = true;
  const original = f.native.request.bind(f.native); let finish;
  f.native.request = async (action, body, options) => {
    if (action !== "control.begin") return original(action, body);
    return new Promise(resolve => { finish = () => { options?.beforeSend?.(); resolve({ visible: true, state: "active" }); }; });
  };
  const pending = f.owner.execute(request("control.begin"), f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.owner.controlStatus().state, "starting");
  finish(); const current = await pending; assert.equal(current.state, "active");
  const replay = await f.owner.execute(failed, f.context);
  assert.equal(replay.state, "failed"); assert.notEqual(replay.controlSessionId, current.controlSessionId);
  await f.owner.stop();
});

test("bad tracking settings do not block input and old receipts still precede disabled settings", async () => {
 const f=fixture();
 f.settings.annotation.tracking.matchThreshold="broken";
 f.settings.performance.memoryBudgetBytes="broken";
 const original=request("control.begin");
 try {
   const control=await f.owner.execute(original,f.context);
   assert.equal(control.state,"active");
   f.settings.enabled=false;
   const duplicate=await f.owner.execute(original,f.context);
   assert.equal(duplicate.controlSessionId,control.controlSessionId);
   const count=f.native.calls.filter(call=>call.action==="control.begin").length;
   await assert.rejects(f.owner.execute(request("control.begin"),f.context),error=>error.code==="COMPUTER_FEATURE_DISABLED");
   assert.equal(f.native.calls.filter(call=>call.action==="control.begin").length,count);
 } finally { await f.owner.stop(); }
});

test("a new definition backend reaches the same target while old WAL retains its original result", async () => {
 const {createComputerSettingsDefinition}=await import("../lib/computer-control-contract.mjs");
 const {COMPUTER_SETTINGS_DEFINITION}=await import("../lib/computer-settings-definition.mjs");
 const source=JSON.parse(JSON.stringify(COMPUTER_SETTINGS_DEFINITION));
 const a=createComputerSettingsDefinition(source,"target-A");
 const bData=structuredClone(source);bData.schema.properties.annotation.properties.backend.enum.push("fixture-backend");bData.schema.properties.annotation.properties.backend.default="fixture-backend";
 const b=createComputerSettingsDefinition(bData,"target-B");
 let selected=a;const raw={annotation:{dynamicEnabled:true}};
 const f=fixture(),context={...f.context,getDefinition:()=>selected,getSettings:()=>raw};
 const original=request("annotation.track.start",{layerId:"definition-A",source:{frameId:"fixture-frame"},targets:[{id:"moving",bounds:{x:1,y:1,width:20,height:20}}]});
 try {
  const first=await f.owner.execute(original,context);
  assert.equal(f.native.calls.find(call=>call.action==="annotation.track.start").body.backend,"kcf");
  selected=b;
  await f.owner.execute({...original,requestId:randomUUID(),layerId:"definition-B"},context);
  assert.equal(f.native.calls.filter(call=>call.action==="annotation.track.start").at(-1).body.backend,"fixture-backend");
  const again=await f.owner.execute(original,context);
  assert.equal(again.trackingId,first.trackingId);
  assert.equal(f.native.calls.filter(call=>call.action==="annotation.track.start").length,2);
  assert.equal(COMPUTER_SETTINGS_DEFINITION.schema.properties.annotation.properties.backend.enum.includes("fixture-backend"),false);
 } finally {await f.owner.stop();}
});

test("inflight parameters remain A after definition B, while explicit live input off stops the next segment", async () => {
 const {createComputerSettingsDefinition}=await import("../lib/computer-control-contract.mjs");
 const {COMPUTER_SETTINGS_DEFINITION}=await import("../lib/computer-settings-definition.mjs");
 const data=JSON.parse(JSON.stringify(COMPUTER_SETTINGS_DEFINITION)),a=createComputerSettingsDefinition(data,"input-A");
 const beta=structuredClone(data);beta.schema.properties.input.properties.nativeSegmentMs.default=24;
 let selected=a;const raw={features:{input:true}},f=fixture(),context={...f.context,getDefinition:()=>selected,getSettings:()=>raw};
 let entered,release;const firstEntered=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const observations=[];
 f.native.inject=async body=>{observations.push(body.settings.input.nativeSegmentMs);if(observations.length===1){entered();await gate;}return {state:"injected",injectedEvents:2};};
 try {
  const control=await f.owner.execute(request("control.begin"),context);
  const batch=request("input.execute",{controlSessionId:control.controlSessionId,actions:[{type:"text",text:"a"},{type:"text",text:"b"}]});
  const pending=f.owner.execute(batch,context);await firstEntered;selected=createComputerSettingsDefinition(beta,"input-B");release();await pending;
  assert.deepEqual(observations,[16,16]);
  await f.owner.execute(request("input.execute",{controlSessionId:control.controlSessionId,actions:[{type:"text",text:"c"}]}),context);
  assert.equal(observations.at(-1),24);
  let enteredOff,releaseOff;const offEntered=new Promise(resolve=>{enteredOff=resolve;});const offGate=new Promise(resolve=>{releaseOff=resolve;});
  let segments=0;
  f.native.inject=async()=>{segments++;enteredOff();await offGate;return {state:"injected",injectedEvents:2};};
  const offBatch=f.owner.execute(request("input.execute",{controlSessionId:control.controlSessionId,actions:[{type:"text",text:"d"},{type:"text",text:"e"}]}),context);
  await offEntered;raw.features.input=false;releaseOff();
  await offBatch.catch(error=>{assert.equal(error.code,"COMPUTER_FEATURE_DISABLED");});
  assert.equal(segments,1);
 } finally {await f.owner.stop();}
});

test("explicit input off closes active control despite unrelated invalid control and tracking parameters", async () => {
 const f=fixture();
 const original=request("control.begin");
 try {
  const started=await f.owner.execute(original,f.context);
  f.settings.features.input=false;
  f.settings.control.idleTimeoutSeconds="broken";
  f.settings.annotation.tracking.matchThreshold="broken";
  await f.owner.reconcile(f.context);
  assert.equal((await f.owner.execute({action:"control.status",controlSessionId:started.controlSessionId},f.context)).state,"ended");
  const duplicate=await f.owner.execute(original,f.context);
  assert.equal(duplicate.controlSessionId,started.controlSessionId);
  assert.equal(f.native.calls.filter(row=>row.action==="control.begin").length,1);
  assert.equal(f.native.calls.some(row=>row.action==="settings.patch"&&row.body.patch?.annotation?.tracking?.matchThreshold==="broken"),false);
  assert.equal(f.settings.annotation.tracking.matchThreshold,"broken");
 } finally {await f.owner.stop();}
});
test("active control parameter updates contain only schema-defined control fields", async () => {
 const f=fixture();
 try {
  await f.owner.execute(request("control.begin"),f.context);
  f.settings.control.idleTimeoutSeconds=37;
  f.settings.performance.memoryBudgetBytes="broken";
  f.settings.annotation.tracking.matchThreshold="broken";
  await f.owner.reconcile(f.context);
  const applied=f.native.calls.findLast(row=>row.action==="settings.patch");
  assert.ok(applied);
  assert.equal(applied.body.patch.control.idleTimeoutSeconds,37);
  assert.equal(Object.hasOwn(applied.body.patch,"performance"),false);
  assert.equal(Object.hasOwn(applied.body.patch,"annotation"),false);
 } finally {await f.owner.stop();}
});
