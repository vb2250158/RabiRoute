import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import { pendingFeedbackKind, feedbackFocusSelection, filterFeedbackFocusItems } from "../src/planFeedbackFocus";
import type { RolePlan } from "../src/types";

function plan(state = "none", roles = ["informationNeeded"]): RolePlan {
  return { id: "request", presentation: { terminal: false, views: ["plans"], roles, acceptsGuidance: true,
    approval: { state, enabled: state === "ready" } } } as RolePlan;
}
test("pending classification uses Manager roles, not status labels or all guidance-capable plans", () => {
  assert.equal(pendingFeedbackKind(plan()), "information");
  assert.equal(pendingFeedbackKind(plan("none", ["analysis"])), undefined);
  assert.equal(pendingFeedbackKind(plan("ready", ["custom"])), "approval");
  assert.equal(pendingFeedbackKind(plan("incomplete")), undefined);
  assert.equal(pendingFeedbackKind(plan("approved")), undefined);
  const archived = plan("ready");
  archived.presentation.views = ["archived"];
  assert.equal(pendingFeedbackKind(archived), undefined);
  const terminal = plan("ready");
  terminal.presentation.terminal = true;
  assert.equal(pendingFeedbackKind(terminal), undefined);
  const older = plan();
  delete older.presentation.roles;
  assert.equal(pendingFeedbackKind(older), undefined);
});
test("selection remains on submitted or removed request; only user navigation changes it", () => {
  const next = plan(); next.id = "next";
  assert.equal(feedbackFocusSelection("submitted", undefined, [next]), "submitted");
  assert.equal(feedbackFocusSelection("submitted", "next", [next]), "next");
  assert.equal(feedbackFocusSelection("", undefined, [next]), "next");
  assert.equal(feedbackFocusSelection("", undefined, []), "");
});
test("normal and focus layouts share mounted forms and drafts without submitting on toggle", () => {
  const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  assert.match(source, /const feedbackFocusOpen = ref\(false\)/);
  assert.equal((source.match(/Teleport to="#feedback-focus-actions" :disabled="!feedbackFocusActive\(plan\)">\s*<div>/g) ?? []).length, 2);
  assert.equal((source.match(/:actions-target="feedbackFocusActive\(plan\) \? '#feedback-focus-submit' : undefined"/g) ?? []).length, 2);
  assert.doesNotMatch(source, /<div v-if="feedbackFocusActive\(plan\)">/);
  assert.match(source, /@click="approvalEditing\[plan.id\] \? approvalEditing\[plan.id\] = false : openApprovalEditor\(plan\)"/);
  const close = source.slice(source.indexOf("watch(feedbackFocusOpen"), source.indexOf("const feedbackFocusItems"));
  assert.doesNotMatch(close, /approvalDrafts|questionDrafts|resetApproval|sendPlanFeedback|submitPlanFeedback/);
  const open = source.slice(source.indexOf("async function openFeedbackFocus"), source.indexOf("const approvalDrafts"));
  assert.doesNotMatch(open, /sendPlanFeedback|submitPlanFeedback|updateQuestionAnswer/);
});

test("focus search filters available navigation text without changing selection or source records", () => {
  const first = { ...plan(), id: "one", title: "Approve Release", focus: "版本发布" };
  const second = { ...plan(), id: "two", title: "补充需求", nextAction: "确认时间" };
  const items = [first, second];
  assert.deepEqual(filterFeedbackFocusItems(items, " RELEASE "), [first]);
  assert.deepEqual(filterFeedbackFocusItems(items, "确认"), [second]);
  assert.deepEqual(filterFeedbackFocusItems(items, "不存在"), []);
  assert.equal(filterFeedbackFocusItems(items, null), items);
  assert.equal(filterFeedbackFocusItems(items, "  "), items);
  assert.equal(feedbackFocusSelection("one", undefined, filterFeedbackFocusItems(items, "补充")), "one");
  assert.deepEqual(items, [first, second]);
});

test("compact focus switches and search refresh icons replace standalone controls", () => {
  const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/planFeedbackFocus.css", import.meta.url), "utf8");
  assert.doesNotMatch(source + css, /feedback-focus-entry/);
  assert.equal((source.match(/<v-switch[^>]+:label="t\('专注'\)"/g) ?? []).length, 2);
  assert.equal((source.match(/@update:model-value="\$event \? openFeedbackFocus\(\) : feedbackFocusOpen = false"/g) ?? []).length, 2);
  assert.match(source, /v-model="feedbackFocusQuery"/);
  assert.match(source, /filterFeedbackFocusItems\(feedbackFocusItems.value, feedbackFocusQuery.value\)/);
  assert.match(source, /v-for="item in filteredFeedbackFocusItems"/);
  assert.match(source, /:items="filteredFeedbackFocusItems"/);
  assert.equal((source.match(/<template #append-inner>/g) ?? []).length >= 2, true);
  assert.match(source, /v-else class="feedback-refresh-icon"[^>]+:loading="loading \|\| memoryLoading"[^>]+@click="refreshKnowledge"/);
  assert.doesNotMatch(source, /<v-btn block variant="text" :loading="feedbackFocusLoading"/);
  assert.match(source, /@click="feedbackFocusOpen = false"/);
  assert.match(css, /grid-template-columns: max-content minmax\(0, 1fr\)/);
});

test("page and shared questions compile with one submission implementation", () => {
  for (const path of ["pages/RoleKnowledgePage.vue", "components/PlanQuestionFields.vue"]) {
    const source = fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    const { descriptor, errors } = parse(source);
    assert.deepEqual(errors, []);
    assert.doesNotThrow(() => compileScript(descriptor, { id: path, inlineTemplate: true }));
  }
});
test("focus owns only navigation and reuses original drafts, full record carrier and mutation chain", () => {
  const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");
  assert.match(source, /fullscreen eager/);
  assert.match(source, /Teleport to="#feedback-focus-actions"/);
  assert.match(source, /presentation="context"/);
  assert.equal((source.match(/:presentation="feedbackFocusActive\(plan\) \? 'answers' : undefined"/g) ?? []).length, 2);
  assert.match(source, /queueRequest !== feedbackQueueRequest/);
  assert.match(source, /request !== feedbackFocusRequest/);
  assert.match(source, /selectedRoleEpoch === feedbackRoleEpoch/);
  assert.match(source, /if \(!submissionIsCurrent\(\)\) return;\s+const feedbackId = feedbackRequestId/);
  assert.match(source, /plan.detailLevel === "summary" \|\| !draft/);
  assert.match(source, /\[\.\.\.window, selected\]/);
  assert.match(source, /!feedbackInjectedPlanIds.has\(plan.id\)/);
  assert.match(source, /if \(focused\) plans.value = mergeKnowledgePage/);
  assert.equal((source.match(/await submitPlanFeedback\(/g) ?? []).length, 1);
  const select = source.slice(source.indexOf("async function selectFeedbackFocus"), source.indexOf("async function openFeedbackFocus"));
  assert.doesNotMatch(select, /refreshPlanAgentStatuses|openPlanAgent/);
  assert.match(source, /feedbackFocusPlan\?\.presentation.approval.state === 'approved'/);
});
