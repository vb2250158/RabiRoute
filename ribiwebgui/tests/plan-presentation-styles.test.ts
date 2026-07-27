import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FALLBACK_PLAN_PRESENTATION_PALETTE,
  formatPlanVideoDuration,
  normalizePlanPresentationPalette,
  planCardStyle,
  planDescriptionForDisplay,
  planStatusStyle,
  planTitleForDirectory,
  plansForKnowledgeView
} from "../src/planPresentationStyles";
import type { RolePlan } from "../src/types";

test("plan styles pass through the Manager-owned palette", () => {
  const palette = normalizePlanPresentationPalette({
    accent: "#EF6C52",
    background: "#FFF1ED",
    foreground: "#B42318"
  });

  assert.deepEqual(palette, {
    accent: "#ef6c52",
    background: "#fff1ed",
    foreground: "#b42318"
  });
  assert.deepEqual(planCardStyle(palette), { "--plan-tone": "#ef6c52" });
  assert.deepEqual(planStatusStyle(palette), {
    backgroundColor: "#fff1ed",
    color: "#b42318"
  });
});

test("invalid or missing Manager colors use one neutral compatibility palette", () => {
  assert.deepEqual(
    normalizePlanPresentationPalette({ accent: "red", background: "", foreground: "#123" }),
    FALLBACK_PLAN_PRESENTATION_PALETTE
  );
});

test("knowledge categories consume Manager view membership instead of raw status", () => {
  const plan = {
    id: "plan-1",
    status: "未开始",
    presentation: { views: ["current", "plans"] }
  } as unknown as RolePlan;

  assert.deepEqual(plansForKnowledgeView([plan], "current"), [plan]);
  assert.deepEqual(plansForKnowledgeView([plan], "plans"), [plan]);
  assert.deepEqual(plansForKnowledgeView([plan], "archived"), []);
  assert.deepEqual(plansForKnowledgeView([plan], "recent_memory"), []);
});

test("plan descriptions hide legacy title fallbacks but preserve a real focus", () => {
  assert.equal(planDescriptionForDisplay({ title: "Plan title", focus: "Plan title" }), "");
  assert.equal(planDescriptionForDisplay({ title: "Plan title", focus: "  One focused delivery objective  " }), "One focused delivery objective");
});

test("plan directory titles hide repeated leading bracket tags without changing ordinary titles", () => {
  assert.equal(planTitleForDirectory("[PangHu][Bug] 赛季目标 - 培养道具"), "赛季目标 - 培养道具");
  assert.equal(planTitleForDirectory("  [PangHu] [查询] 月卡配置  "), "月卡配置");
  assert.equal(planTitleForDirectory("普通计划标题"), "普通计划标题");
  assert.equal(planTitleForDirectory("[PangHu]"), "[PangHu]");
});

test("plan video durations use compact player-style timestamps", () => {
  assert.equal(formatPlanVideoDuration(undefined), "--:--");
  assert.equal(formatPlanVideoDuration(Number.NaN), "--:--");
  assert.equal(formatPlanVideoDuration(13.73), "0:14");
  assert.equal(formatPlanVideoDuration(125), "2:05");
  assert.equal(formatPlanVideoDuration(3723), "1:02:03");
});

