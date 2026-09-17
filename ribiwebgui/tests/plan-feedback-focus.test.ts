import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
const source = fs.readFileSync(new URL("../src/pages/RoleKnowledgePage.vue", import.meta.url), "utf8");

test("focus is a same-page layout over the existing filtered directory selection", () => {
  assert.doesNotMatch(source, /feedbackQueueCache|feedbackFocusQuery|feedbackInjectedPlanIds|pendingFeedbackKind|fullscreen eager|feedback-focus-shell/);
  assert.match(source, /return source.filter\(matchesQuery\)/);
  assert.match(source, /const feedbackFocusPlan = computed\(\(\) => visiblePlansForView.value.find\(plan => plan.id === activeDirectoryPlanId.value\)\)/);
  assert.match(source, /feedbackFocusPlan.value \? \[feedbackFocusPlan.value\] : \[\]/);
  const open = source.slice(source.indexOf("function openFeedbackFocus"), source.indexOf("const approvalDrafts"));
  assert.doesNotMatch(open, /loadRolePlanPage|activeView.value =|query.value =|planListSelectedTags|planListSortMode|submitPlanFeedback|resetApproval/);
  assert.match(source, /activeDirectoryPlanId.value = visiblePlansForView.value\[0\]\?\.id \|\| ""/);
  assert.match(source, /if \(feedbackFocusOpen.value \|\| directoryJumpTargetId\) return/);
});
test("normal and focus share original forms, drafts and sole feedback submission", () => {
  assert.equal((source.match(/Teleport to="#feedback-focus-actions" :disabled="!feedbackFocusActive\(plan\)">/g) ?? []).length, 2);
  assert.equal((source.match(/:actions-target="feedbackFocusActive\(plan\) \? '#feedback-focus-submit' : undefined"/g) ?? []).length, 2);
  assert.equal((source.match(/:presentation="feedbackFocusActive\(plan\) \? 'answers' : undefined"/g) ?? []).length, 2);
  assert.equal((source.match(/await submitPlanFeedback\(/g) ?? []).length, 1);
  assert.match(source, /plan.detailLevel !== "full" \|\| !draft/);
  assert.match(source, /selectedRoleEpoch === feedbackRoleEpoch/);
  assert.match(source, /expandedPlans\[plan.id\] \|\| feedbackFocusActive\(plan\)/);
  assert.match(source, /!loading.value && plan.detailLevel === "full"/);
});
test("existing search toolbar keeps compact switch and accessible refresh icon", () => {
  assert.equal((source.match(/<v-switch[^>]+:label="t\('专注'\)"/g) ?? []).length, 1);
  assert.match(source, /v-model="query"/);
  assert.match(source, /#append-inner/);
  assert.match(source, /:aria-label="t\('刷新'\)"/);
  assert.ok(source.indexOf('id="feedback-focus-actions"') < source.indexOf('Teleport to="#feedback-focus-actions"'));
  const css = fs.readFileSync(new URL("../src/planFeedbackFocus.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /position: fixed|feedback-focus-shell|feedback-focus-list/);
  assert.match(css, /knowledge-focus-layout/);
  assert.match(css, /feedback-focus-actions:empty/);
});
test("focus reserves independent reading and approval columns within the visible viewport", () => {
  const css = fs.readFileSync(new URL("../src/planFeedbackFocus.css", import.meta.url), "utf8");
  assert.match(source, /class="knowledge-focus-body"/);
  assert.match(source, /window.innerHeight - top - 16/);
  assert.match(source, /watch\(\[feedbackFocusOpen, showsPlanList\]/);
  assert.match(css, /grid-template-columns: minmax\(0, 3fr\) minmax\(320px, 2fr\)/);
  assert.match(css, /height: var\(--feedback-focus-height/);
  assert.match(css, /feedback-focus-actions \{ flex: 1 1 0; min-height: 0; overflow: auto/);
  assert.match(css, /feedback-focus-submit \{ flex: 0 0 auto/);
  assert.match(css, /@container \(max-width: 640px\)/);
  assert.doesNotMatch(css, /max-height: (48|72)%|order: 10/);
});
test("page and shared questions compile", () => {
  for (const path of ["pages/RoleKnowledgePage.vue", "components/PlanQuestionFields.vue"]) {
    const { descriptor, errors } = parse(fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"));
    assert.deepEqual(errors, []);
    assert.doesNotThrow(() => compileScript(descriptor, { id: path, inlineTemplate: true }));
  }
});
