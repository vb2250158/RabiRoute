import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FALLBACK_PLAN_PRESENTATION_PALETTE,
  normalizePlanPresentationPalette,
  planCardStyle,
  planStatusStyle,
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

test("knowledge page avoids full-list refresh after feedback and skips offscreen card rendering", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const submitBody = page.match(/async function sendApprovalSuggestion[\s\S]*?\n}\n<\/script>/)?.[0] || "";

  assert.match(page, /loadPlanFeedback/);
  assert.doesNotMatch(submitBody, /await refreshKnowledge\(\)/);
  assert.doesNotMatch(page, /<v-expand-transition>/);
  assert.match(styles, /\.knowledge-plan-card\s*\{[\s\S]*?content-visibility:\s*auto/);
});

test("paused plans keep the resume step without rendering legacy blocker text", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "src", "pages", "RoleKnowledgePage.vue"), "utf8");

  assert.match(page, /plan\.presentation\.tone !== 'paused' && step\.blockedBy/);
  assert.match(page, /plan\.presentation\.tone !== "paused" && step\.blockedBy \? "已阻塞" : step\.status/);
});
