import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  drainKnowledgePages,
  hasMoreKnowledgeAfterWindow,
  hasMoreKnowledgeBeforeWindow,
  knowledgeRenderWindow,
  mergeKnowledgePage,
  nextKnowledgeRenderLimit,
  previousKnowledgeRenderWindow,
  shouldAutoLoadNextKnowledgeBatch
} from "../src/knowledgePagination";
import { knowledgePageShouldWork } from "../src/knowledgePageActivity";

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

test("scrolling upward expands the render window before the current plans", () => {
  assert.equal(hasMoreKnowledgeBeforeWindow(65), true);
  assert.equal(hasMoreKnowledgeBeforeWindow(0), false);
  assert.deepEqual(previousKnowledgeRenderWindow(65, 8, 8), { start: 57, count: 16 });
  assert.deepEqual(previousKnowledgeRenderWindow(3, 8, 8), { start: 0, count: 11 });
});

test("hidden knowledge tabs suspend requests and resume only after becoming visible", () => {
  assert.equal(knowledgePageShouldWork("visible", true), true);
  assert.equal(knowledgePageShouldWork("hidden", true), false);
  assert.equal(knowledgePageShouldWork("visible", false), false);
});

test("visible knowledge pages keep requesting background pages until the active result set is complete", async () => {
  let cursor = "8";
  const requested: string[] = [];
  await drainKnowledgePages({
    nextCursor: () => cursor,
    shouldContinue: () => true,
    yieldToUi: async () => {},
    loadNextPage: async () => {
      requested.push(cursor);
      cursor = cursor === "8" ? "58" : cursor === "58" ? "108" : "";
    }
  });

  assert.deepEqual(requested, ["8", "58", "108"]);
});

test("background knowledge loading stops after a route change or a cursor cannot advance", async () => {
  let cursor = "24";
  let requestVersion = 1;
  let requests = 0;
  await drainKnowledgePages({
    nextCursor: () => cursor,
    shouldContinue: () => requestVersion === 1,
    yieldToUi: async () => {},
    loadNextPage: async () => {
      requests += 1;
      requestVersion += 1;
      cursor = "124";
    }
  });
  assert.equal(requests, 1);

  requestVersion = 1;
  cursor = "124";
  requests = 0;
  await drainKnowledgePages({
    nextCursor: () => cursor,
    shouldContinue: () => requestVersion === 1,
    yieldToUi: async () => {},
    loadNextPage: async () => {
      requests += 1;
    }
  });
  assert.equal(requests, 1);
});