test("knowledge page avoids full-list refresh after feedback and keeps details animation-free", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const client = fs.readFileSync(path.join(root, "src", "roleKnowledgeClient.ts"), "utf8");
  const submitBody = page.match(/async function sendApprovalSuggestion[\s\S]*?\n}\n<\/script>/)?.[0] || "";

  assert.match(page, /loadPlanFeedback/);
  assert.doesNotMatch(submitBody, /await refreshKnowledge\(\)/);
  assert.doesNotMatch(page, /<v-expand-transition>/);
  assert.match(page, /class="knowledge-plan-focus"/);
  assert.match(page, /<section v-if="isApprovalStep\(plan, step\)" class="knowledge-approval-panel"/);
  assert.doesNotMatch(page, /<section v-if="plan\.presentation\.approval\.state !== 'none'" class="knowledge-approval-panel"/);
  assert.match(styles, /\.knowledge-step \.knowledge-approval-panel\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(page, /@keydown\.enter="handleApprovalEnter\(\$event, plan\)"/);
  assert.match(page, /event\.isComposing[\s\S]*?event\.shiftKey[\s\S]*?event\.preventDefault\(\)/);
  assert.match(page, /:disabled="!canSubmitApproval\(plan\.id\)"/);
  assert.match(page, /@paste="handleApprovalPaste\(plan\.id, \$event\)"/);
  assert.match(page, /function approvalRecordsForDisplay[\s\S]*?return \[\.\.\.records\]\.reverse\(\)/);
  assert.match(page, /v-for="feedback in approvalRecordsForDisplay\(plan\)"/);
  assert.match(page, /class="knowledge-approval-record"/);
  assert.match(page, /expanded && plan\.presentation\.approval\.state !== "none"[\s\S]*?refreshPlanApproval\(plan\.id\)/);
  assert.doesNotMatch(page, /v-if="plan\.approval\.latest" class="knowledge-approval-latest"/);
  assert.match(client, /latest:\s*data\.latest \|\| records\[0\],[\s\S]*?\n\s*records\n/);
  assert.match(styles, /\.knowledge-approval-history\s*\{[\s\S]*?display:\s*grid[\s\S]*?gap:\s*8px/);
  assert.match(styles, /\.knowledge-approval-record\s*\{[\s\S]*?display:\s*grid[\s\S]*?border-left:\s*3px solid/);
  assert.match(page, /openApprovalAttachmentPicker\(plan\.id\)/);
  assert.match(page, /contentBase64: await attachmentContentBase64\(attachment\.file\)/);
  assert.match(page, /submittedApprovalAttachments\.set\(plan\.id, takeApprovalAttachments\(plan\.id\)\)/);
  assert.match(page, /function resetApprovalAttachmentState\(\): void\s*\{/);
  assert.match(page, /onBeforeUnmount\(\(\) => \{[\s\S]*?resetApprovalAttachmentState\(\)/);
  assert.match(styles, /\.knowledge-approval-attachment\s*\{[\s\S]*?grid-template-columns:\s*46px minmax\(0, 1fr\) 28px/);
});

test("plan views expose a floating directory outside the plan browser", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /class="knowledge-browser-layout"/);
  assert.match(page, /class="knowledge-plan-directory"/);
  assert.match(page, /class="knowledge-plan-directory"[\s\S]*?<\/nav>\s*<v-card class="app-card knowledge-browser"/);
  assert.match(page, /v-for="plan in visiblePlansForView"/);
  assert.match(page, /@click="jumpToPlan\(\$event, plan\)"/);
  assert.match(page, /new IntersectionObserver\(scheduleActiveDirectoryPlanSync/);
  assert.match(page, /window\.requestAnimationFrame\(syncActiveDirectoryPlan\)/);
  assert.match(page, /window\.addEventListener\("scroll", scheduleActiveDirectoryPlanSync, \{ passive: true \}\)/);
  assert.match(page, /function holdDirectoryJumpTarget\(planId: string, smooth: boolean\)/);
  assert.match(page, /if \(directoryJumpTargetId\) return;/);
  assert.match(page, /window\.addEventListener\("scroll", waitForDirectoryJumpSettle, \{ passive: true \}\)/);
  assert.match(page, /holdDirectoryJumpTarget\(plan\.id, !reduceMotion\)/);
  assert.match(page, /ref="planDirectoryList"/);
  assert.match(page, /:data-plan-directory-id="plan\.id"/);
  assert.match(page, /:id="planCardDomId\(plan\.id\)"/);
  assert.match(page, /tabindex="-1"/);
  assert.doesNotMatch(page, /knowledge-plan-directory-index/);
  assert.match(page, /class="knowledge-plan-directory-status"/);
  assert.match(page, /planTitleForDirectory\(plan\.title\)/);
  assert.doesNotMatch(page, /knowledge-plan-toc|jumpToPlanStep|planStepDomId|activePlanSteps/);
  assert.match(styles, /\.knowledge-browser-layout\.has-plan-directory\s*\{[\s\S]*?grid-template-columns:\s*minmax\(324px, 360px\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.knowledge-plan-directory\s*\{[\s\S]*?position:\s*sticky[\s\S]*?max-height:\s*calc\(100dvh - 104px\)/);
  assert.match(styles, /\.knowledge-plan-directory-list\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /\.knowledge-plan-cards\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.v-card\.knowledge-browser\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(styles, /\.knowledge-toolbar\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*var\(--v-layout-top, 64px\)[\s\S]*?z-index:\s*6/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?scroll-margin-top:\s*152px/);
  assert.match(styles, /\.knowledge-plan-directory-link\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /\.knowledge-plan-directory-status\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.doesNotMatch(styles, /knowledge-plan-directory-index|knowledge-plan-directory-copy small/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.knowledge-browser-layout\.has-plan-directory\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.knowledge-toolbar\s*\{[\s\S]*?position:\s*static/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.knowledge-plan-directory-link/);
});

test("plan cards use isolated work-item framing and a three-level execution hierarchy", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /v-for="\(plan, planIndex\) in visiblePlansForView"/);
  assert.match(page, /class="knowledge-plan-sequence"/);
  assert.match(page, /class="knowledge-plan-current"/);
  assert.match(page, /class="knowledge-steps-head"/);
  assert.match(page, /currentStepPosition\(plan\)/);
  assert.match(styles, /\.knowledge-plan-cards\s*\{[\s\S]*?gap:\s*18px[\s\S]*?background:\s*#edf2f4/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?border-radius:\s*14px[\s\S]*?box-shadow:/);
  assert.match(styles, /\.knowledge-plan-summary\s*\{[\s\S]*?grid-template-columns:\s*minmax\(280px, 1fr\) max-content/);
  assert.match(styles, /\.knowledge-steps\s*\{[\s\S]*?border-radius:\s*12px[\s\S]*?background:/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?\.knowledge-plan-head\s*\{[\s\S]*?margin:\s*-12px -12px 0/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?\.knowledge-plan-timing\s*\{[\s\S]*?grid-auto-flow:\s*row/);
});

test("plan cards render managed attachments and preview 16:9 image and video media", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(page, /v-if="plan\.attachments\.length" class="knowledge-plan-attachments"/);
  assert.match(page, /import \{ managerEventSource, managerResourceUrl \} from "\.\.\/managerApi"/);
  assert.match(page, /function planAttachmentUrl[\s\S]*?return managerResourceUrl\(/);
  assert.match(page, /planAttachmentUrl\(plan\.id, attachment\.id\)/);
  assert.match(page, /loading="lazy"/);
  assert.match(page, /item\.kind === 'image' \|\| item\.kind === 'video'/);
  assert.match(page, /@click="openPlanMediaPreview\(plan, attachment\)"/);
  assert.match(page, /function planVideoThumbnailUrl[\s\S]*?#t=0\.001/);
  assert.match(page, /v-if="attachment\.kind === 'video'"[\s\S]*?<video/);
  assert.match(page, /@loadedmetadata="capturePlanVideoDuration\(plan\.id, attachment\.id, \$event\)"/);
  assert.match(page, /class="knowledge-plan-video-play"/);
  assert.match(page, /class="knowledge-plan-video-duration"/);
  assert.match(page, /displayedPlanVideoDuration\(plan\.id, attachment\.id\)/);
  assert.match(page, /class="knowledge-plan-media-preview"/);
  assert.match(page, /planAttachmentPreview\?\.kind === 'video'[\s\S]*?controls/);
  assert.match(page, /:model-value="Boolean\(planAttachmentPreview\)"/);
  assert.match(styles, /\.knowledge-plan-attachment\.image\s*\{[\s\S]*?cursor:\s*zoom-in/);
  assert.match(styles, /\.knowledge-plan-attachment\.media\s*\{[\s\S]*?flex:\s*0 1 208px[\s\S]*?width:\s*208px[\s\S]*?max-width:\s*100%/);
  assert.match(styles, /\.knowledge-plan-attachment-visual\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9/);
  assert.match(styles, /\.knowledge-plan-attachment-visual > video\s*\{[\s\S]*?object-fit:\s*contain/);
  assert.match(styles, /\.knowledge-plan-video-play\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*2[\s\S]*?pointer-events:\s*none/);
  assert.match(styles, /\.knowledge-plan-video-duration\s*\{[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*2[\s\S]*?font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(styles, /:hover\s+\.knowledge-plan-video-duration[^}]*\{[^}]*display:\s*(?:none|block)/);
  assert.match(styles, /\.knowledge-plan-media-preview-stage\s*\{[\s\S]*?max-height:\s*78vh/);
  assert.match(styles, /\.knowledge-plan-media-preview-stage video\s*\{[\s\S]*?background:\s*#000/);
});

test("step blocker styling follows Manager presentation instead of raw blockedBy text", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");

  assert.match(page, /function stepIsBlocked[\s\S]*?plan\.presentation\.tone === "blocked"/);
  assert.match(page, /blocked: stepIsBlocked\(plan, step\)/);
  assert.match(page, /stepIsBlocked\(plan, step\) && step\.blockedBy/);
  assert.match(page, /stepIsBlocked\(plan, step\) \? "已阻塞" : step\.status/);
  assert.doesNotMatch(page, /plan\.presentation\.tone !== ['"]paused['"] && step\.blockedBy/);
});

test("plan steps show only the lifecycle time relevant to their current status", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");

  assert.match(page, /step\.status === '进行中' && step\.startedAt[\s\S]*?开始时间[\s\S]*?formatDate\(step\.startedAt\)/);
  assert.match(page, /step\.status === '已完成' && step\.completedAt[\s\S]*?完成时间[\s\S]*?formatDate\(step\.completedAt\)/);
  assert.doesNotMatch(page, /step\.status === '未开始'[\s\S]{0,120}formatDate/);
});
