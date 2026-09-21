import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createBoundedPlanRefresh } from "../src/boundedPlanRefresh";
import { loadRolePlanPage } from "../src/roleKnowledgeClient";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("100000 rows and a nonempty next cursor still refresh one page; bursts retain only one pending request", async () => {
  let calls = 0; let active = 0; let peak = 0;
  const releases: Array<() => void> = [];
  const gate = createBoundedPlanRefresh({ allowed: () => true, busy: () => false,
    refresh: async () => { calls++; active++; peak = Math.max(peak, active); await new Promise<void>(r => releases.push(r)); const page = { total: 100000, nextCursor: "more" }; assert.equal(page.nextCursor, "more"); active--; }, failed: () => assert.fail() });
  gate.request(); gate.idle();
  for (let i = 0; i < 100; i++) { gate.request(); gate.idle(); }
  assert.equal(calls, 1);
  releases.shift()!(); await tick(); gate.idle();
  assert.equal(calls, 2); assert.equal(peak, 1);
  releases.shift()!(); await tick(); gate.cancel();
});

test("busy page queues one event; hiding aborts and showing resumes once without surfacing AbortError", async () => {
  let visible = true; let busy = true; let calls = 0; let failures = 0; let signal: AbortSignal | undefined;
  const gate = createBoundedPlanRefresh({ allowed: () => visible, busy: () => busy,
    refresh: s => { calls++; signal = s; return new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("AbortError")), { once: true })); }, failed: () => failures++ });
  gate.request(); gate.idle(); assert.equal(calls, 0);
  busy = false; gate.idle(); assert.equal(calls, 1);
  visible = false; gate.cancel(true); assert.equal(signal?.aborted, true); await tick();
  assert.equal(failures, 0); visible = true; gate.idle(); assert.equal(calls, 2);
  gate.cancel(); await tick();
});

test("failure keeps displayed data and does not retry without a new event", async () => {
  const rows = ["previous"];
  let calls = 0; let failures = 0;
  const gate = createBoundedPlanRefresh({ allowed: () => true, busy: () => false,
    refresh: async () => { calls++; throw new Error("timeout"); }, failed: () => failures++ });
  gate.request(); gate.idle(); await tick(); gate.idle();
  assert.equal(calls, 1); assert.equal(failures, 1); assert.deepEqual(rows, ["previous"]); gate.cancel();
});

test("caller abort reaches fetch and does not cancel another page request", async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
    const signal = init.signal!; signals.push(signal);
    return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const first = new AbortController(); const second = new AbortController();
  const a = loadRolePlanPage("sample", "", 8, {}, first.signal);
  const b = loadRolePlanPage("sample", "next", 50, {}, second.signal);
  first.abort(); await assert.rejects(a, /cancelled/);
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  second.abort(); await assert.rejects(b, /cancelled/);
});

test("actual visibility callback closes SSE and aborts before returning; visible callback only resumes bounded pending work", () => {
  const page = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  const source = page.slice(page.indexOf("function disconnectManagerEvents"), page.indexOf("function scheduleMemoryClockDeadline"))
    + page.slice(page.indexOf("function handleKnowledgeVisibilityChange"), page.indexOf("function activateKnowledgePage"));
  const controller = new AbortController();
  let closed = 0; let resumed = 0;
  const context = { document: { visibilityState: "hidden" }, planDirectoryMounted: true,
    knowledgePageShouldWork: (s: string) => s === "visible",
    cancelPlanListWork: () => controller.abort(), managerEvents: { close: () => closed++ },
    planPageObserver: null, memoryPageObserver: null, planDetailObserver: null,
    memoryClockTimer: 0, window: { clearTimeout }, memoryClock: { value: 0 },
    connectManagerEvents() {}, scheduleMemoryClockDeadline() {}, schedulePlanCardObserverRefresh() {},
    schedulePlanDetailObserverRefresh() {}, scheduleProgressiveSentinelRefresh() {}, planEventRefresh: { idle: () => resumed++ } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nhandleKnowledgeVisibilityChange();", context);
  assert.equal(controller.signal.aborted, true); assert.equal(closed, 1); assert.equal(resumed, 0);
  context.document.visibilityState = "visible"; vm.runInContext("handleKnowledgeVisibilityChange()", context); assert.equal(resumed, 1);
});

test("component uses one bounded event page and fences role/filter/abort; client forwards cancellation", () => {
  const page = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/roleKnowledgeClient.ts", import.meta.url), "utf8");
  const event = page.slice(page.indexOf("async function refreshPlansFromEvent"), page.indexOf("function connectManagerEvents"));
  assert.equal((event.match(/await loadRolePlanPage/g) || []).length, 1);
  assert.doesNotMatch(page, /loadAllRemainingPlans|drainKnowledgePages|while \(cursor/);
  assert.match(event, /fingerprint === JSON.stringify/);
  assert.match(event, /!signal.aborted && request === requestVersion/);
  assert.match(event, /planNextCursor.value = result.nextCursor/);
  assert.match(client, /filter: RolePlanPageFilter = \{\},\s*signal\?: AbortSignal/);
  assert.match(client, /plans\?\$\{params.toString\(\)\}`\s*, \{ signal \}/);
});
