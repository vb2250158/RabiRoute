import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { drainKnowledgePages } from "../src/knowledgePagination";
const page = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");

test("failed first page cannot show successful empty state or start background requests", async () => {
  const refresh = page.slice(page.indexOf("async function refreshPlanKnowledge"), page.indexOf("async function refreshMemoryKnowledge"));
  assert.match(refresh, /planListReady.value = true/);
  assert.match(refresh, /catch \(loadError\)[\s\S]*!controller.signal.aborted && currentRequest === requestVersion[\s\S]*planError.value = userFacingError\(loadError\);[\s\S]*planListReady.value = false;[\s\S]*return;/);
  assert.match(page, /v-if="planListReady && !planError && !planPageError && !loading/);
  assert.match(page, /knowledgeListWarning \? 'warning' : 'success'/);
  assert.match(page, /knowledgeCountsReady \? planCounts.plans : '—'/);
  assert.match(page, /planEventRefresh.running \|\| !planListReady.value \|\| Boolean\(planError.value\)/);
  assert.match(page, /if \(planError.value \|\| !planListReady.value\) \{ void refreshKnowledge\(\); return; \}/);
  const context = {
    showsPlanList: { value: true }, loading: { value: false }, planListAbort: null,
    AbortController, requestVersion: 1, roleId: { value: "sample" }, planListReady: { value: false },
    planError: { value: "" }, planCatalogInitializing: { value: false },
    currentPlanPageFilter: () => ({}), loadRolePlanPage: async () => { throw new Error("read failed"); },
    userFacingError: (error: Error) => error.message, planEventRefresh: { idle() {} },
    scheduleProgressiveSentinelRefresh() {},
    refreshExpandedPlanAgentStatuses: () => assert.fail("Failure must return before detail reads")
  };
  vm.createContext(context);
  const javascript = ts.transpileModule(refresh, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await vm.runInContext(javascript + '\nrefreshPlanKnowledge("sample", 1)', context);
  assert.equal(context.planListReady.value, false);
  assert.equal(context.planError.value, "read failed");
  assert.equal(context.loading.value, false);
  assert.equal(context.planListAbort, null);
});

test("refresh invalidates old replies even when the new role is empty; counts and plans settle independently", () => {
  const refresh = page.slice(page.indexOf("async function refreshKnowledge"), page.indexOf("watch([activeView, query]"));
  assert.ok(refresh.indexOf("const currentRequest = ++requestVersion") < refresh.indexOf("if (!selectedRoleId)"));
  assert.match(refresh, /currentRequest !== requestVersion \|\| selectedRoleId !== roleId.value\) return;\s*knowledgeCountsReady.value = true/);
  const plan = page.slice(page.indexOf("async function refreshPlanKnowledge"), page.indexOf("async function refreshMemoryKnowledge"));
  assert.match(plan, /currentRequest !== requestVersion \|\| selectedRoleId !== roleId.value\) return;\s*applyPlanSnapshots/);
  assert.doesNotMatch(plan, /knowledgeCountsReady.value = true/);
  assert.doesNotMatch(refresh.slice(refresh.indexOf(".then((counts)"), refresh.indexOf("if (focusedPlanId")), /planListReady.value = true/);
});

test("background error ends the drain after its failed page and retains prior rows", async () => {
  let failed = false;
  let calls = 0;
  const rows = ["previously loaded"];
  await drainKnowledgePages({ nextCursor: () => "next", shouldContinue: () => !failed,
    loadNextPage: async () => { calls++; failed = true; } });
  assert.equal(calls, 1);
  assert.deepEqual(rows, ["previously loaded"]);
});
