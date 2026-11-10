import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ComputerService } from "../lib/computer-service.mjs";
import { DEFAULT_COMPUTER_SETTINGS } from "../lib/computer-control-contract.mjs";

const [targetExecutable, output, qtCommand, qtScript] = process.argv.slice(2);
const target = spawn(targetExecutable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let buffer = ""; const messages = [], waiters = [];
target.stdout.setEncoding("utf8"); target.stderr.resume();
target.stdout.on("data", data => {
  buffer += data;
  for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(message);
    const waiter = waiters.find(item => item.match(message)); if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } }
});
const exited = new Promise(resolve => target.once("close", resolve));
const next = match => new Promise((resolve, reject) => { const old = messages.find(match); if (old) return resolve(old); const waiter = { match, resolve }; waiter.timer = setTimeout(() => reject(new Error("Owned fixture response deadline")), 12000); waiters.push(waiter); });
const ask = (action, body = {}) => { const start = messages.length; target.stdin.write(JSON.stringify({ action, ...body }) + "\n"); return next(message => messages.indexOf(message) >= start && message.action === action); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label, timeout = 6000) { const deadline = Date.now() + timeout; let value; do { value = await read(); if (check(value)) return value; await pause(40); } while (Date.now() < deadline); throw new Error(label + ": " + JSON.stringify(value)); }
const settings = structuredClone(DEFAULT_COMPUTER_SETTINGS); settings.annotation.dynamicEnabled = true; settings.annotation.backend = "template"; settings.performance.maxTargets = 2;
const context = { sourceId: "owned-final-qa", taskId: "owned-final-task", connectionId: "owned-final-connection", getSettings: () => settings };
const service = new ComputerService({ instanceId: "owned-final-target", getSettings: () => settings });
const intent = (action, body = {}) => ({ action, requestId: randomUUID(), ...body });
const proof = { scope: "Owned WinForms source, private ComputerService and candidate native modules only", cases: [] };
let qtService;
try {
  const ready = await next(message => message.eventType === "ready"); proof.target = ready;
  const capture = await service.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context);
  const marker = await ask("marker");
  const box = { x: (marker.x - capture.bounds.x) * capture.width / capture.bounds.width, y: (marker.y - capture.bounds.y) * capture.height / capture.bounds.height,
    width: marker.width * capture.width / capture.bounds.width, height: marker.height * capture.height / capture.bounds.height };
  await ask("move-marker");
  const start = (name, count = 1) => service.execute(intent("annotation.track.start", { layerId: name, source: capture.source, targets: Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}`, description: "seeded QA marker", bounds: box })), taskId: context.taskId, expiresAt: null }), context);
  const a = await start("budget-A"); assert.equal(a.state, "tracking");
  const expectedX = marker.x + 8 - capture.bounds.x;
  assert.ok(Math.abs(a.targets[0].bounds.x - expectedX) < 2, "native startup must relocate the old frame before tracking");
  const b = await start("budget-B", 2); assert.equal(b.state, "paused"); assert.equal(b.targets.length, 2);
  assert.equal((await service.execute({ action: "annotation.track.status", trackingId: a.trackingId }, context)).state, "tracking");
  proof.cases.push({ name: "two-jobs-total-target-budget", passed: true, first: a.trackingId, second: b.trackingId, retainedTargets: b.targets.length });
  settings.annotation.rateHz = 5; settings.annotation.tracking.smoothing = .4; await service.reconcileSettings(context);
  const changed = await until(() => service.execute({ action: "annotation.track.status", trackingId: a.trackingId }, context), value => value.effective?.rateHz === 5 && value.effective?.smoothing === .4, "live settings");
  proof.cases.push({ name: "live-settings-applied", passed: true, effective: changed.effective });
  const c = await start("budget-C"); assert.equal(c.state, "tracking");
  settings.performance.computeBudgetMs = 1; settings.annotation.tracking.maxAnalysisWidth = 320; settings.performance.minAnalysisWidth = 320;
  await service.reconcileSettings(context);
  const readPair = async () => Promise.all([a, c].map(item => service.execute({ action: "annotation.track.status", trackingId: item.trackingId }, context)));
  const degraded = await until(readPair, values => values.some(item => item.effective?.reason?.startsWith("computer-compute-budget")), "aggregate compute budget", 10000);
  proof.cases.push({ name: "aggregate-compute-budget", passed: true, states: degraded.map(item => ({ trackingId: item.trackingId, state: item.state, effective: item.effective, computerBudget: item.computerBudget })) });
  settings.performance.mode = "custom"; await service.reconcileSettings(context);
  const paused = await until(readPair, values => values.some(item => item.state === "paused") && values.some(item => !item.stopped && item.state === "tracking"), "pause is scoped to one job", 10000);
  assert.ok(paused.every(item => item.targets.length === 1)); proof.cases.push({ name: "aggregate-pause-preserves-jobs", passed: true, states: paused.map(item => ({ trackingId: item.trackingId, state: item.state })) });
  settings.performance.computeBudgetMs = 1000; settings.performance.memoryBudgetBytes = 16 * 1024 * 1024; await service.reconcileSettings(context);
  const memory = await until(readPair, values => values.some(item => item.effective?.reason?.startsWith("computer-memory-budget")), "aggregate native process memory", 10000);
  proof.cases.push({ name: "aggregate-memory-budget", passed: true, states: memory.map(item => ({ trackingId: item.trackingId, state: item.state, effective: item.effective, computerBudget: item.computerBudget })) });
  settings.performance = structuredClone(DEFAULT_COMPUTER_SETTINGS.performance); settings.annotation.tracking = structuredClone(DEFAULT_COMPUTER_SETTINGS.annotation.tracking); settings.annotation.rateHz = 10; settings.annotation.staticDurationMs = 200;
  await service.reconcileSettings(context);
  const stopSource = await service.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context);
  const currentMarker = await ask("marker");
  const stop = await service.execute(intent("annotation.track.start", { layerId: "stop-expiry", source: stopSource.source, targets: [{ id: "stop", bounds: { x: (currentMarker.x - stopSource.bounds.x) / 2, y: (currentMarker.y - stopSource.bounds.y) / 2, width: 16, height: 12 } }], taskId: context.taskId }), context);
  await service.execute({ action: "annotation.track.stop", trackingId: stop.trackingId }, context);
  await until(() => service.execute({ action: "annotation.status", layerId: "stop-expiry" }, context), value => ["absent", "cleared"].includes(value.state), "stopped frame static expiry");
  proof.cases.push({ name: "stop-static-expiry", passed: true, configuredMs: 200, defaultMs: DEFAULT_COMPUTER_SETTINGS.annotation.staticDurationMs });
  const layer = await service.execute(intent("annotation.show", { layerId: "move-source", source: stopSource.source, objects: [{ id: "r", type: "rect", bounds: { x: 10, y: 10, width: 30, height: 20 } }], durationMs: null }), context);
  const moved = await ask("move-window");
  await until(() => service.execute({ action: "annotation.status", layerId: layer.layerId }, context), value => value.source?.bounds?.x === moved.x, "static window transform");
  const auxiliary = await ask("aux-open");
  const auxFrame = await service.execute({ action: "screen.capture", windowId: auxiliary.windowId, pid: auxiliary.pid, maxWidth: 320 }, context);
  await service.execute(intent("annotation.show", { layerId: "closed-source", source: auxFrame.source, objects: [{ id: "r", type: "rect", bounds: { x: 10, y: 10, width: 30, height: 20 } }], durationMs: null }), context);
  await ask("aux-close");
  await until(() => service.execute({ action: "annotation.status", layerId: "closed-source" }, context), value => ["absent", "cleared"].includes(value.state), "closed source cleared");
  proof.cases.push({ name: "window-move-and-source-close", passed: true });
  await service.execute({ action: "annotation.clear" }, context); await service.stop();
  if (qtCommand && qtScript) {
    let theme = { theme: "dark", customThemes: [] };
    qtService = new ComputerService({ instanceId: "owned-final-target", getSettings: () => settings, getPresentationTheme: () => theme, qtPresentation: { command: qtCommand, args: [qtScript] } });
    const frame = await qtService.execute({ action: "screen.capture", windowId: ready.windowId, pid: ready.pid, maxWidth: 320 }, context);
    await qtService.execute(intent("annotation.show", { layerId: "theme", source: frame.source, objects: [{ id: "r", type: "rect", bounds: { x: 10, y: 10, width: 30, height: 20 } }], durationMs: null }), context);
    assert.equal(qtService.native.qt.lastShown.theme, "dark");
    theme = { theme: "light", customThemes: [] }; await qtService.setPresentationTheme(theme);
    await until(() => Promise.resolve(qtService.native.qt.lastShown), value => value.theme === "light", "live desktop light theme");
    theme = { theme: "custom:control-fixture", customThemes: [{ id: "custom:control-fixture", colors: { canvas: "#112233", text: "#ddeeff" } }] }; await qtService.setPresentationTheme(theme);
    await until(() => Promise.resolve(qtService.native.qt.lastShown), value => value.theme === "custom:control-fixture", "existing custom theme owner");
    proof.cases.push({ name: "desktop-theme-live-and-custom", passed: true });
    await qtService.execute({ action: "annotation.clear" }, context); await qtService.stop();
  }
  proof.passed = true;
} catch (error) { proof.passed = false; proof.failure = { message: error.message, stack: error.stack }; throw error; }
finally { await service.stop().catch(error => { proof.cleanupError = error.message; }); await qtService?.stop().catch(() => {}); await ask("close").catch(() => {}); target.stdin.end(); await exited; await fs.writeFile(output, JSON.stringify(proof, null, 2)); }