test("knowledge page requests bounded plan pages and progressively renders plans and memory", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const client = fs.readFileSync(path.join(root, "src", "roleKnowledgeClient.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const controlPlaneRoutes = fs.readFileSync(path.join(root, "..", "src", "manager", "controlPlaneRoutes.ts"), "utf8");

  assert.match(client, /ROLE_PLAN_PAGE_SIZE = 8/);
  assert.match(client, /detail: "summary"/);
  assert.match(client, /\/plans\?\$\{params\.toString\(\)\}/);
  assert.match(page, /const planRequestView = computed/);
  assert.match(page, /loadRolePlanPageWithPriorityDetails\(selectedRoleId, "", 8, currentPlanPageFilter\(\), 8\)/);
  const initialPlanPage = page.indexOf('const result = await loadRolePlanPageWithPriorityDetails(selectedRoleId, "", 8, currentPlanPageFilter(), 8)');
  const initialPlanDetails = page.indexOf('const detailPlanIds = new Set(result.detailPlanIds)', initialPlanPage);
  assert.ok(initialPlanPage >= 0 && initialPlanDetails > initialPlanPage);
  assert.match(page, /loadRolePlanPage\(selectedRoleId, cursor, limit, \{[\s\S]{0,180}includeFacets: false/);
  assert.doesNotMatch(controlPlaneRoutes, /response\.end\(JSON\.stringify\(body, null, 2\)\)/);
  assert.match(page, /async function refreshPlanKnowledge\(selectedRoleId: string, currentRequest: number\)/);
  assert.match(page, /async function refreshMemoryKnowledge\(selectedRoleId: string, currentRequest: number\)/);
  assert.match(page, /if \(showsPlanList\.value\) \{\s*await refreshPlanKnowledge\(selectedRoleId, currentRequest\);\s*return;/);
  assert.match(page, /await refreshMemoryKnowledge\(selectedRoleId, currentRequest\);/);
  assert.match(page, /const planError = ref\(""\)/);
  assert.match(page, /const memoryError = ref\(""\)/);
  assert.match(page, /v-if="roleId && showsPlanList && planError"/);
  assert.match(page, /v-if="roleId && showsMemoryList && memoryError"/);
  assert.match(page, /drainKnowledgePages/);
  assert.match(page, /计划目录必须在页面可工作时自动读到 nextCursor 为空；缺失或提前停止属于功能缺陷。/);
  assert.match(page, /function loadAllRemainingPlans\(selectedRoleId: string, currentRequest: number\): void/);
  assert.match(page, /yieldToUi: yieldToKnowledgePaint/);
  assert.match(page, /loadNextPage: \(\) => loadMorePlans\(8, true\)/);
  assert.match(page, /!fromBackground && planPageBackgroundRequest === currentRequest/);
  assert.match(page, /refreshExpandedPlanAgentStatuses\(\);\s*loadAllRemainingPlans\(selectedRoleId, currentRequest\);/);
  assert.match(page, /onBeforeUnmount\(\(\) => \{\s*requestVersion \+= 1;/);
  assert.match(page, /if \(hasMorePlans\.value && !planPageBackgroundRequest\) void loadMorePlans\(\)/);
  assert.match(page, /if \(hasMoreMemory\.value\) void loadMoreMemory\(\)/);
  assert.match(page, /MAX_CONCURRENT_PLAN_DETAILS = 10/);
  assert.match(page, /loadRolePlan\(roleId\.value, task\.planId\)/);
  assert.match(page, /function queuePlanDetails\(nextPlans: RolePlan\[\], request: number, priority = false\)/);
  assert.match(page, /\.slice\(0, 10\)/);
  assert.match(page, /rootMargin: "160px 0px"/);
  assert.match(page, /queuePlanDetails\(pendingPlans\.filter\(\(plan\) => visibleIds\.has\(plan\.id\)\), requestVersion, true\)/);
  assert.match(page, /const planRenderLimit = ref\(8\)/);
  assert.match(page, /const planRenderStart = ref\(0\)/);
  assert.match(page, /const memoryRenderLimit = ref\(24\)/);
  assert.match(page, /loadRoleKnowledgeFileCounts\(selectedRoleId\)/);
  assert.match(page, /loadPendingMemoryConsolidationRunCount\(expectedRoleId\)/);
  assert.doesNotMatch(page, /fetch\(managerResourceUrl\(`\/api\/roles\/\$\{encodeURIComponent\(expectedRoleId\)\}\/memory\/consolidation-runs/);

  assert.match(page, /renderMemoryMarkdownPreview\(memory\.content\)/);
  assert.match(page, /renderMemoryMarkdownPreview\(memoryDetailPreview\.memory\.content\)/);
  assert.match(styles, /\.knowledge-memory-card\s*\{[\s\S]*?max-height:\s*512px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.knowledge-memory-markdown img\s*\{[\s\S]*?max-width:\s*100%;/);
  const currentTab = page.indexOf('value="plans"');
  const recentMemoryTab = page.indexOf('value="recent_memory"');
  const consolidatedMemoryTab = page.indexOf('value="consolidated_memory"');
  const archivedTab = page.indexOf('value="archived"');
  assert.ok(currentTab >= 0 && currentTab < recentMemoryTab && recentMemoryTab < consolidatedMemoryTab && consolidatedMemoryTab < archivedTab);
  assert.match(page, /value="plans"[^>]*>[\s\S]{0,160}t\("当前计划"\)/);
  assert.match(page, /value="consolidated_memory"[^>]*>[\s\S]{0,160}t\("沉淀记忆"\)/);
  assert.match(page, /planPageCounts\.archived \+ memoryPageCounts\.archived/);
  assert.doesNotMatch(page, /<v-btn value="current"/);
  assert.match(page, /const showsMemoryList = computed\(\(\) => \["recent_memory", "consolidated_memory", "archived"\]/);
  assert.doesNotMatch(page, /activeView === 'current' \|\| activeView === 'archived'[\s\S]{0,180}knowledge-memory-heading/);
  assert.match(page, /activeView === 'archived'[\s\S]{0,180}t\("已归档记忆"\)/);
  assert.match(page, /t\("记录时间"\)/);
  assert.match(page, /t\("上次命中召回"\)/);
  assert.match(page, /memory\.recalledAt/);
  assert.match(page, /@click="openMemoryDetail\(memory\)"/);
  assert.match(page, /Boolean\(memoryDetailPreview\)/);
  assert.match(styles, /\.knowledge-memory-card\s*\{[\s\S]*?max-height:\s*512px;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.knowledge-memory-body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(page, /class="knowledge-memory-consolidation-panel"/);
  assert.match(page, /nextMemoryConsolidationTriggerMemory\.title/);
  assert.match(page, /memory\.lifecycle\?\.willEnterNextConsolidation === true/);
  assert.match(page, /memory\.lifecycle\?\.triggersNextConsolidation === true/);
  assert.doesNotMatch(page, /Date\.parse\(memory\.lifecycle\?\.consolidationEligibleAt/);
  assert.match(page, /remaining >= 24 \* 60 \* 60_000/);
  assert.match(page, /距离触发还剩 0 分钟（已到触发时间）/);
  assert.match(page, /已触发，正在沉淀/);
  assert.match(page, /memory_consolidation_changed/);
  assert.match(client, /run\.status === "requested"/);
  assert.doesNotMatch(page, /status === "requested"/);
  assert.match(page, /距离触发还剩 \$\{formatMemoryRemaining\(remaining\)\}/);
  assert.doesNotMatch(page, /已满足 72 小时沉淀触发条件/);
  assert.ok(page.indexOf('class="knowledge-memory-consolidation-panel"') < page.indexOf('v-for="memory in renderedMemoryForView"'));
  assert.match(page, /const renderedPlansForView = computed/);
  assert.match(page, /v-for="plan in renderedPlansForView"/);
  assert.match(page, /planRenderStart\.value = Math\.max\(0, targetIndex\)/);
  assert.match(page, /function releaseDirectoryJumpTarget[\s\S]{0,700}scheduleProgressiveSentinelRefresh\(\)/);
  assert.match(page, /function loadMoreRenderedPlans\(\)/);
  assert.match(page, /function loadMoreRenderedMemory\(\)/);
  assert.match(page, /if \(hasMorePlans\.value && !planPageBackgroundRequest\) void loadMorePlans\(\)/);
  assert.doesNotMatch(page, /yieldToPlanDetailHydration/);
  assert.doesNotMatch(page, /v-for="\(plan, planIndex\) in visiblePlansForView"/);
  assert.match(page, /v-if="planDetailsLoading\[plan\.id\]" class="knowledge-plan-detail-loading"/);
  assert.match(page, /v-else-if="!planDetailsLoaded\[plan\.id\]" class="knowledge-plan-detail-pending"/);
  assert.doesNotMatch(page, /knowledge-plan-detail-loading[\s\S]{0,600}<v-skeleton-loader/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?content-visibility:\s*auto/);
  assert.match(page, /正在持续加载更多计划/);
  assert.match(page, /正在加载计划详情/);
  assert.match(page, /ref="planLoadMoreSentinel"/);
  assert.match(page, /ref="planLoadPreviousSentinel"/);
  assert.match(page, /function loadPreviousRenderedPlans\(\): void/);
  assert.match(page, /knowledgeScrollDirection === "up"/);
  assert.match(page, /window\.scrollBy\(\{ top: nextAnchorTop - anchorTop, behavior: "auto" \}\)/);
  const loadMoreRenderedPlansBlock = page.slice(
    page.indexOf("function loadMoreRenderedPlans(): void"),
    page.indexOf("async function loadMorePlans", page.indexOf("function loadMoreRenderedPlans(): void"))
  );
  const loadMoreRenderedMemoryBlock = page.slice(
    page.indexOf("function loadMoreRenderedMemory(): void"),
    page.indexOf("async function yieldToKnowledgePaint", page.indexOf("function loadMoreRenderedMemory(): void"))
  );
  assert.doesNotMatch(loadMoreRenderedPlansBlock, /scheduleProgressiveSentinelRefresh\(\)/);
  assert.doesNotMatch(loadMoreRenderedMemoryBlock, /scheduleProgressiveSentinelRefresh\(\)/);
  assert.match(page, /watch\(\[hasMorePlans, hasMoreMemory, hasMoreRenderedPlansBefore, hasMoreRenderedPlans, hasMoreRenderedMemory\]/);
  assert.doesNotMatch(page, /watch\(\[planNextCursor, hasMoreMemory\]/);
  assert.match(page, /const memoryNextCursor = ref\(""\)/);
  assert.match(page, /const kind = currentMemoryKind\(\)/);
  assert.match(page, /loadRoleMemoryPage\(selectedRoleId, kind, "", 24, normalizedQuery\.value\)/);
  assert.match(page, /loadRoleMemoryPage\(selectedRoleId, kind, cursor, limit, normalizedQuery\.value\)/);
  assert.doesNotMatch(page, /loadRoleMemory\(selectedRoleId\)/);
  assert.match(page, /knowledgePageShouldWork\(document\.visibilityState, planDirectoryMounted\)/);
  assert.match(page, /document\.addEventListener\("visibilitychange", handleKnowledgeVisibilityChange\)/);
  assert.match(page, /document\.removeEventListener\("visibilitychange", handleKnowledgeVisibilityChange\)/);
  assert.match(page, /v-for="memory in renderedMemoryForView"/);
  assert.match(page, /visibleMemoryForView\.value\.slice\(0, memoryRenderLimit\.value\)/);
  assert.match(page, /列表数据已加载/);
  assert.doesNotMatch(page, /query\.value\.trim\(\)/);
  assert.match(page, /function applyPlanListDialog\(\): void[\s\S]{0,500}planListDialogOpen\.value = false;[\s\S]{0,500}void refreshKnowledge\(\);/);
  assert.match(page, /watch\(\[activeView, query\], \(\) => \{[\s\S]{0,300}requestVersion \+= 1;/);
  assert.doesNotMatch(page, /refreshPlanAgentStatuses\(plans\.value\.map\(\(plan\) => plan\.id\)\)/);
  assert.match(page, /function refreshExpandedPlanAgentStatuses\(\): void \{[\s\S]{0,300}expandedPlans\[plan\.id\][\s\S]{0,300}refreshPlanAgentStatuses\(ids\)/);
  assert.match(page, /function togglePlan\(plan: RolePlan\): void \{[\s\S]{0,300}refreshPlanAgentStatuses\(\[plan\.id\], true\)/);
  assert.doesNotMatch(page, /class="knowledge-plan-directory-working"/);
  assert.match(page, /class="knowledge-plan-directory-sort-label"/);
  assert.match(page, /class="knowledge-plan-agents"/);
  assert.match(page, /会话任务 Agent 已丢失/);
  assert.match(page, /openPlanAgent\(plan, agentRole\)/);
  assert.match(styles, /knowledge-plan-directory-marquee var\(--directory-marquee-duration\) linear/);
  assert.match(styles, /knowledge-plan-agent-spin \.9s linear infinite/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?knowledge-plan-agent-working-icon[\s\S]*?animation: none/);
  assert.match(styles, /\.knowledge-plan-agent-row\s*\{[\s\S]*?min-width:\s*0;/);
});
