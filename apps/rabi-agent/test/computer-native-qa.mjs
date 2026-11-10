import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { ComputerService } from "../lib/computer-service.mjs";
import { NativeComputerClient } from "../lib/computer-native-client.mjs";
import { DEFAULT_COMPUTER_SETTINGS } from "../lib/computer-control-contract.mjs";

const [targetExecutable, helperExecutable, output, qtCommand, qtScript] = process.argv.slice(2);
assert.ok(targetExecutable && helperExecutable && output, "Pass explicit private QA target, official candidate helper and output paths.");
const target = spawn(targetExecutable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let buffer = ""; const messages = [], waiters = [];
target.stdout.setEncoding("utf8"); target.stderr.resume();
target.stdout.on("data", data => {
  buffer += data;
  for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const message = JSON.parse(line); messages.push(message);
    const waiter = waiters.find(item => item.match(message)); if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } }
});
const closed = new Promise(resolve => target.once("close", resolve));
const next = match => new Promise((resolve, reject) => { const found = messages.find(match); if (found) return resolve(found); const waiter = { match, resolve }; waiter.timer = setTimeout(() => reject(new Error("Owned QA target did not respond.")), 10000); waiters.push(waiter); });
const ask = async (action, body = {}) => { const start = messages.length; target.stdin.write(JSON.stringify({ action, ...body }) + "\n"); return next(message => messages.indexOf(message) >= start && message.action === action); };
const settings = structuredClone(DEFAULT_COMPUTER_SETTINGS);
const context = { sourceId: "owned-native-qa", sourceLabel: "隔离电脑控制验收", getSettings: () => settings };
const service = new ComputerService({ instanceId: "owned-native-qa-target", getSettings: () => settings,
  nativeFactory: options => new NativeComputerClient({ ...options, executable: helperExecutable, args: [] }) });
