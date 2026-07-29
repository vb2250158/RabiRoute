import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  hasMoreKnowledgeAfterWindow,
  knowledgeRenderWindow,
  mergeKnowledgePage,
  nextKnowledgeRenderLimit,
  shouldAutoLoadNextKnowledgeBatch
} from "../src/knowledgePagination";

test("progressive knowledge pages append in Manager order and replace duplicate snapshots", () => {
  const merged = mergeKnowledgePage(
    [{ id: "a", value: 1 }, { id: "b", value: 1 }],
    [{ id: "b", value: 2 }, { id: "c", value: 1 }]
  );
  assert.deepEqual(merged, [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
    { id: "c", value: 1 }
  ]);
});

test("memory rendering grows in bounded batches", () => {
  assert.equal(nextKnowledgeRenderLimit(0, 129, 24), 24);
  assert.equal(nextKnowledgeRenderLimit(24, 129, 24), 48);
  assert.equal(nextKnowledgeRenderLimit(120, 129, 24), 129);
});

test("directory jumps do not auto-mount the next knowledge batch", () => {
  assert.equal(shouldAutoLoadNextKnowledgeBatch(true, false), true);
  assert.equal(shouldAutoLoadNextKnowledgeBatch(true, true), false);
  assert.equal(shouldAutoLoadNextKnowledgeBatch(false, false), false);
});

test("directory jumps render a bounded forward window instead of inserting old cards above the target", () => {
  const ids = Array.from({ length: 83 }, (_, index) => index + 1);

  assert.deepEqual(knowledgeRenderWindow(ids, 65, 8), [66, 67, 68, 69, 70, 71, 72, 73]);
  assert.deepEqual(
    knowledgeRenderWindow(ids, 65, 16),
    [66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]
  );
  assert.equal(hasMoreKnowledgeAfterWindow(ids.length, 65, 16), true);
  assert.equal(hasMoreKnowledgeAfterWindow(ids.length, 65, 18), false);
});

test("knowledge page requests bounded plan pages and progressively renders plans and memory", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const client = fs.readFileSync(path.join(root, "src", "roleKnowledgeClient.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(client, /ROLE_PLAN_PAGE_SIZE = 8/);
  assert.match(client, /ROLE_PLAN_BACKGROUND_PAGE_SIZE = 32/);
  assert.match(client, /detail: "summary"/);
  assert.match(client, /\/plans\?\$\{params\.toString\(\)\}/);
  assert.match(page, /const result = await loadRolePlanPage\(selectedRoleId\)/);
  assert.ok(page.indexOf("await loadRolePlanPage(selectedRoleId)") < page.indexOf("await loadRoleMemory(selectedRoleId)"));
  assert.match(page, /if \(planNextCursor\.value\) void loadAllRemainingPlans\(\)/);
  assert.match(page, /MAX_CONCURRENT_PLAN_DETAILS = 2/);
  assert.match(page, /loadRolePlan\(roleId\.value, task\.planId\)/);
  assert.match(page, /function queuePlanDetails\(nextPlans: RolePlan\[\], request: number, priority = false\)/);
  assert.match(page, /\.slice\(0, 2\)/);
  assert.match(page, /rootMargin: "160px 0px"/);
  assert.match(page, /queuePlanDetails\(pendingPlans\.filter\(\(plan\) => visibleIds\.has\(plan\.id\)\), requestVersion, true\)/);
  assert.match(page, /const planRenderLimit = ref\(8\)/);
  assert.match(page, /const planRenderStart = ref\(0\)/);
  assert.match(page, /const renderedPlansForView = computed/);
  assert.match(page, /v-for="plan in renderedPlansForView"/);
  assert.match(page, /planRenderStart\.value = Math\.max\(0, targetIndex\)/);
  assert.match(page, /function releaseDirectoryJumpTarget[\s\S]{0,700}scheduleProgressiveSentinelRefresh\(\)/);
  assert.match(page, /function loadMoreRenderedPlans\(\)/);
  assert.match(page, /hasMorePlans\.value && planPageBackgroundRequest !== requestVersion/);
  assert.match(page, /await loadMorePlans\(ROLE_PLAN_BACKGROUND_PAGE_SIZE\)/);
  assert.match(page, /await yieldToKnowledgePaint\(\)/);
  assert.doesNotMatch(page, /yieldToPlanDetailHydration/);
  assert.doesNotMatch(page, /v-for="\(plan, planIndex\) in visiblePlansForView"/);
  assert.match(page, /v-if="planDetailsLoading\[plan\.id\]" class="knowledge-plan-detail-loading"/);
  assert.match(page, /v-else-if="!planDetailsLoaded\[plan\.id\]" class="knowledge-plan-detail-pending"/);
  assert.doesNotMatch(page, /knowledge-plan-detail-loading[\s\S]{0,600}<v-skeleton-loader/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?content-visibility:\s*auto/);
  assert.match(page, /正在持续加载更多计划/);
  assert.match(page, /正在加载计划详情/);
  assert.match(page, /ref="planLoadMoreSentinel"/);
  assert.match(page, /v-for="memory in renderedMemoryForView"/);
  assert.match(page, /normalizedQuery\.value && planNextCursor\.value/);
  assert.doesNotMatch(page, /query\.value\.trim\(\)/);
});
