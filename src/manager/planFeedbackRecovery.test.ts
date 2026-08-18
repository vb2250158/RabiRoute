import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback
} from "../planFeedback.js";
import { createPlan } from "../roleKnowledge.js";
import {
  listOpenPlanFeedbackRecoveryCandidates,
  recoverPlanFeedbackCandidate
} from "./planFeedbackRecovery.js";

function makeRolesRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-feedback-recovery-"));
}

function createCandidateFixture(status: "pending" | "failed" = "pending") {
  const rolesRoot = makeRolesRoot();
  const roleId = "Planner";
  const roleDir = path.join(rolesRoot, roleId);
  fs.mkdirSync(roleDir, { recursive: true });
  const plan = createPlan(roleDir, {
    id: "plan-recovery",
    title: "Recovery plan",
    focus: "Recover interrupted plan feedback",
    status: "进行中",
    currentStepId: "work",
    steps: [{ id: "work", title: "Work", status: "进行中" }],
    keywords: ["recovery"],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000001",
      sessionTitle: "Bound task",
      workspace: "C:\\workspace"
    }
  });
  const pending = createPlanFeedbackRecord({
    id: "feedback-recovery",
    roleId,
    planId: plan.id,
    planTitle: plan.title,
    gatewayId: "planner-main",
    kind: "guidance",
    author: "user",
    source: "webgui",
    text: "Continue after Manager recovery",
    notifyAgent: true
  });
  const feedback = status === "failed"
    ? appendPlanFeedback(roleDir, { ...pending, deliveryStatus: "failed", deliveryMessage: "Manager stopped" })
    : appendPlanFeedback(roleDir, pending);
  return { rolesRoot, roleDir, roleId, plan, feedback };
}

test("startup recovery lists the latest pending or failed plan feedback once", () => {
  const fixture = createCandidateFixture();
  appendPlanFeedback(fixture.roleDir, {
    ...fixture.feedback,
    id: "feedback-delivered",
    deliveryStatus: "delivered"
  });

  const candidates = listOpenPlanFeedbackRecoveryCandidates(fixture.rolesRoot);

  assert.deepEqual(candidates.map((candidate) => candidate.feedback.id), ["feedback-recovery"]);
  assert.equal(candidates[0]?.plan.taskBinding?.sessionId, fixture.plan.taskBinding?.sessionId);
});

test("startup recovery marks an accepted feedback delivered without replay", async () => {
  const fixture = createCandidateFixture();
  const candidate = listOpenPlanFeedbackRecoveryCandidates(fixture.rolesRoot)[0]!;
  let sends = 0;

  const outcome = await recoverPlanFeedbackCandidate(candidate, {
    inspect: async (request) => {
      assert.equal(request.deliveryId, fixture.feedback.id);
      return "accepted";
    },
    schedule: async () => { sends += 1; }
  });

  assert.equal(outcome.state, "delivered");
  assert.equal(sends, 0);
  assert.equal(listPlanFeedback(fixture.roleDir, fixture.plan.id)[0]?.deliveryStatus, "delivered");
});

test("startup recovery accepts a linked guidance response after Desktop history has moved on", async () => {
  const fixture = createCandidateFixture();
  appendPlanFeedback(fixture.roleDir, createPlanFeedbackRecord({
    id: `response-${fixture.feedback.id}`,
    roleId: fixture.roleId,
    planId: fixture.plan.id,
    planTitle: fixture.plan.title,
    kind: "guidance_response",
    author: "agent",
    source: "agent",
    text: "Processed",
    notifyAgent: false
  }));
  const candidate = listOpenPlanFeedbackRecoveryCandidates(fixture.rolesRoot)[0]!;
  let reads = 0;
  let sends = 0;

  const outcome = await recoverPlanFeedbackCandidate(candidate, {
    inspect: async () => { reads += 1; return "missing"; },
    schedule: async () => { sends += 1; }
  });

  assert.equal(outcome.state, "delivered");
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});

test("startup recovery replays a missing feedback once and defers in-progress or unreadable state", async () => {
  const missingFixture = createCandidateFixture("failed");
  const missingCandidate = listOpenPlanFeedbackRecoveryCandidates(missingFixture.rolesRoot)[0]!;
  let sends = 0;
  const missing = await recoverPlanFeedbackCandidate(missingCandidate, {
    inspect: async () => "missing",
    schedule: async () => { sends += 1; }
  });
  assert.equal(missing.state, "scheduled");
  assert.equal(sends, 1);

  const activeFixture = createCandidateFixture();
  const activeCandidate = listOpenPlanFeedbackRecoveryCandidates(activeFixture.rolesRoot)[0]!;
  const active = await recoverPlanFeedbackCandidate(activeCandidate, {
    inspect: async () => "in_progress",
    schedule: async () => { sends += 1; }
  });
  assert.equal(active.state, "deferred");
  assert.equal(sends, 1);

  const unreadable = await recoverPlanFeedbackCandidate(activeCandidate, {
    inspect: async () => { throw new Error("Desktop unavailable"); },
    schedule: async () => { sends += 1; }
  });
  assert.equal(unreadable.state, "deferred");
  assert.equal(sends, 1);
});
