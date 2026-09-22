import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
const start = source.indexOf("async function refreshPlansFromEvent(");
const end = source.indexOf("function connectManagerEvents", start);
assert.ok(start >= 0 && end > start, "event refresh implementation must exist");
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(load: (...args: unknown[]) => Promise<unknown>) {
  const ref = (value: unknown) => ({ value });
  const state = {
    knowledgePageWorkAllowed: () => true, roleId: ref("example"), requestVersion: 1,
    focusedPlanId: ref(""), currentPlanPageFilter: () => ({}), loadRolePlanPage: load,
    plans: ref([{ id: "old" }]), planPageCounts: ref({}), planListResultTotal: ref(1),
    planListStatusOptions: ref([]), planListTagOptions: ref([]), planNextCursor: ref(""),
    planListReady: ref(true), planPageError: ref(""), planError: ref(""),
    planEventReset: ref(false), planRenderStart: ref(0), planRenderLimit: ref(8),
    applyPlanSnapshots(items: unknown[]) { state.plans.value = items; },
    schedulePlanDetailObserverRefresh() {}, signal: new AbortController().signal
  };
  const context = vm.createContext(state);
  vm.runInContext(code, context);
  return { state, refresh: () => vm.runInContext("refreshPlansFromEvent(signal)", context) as Promise<void> };
}

test("event refresh reads only the first page and retains its cursor", async () => {
  const calls: unknown[][] = [];
  const h = harness(async (...args) => {
    calls.push(args);
    return { items: [{ id: "first" }], nextCursor: "next", total: 100, counts: {} };
  });
  await h.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "");
  assert.equal(calls[0][2], 8);
  assert.equal(h.state.planNextCursor.value, "next");
  assert.equal(h.state.planEventReset.value, true);
});

test("failed first page retains previous rows", async () => {
  const h = harness(async () => { throw new Error("offline"); });
  await assert.rejects(h.refresh(), /offline/);
  assert.equal((h.state.plans.value as { id: string }[])[0].id, "old");
});

test("role switches fence an in-flight event snapshot", async () => {
  let resolve!: (value: unknown) => void;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const refresh = h.refresh();
  h.state.roleId.value = "other";
  resolve({ items: [{ id: "wrong" }], nextCursor: "", counts: {} });
  await refresh;
  assert.equal((h.state.plans.value as { id: string }[])[0].id, "old");
});