const intent = (action, body = {}) => ({ action, requestId: randomUUID(), ...body });
const proof = { scope: "Only the newly created QA window and this candidate helper; no installed service or business application calls.", assertions: [] };
try {
  const ready = await next(message => message.eventType === "ready");
  proof.target = ready; const focused = await ask("focus");
  const capture = await service.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context);
  assert.ok(capture.frameId); assert.equal(capture.source.instanceId, "owned-native-qa-target");
  proof.frame = { frameId: capture.frameId, width: capture.width, height: capture.height, bounds: capture.bounds, sha256: createHash("sha256").update(Buffer.from(capture.data, "base64")).digest("hex") };
  const source = capture.source;
  const pixel = point => ({ x: (point.x - capture.bounds.x) * capture.width / capture.bounds.width, y: (point.y - capture.bounds.y) * capture.height / capture.bounds.height });
  const begin = await service.execute(intent("control.begin"), context); assert.equal(begin.state, "active");
  const session = begin.controlSessionId;
  proof.helperPid = service.native.child.pid;
  const watched = await ask("watch", { pid: service.native.child.pid }); assert.equal(watched.wait, 258); proof.originalHelperHandle = watched;
  if (!focused.foreground) {
    const point = await ask("activation-point", { helperPid: service.native.child.pid }); proof.activationCheck = point; assert.equal(point.owned, true);
    await service.execute(intent("input.execute", { controlSessionId: session,
      source: { instanceId: "owned-native-qa-target", kind: "desktop", coordinateSpace: "desktop" }, actions: [{ type: "click", x: point.x, y: point.y }] }), context);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await ask("status")).foreground, true); proof.activation = { mode: "verified-self-window-click", owned: point.owned };
  }
  const text = "甲乙 Rabi\n!☕";
  const batch = intent("input.execute", { controlSessionId: session, source, actions: [{ type: "click", ...pixel(ready.text) }, { type: "text", text }, { type: "click", ...pixel(ready.button) }] });
  const result = await service.execute(batch, context); assert.equal(result.state, "injected");
  await new Promise(resolve => setTimeout(resolve, 100));
  const state = await ask("status"); assert.equal(state.text.replaceAll("\r\n", "\n"), text); assert.equal(state.clicks, 1);
  await service.execute(batch, context); assert.equal((await ask("status")).clicks, 1);
  proof.assertions.push("real Unicode input, mapped capture click and same-ID non-replay");
  const drag = intent("input.execute", { controlSessionId: session, source, actions: [{ type: "drag", ...pixel(ready.panel), toX: pixel(ready.panel).x + 30, toY: pixel(ready.panel).y + 10, durationMs: 500 }] });
  const dragging = service.execute(drag, context); await new Promise(resolve => setTimeout(resolve, 120));
  await service.native.request("input.cancel", { requestId: batch.requestId, controlSessionId: "an-ended-original-session" });
  assert.equal((await dragging).state, "injected");
  const dragged = await ask("status"); assert.equal(dragged.ups, 1); assert.ok(dragged.upAt - dragged.downAt >= 400);
  proof.assertions.push("stale cancellation cannot release a new drag's mouse button");
  const layer = await service.execute(intent("annotation.show", { layerId: "qa-shapes", source, durationMs: null, objects: [{ id: "rect", type: "rect", bounds: { x: 10, y: 20, width: 100, height: 30 } }, { id: "text", type: "text", bounds: { x: 10, y: 60, width: 100, height: 20 }, text: "隔离测试" }] }), context);
  assert.equal(layer.state, "visible");
  const button = await ask("exit-button", { pid: service.native.child.pid }); assert.equal(button.invoked, true);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await service.execute({ action: "control.status", controlSessionId: session }, context)).state, "ended");
  proof.assertions.push("actual owned exit button ends native control");
  const urgentControl = await service.execute(intent("control.begin"), context);
  const urgentDrag = service.execute(intent("input.execute", { controlSessionId: urgentControl.controlSessionId, source,
    actions: [{ type: "drag", ...pixel(ready.panel), toX: pixel(ready.panel).x + 20, toY: pixel(ready.panel).y, durationMs: 2000 }] }), context);
  const dragOutcome = urgentDrag.then(result => ({ result }), error => ({ error: { code: error.code, uncertain: error.uncertain } }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const originalRequest = service.native.request.bind(service.native);
  let releaseCaptures, nativeCaptureCompletions = 0;
  const captureCompletionGate = new Promise(resolve => { releaseCaptures = resolve; });
  const releaseTimer = setTimeout(releaseCaptures, 2000);
  service.native.request = async (action, body, options) => {
    const result = await originalRequest(action, body, options);
    if (action === "screen.capture") { nativeCaptureCompletions++; await captureCompletionGate; }
    return result;
  };
  let unfinished = 18;
  const captures = Array.from({ length: 18 }, () => service.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context).finally(() => { unfinished--; }));
  const captured = Promise.allSettled(captures);
  await new Promise(resolve => setTimeout(resolve, 40));
  const exitStart = performance.now();
  await service.execute({ action: "control.end", controlSessionId: urgentControl.controlSessionId }, context);
  const exitMs = performance.now() - exitStart;
  const released = await ask("async-state");
  assert.equal(released.leftDown, false); assert.ok(unfinished > 0); assert.ok(exitMs < 750, `API exit waited behind capture work: ${exitMs}ms`);
  const pendingWhenEnded = unfinished;
  const cancelled = await dragOutcome; assert.equal(cancelled.result?.state, "cancelled");
  releaseCaptures(); clearTimeout(releaseTimer); await captured;
  service.native.request = originalRequest;
  proof.apiExitDuringCapture = { scope: "Controlled JS/API capture-completion broker delay; not a real hung PrintWindow", exitMs, concurrentCaptures: 18, nativeCaptureCompletions, pendingCapturesWhenEnded: pendingWhenEnded, actualLeftButtonUpBeforeBrokerRelease: !released.leftDown, result: cancelled.result.state };
  proof.assertions.push("API control.end releases the owned button while broker-delayed capture completions are pending");
  await service.execute({ action: "annotation.clear" }, context);
  await service.stop(); assert.equal((await ask("wait")).wait, 0); proof.assertions.push("original helper HANDLE is signaled when stop returns");
  if (qtCommand && qtScript) {
    const full = new ComputerService({ instanceId: "owned-native-qa-target", getSettings: () => settings, qtPresentation: { command: qtCommand, args: [qtScript] } });
    try {
      await ask("focus");
      const frame = await full.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context);
      const control = await full.execute(intent("control.begin"), context);
      assert.equal(control.state, "active");
      const nativePid = full.native.child.pid, qtPid = full.native.qt.child.pid;
      proof.fullHostHandles = [await ask("watch", { pid: nativePid }), await ask("watch", { pid: qtPid })];
      assert.equal(full.native.qt.lastShown.nativeVisible, true);
      assert.equal(full.native.qt.lastShown.captureExcluded, true);
      const held = await ask("hold-shift");
      if (!held.alreadyHeld) {
        assert.equal(held.injectedEvents, 1); await new Promise(resolve => setTimeout(resolve, 60));
        await full.execute(intent("input.execute", { controlSessionId: control.controlSessionId, source: frame.source, actions: [{ type: "key", keys: ["Shift"] }] }), context);
        await full.execute({ action: "control.end", controlSessionId: control.controlSessionId }, context);
        assert.equal((await ask("status")).heldShift, true);
        assert.equal((await ask("release-shift")).injectedEvents, 1);
        proof.assertions.push("control cleanup does not release an independently held Shift key");
      } else proof.independentShift = "already physically held; no test injection performed";
      const nextControl = await full.execute(intent("control.begin"), context);
      const point = pixel(ready.panel);
      const pending = full.execute(intent("input.execute", { controlSessionId: nextControl.controlSessionId, source: frame.source,
        actions: [{ type: "drag", x: point.x, y: point.y, toX: point.x + 40, toY: point.y, durationMs: 2000 }] }), context);
      const observed = pending.then(result => ({ result }), error => ({ error: { code: error.code, uncertain: error.uncertain } }));
      await new Promise(resolve => setTimeout(resolve, 120));
      await full.native.close();
      const outcome = await observed; proof.pipeEofOutcome = outcome;
      assert.ok(outcome.result?.state === "cancelled" || outcome.error?.uncertain === true, "EOF may acknowledge cancellation or leave the original input uncertain, never claim injected/failed without that fact");
      const ended = await ask("status"); assert.equal(ended.downs, ended.ups);
      proof.fullHostHandleExit = [await ask("wait", { pid: nativePid }), await ask("wait", { pid: qtPid })];
      assert.ok(proof.fullHostHandleExit.every(item => item.wait === 0));
      proof.assertions.push("pipe EOF during drag releases the owned button; native and Qt original HANDLEs are signaled");
    } finally { await ask("release-shift").catch(() => {}); await full.stop(); }
  }
  proof.passed = true; await fs.writeFile(output, JSON.stringify(proof, null, 2));
} catch (error) {
  proof.passed = false; proof.failure = { name: error.name, message: error.message, stack: error.stack };
  await fs.writeFile(output, JSON.stringify(proof, null, 2)); throw error;
} finally {
  await service.stop().catch(error => { proof.cleanupError = error.message; });
  if (proof.originalHelperHandle) proof.helperWaitAfterCleanup = (await ask("wait", { pid: proof.helperPid })).wait;
  await fs.writeFile(output, JSON.stringify(proof, null, 2));
  await ask("close").catch(() => {}); target.stdin.end(); await closed;
}
