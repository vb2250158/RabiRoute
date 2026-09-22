import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import type { PlanItem } from "../roleKnowledge.js";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import { emptyAdvancePolicy, evaluateAdvance, parseAdvancePolicy, PlanAdvanceStore, type AdvanceRule } from "./planAdvancePolicy.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-advance-test-"));
  const workflow = ensurePersonaPlanWorkflow(dir).workflow;
  const status = workflow.roles.execution;
  const plan: PlanItem = { id: "plan-one", title: "Example", focus: "Example", status, archiveStatus: "未归档", currentStepId: "s1", steps: [{ id: "s1", title: "Implement" }], attachments: [], createdAt: "2026-01-01", updatedAt: "2026-01-02", keywords: ["example"], taskBinding: { agentType: "dsh", sessionId: "exact-id", workspace: dir, completionHook: { enabled: false } } };
  const rule: AdvanceRule = { enabled: true, prompt: "Inspect this status", action: "inspect", condition: "changed", cooldownMinutes: 1, maxRunsPerStep: 2 };
  const policy = { ...emptyAdvancePolicy(), enabled: true, rules: { [status]: rule } };
  return { dir, workflow, plan, rule, policy, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("persona keys select distinct prompts without a status enum", () => {
  const f = fixture(); try {
    const custom = { ...f.workflow.statuses.find(item => item.key === f.plan.status)!, key: "review-custom", label: "Custom review" };
    f.workflow.statuses.push(custom); f.plan.status = custom.key;
    f.policy.rules[custom.key] = { ...f.rule, prompt: "Custom instructions" };
    const policy = parseAdvancePolicy(f.policy, f.workflow);
    const item = evaluateAdvance({ ...f, policy, workspace: f.dir, feedback: [], trigger: "manual", now: 100000 });
    assert.equal(item.eligible, true); assert.match(item.prompt, /Custom instructions/); assert.equal(item.label, "Custom review");
    assert.throws(() => parseAdvancePolicy({ ...f.policy, rules: { unknown: f.rule } }, f.workflow), /Invalid status/);
  } finally { f.cleanup(); }
});

test("pause, terminal, foreign workspace and pending approval block implementation", () => {
  const f = fixture(); try {
    const evaluate = () => evaluateAdvance({ ...f, workspace: f.dir, feedback: [], trigger: "startup", now: 100000 });
    f.plan.taskBinding!.workspace = path.join(f.dir, "other"); assert.equal(evaluate().reason, "binding_mismatch");
    f.plan.taskBinding!.workspace = f.dir;
    f.plan.status = f.workflow.roles.paused; f.policy.rules[f.plan.status] = f.rule; assert.equal(evaluate().reason, "inactive_plan");
    f.plan.status = f.workflow.roles.approval; f.policy.rules[f.plan.status] = { ...f.rule, action: "continue" }; assert.equal(evaluate().reason, "approval_gate");
    const feedback = [{ id: "feedback-1", author: "user", createdAt: "2026-01-03" }] as PlanFeedbackRecord[];
    assert.equal(evaluateAdvance({ ...f, workspace: f.dir, feedback, trigger: "manual", now: Date.now() }).reason, "approval_gate");
    f.policy.rules[f.plan.status]!.action = "inspect";
    assert.equal(evaluateAdvance({ ...f, workspace: f.dir, feedback, trigger: "manual", now: Date.now() }).eligible, true);
  } finally { f.cleanup(); }
});

test("settings persist per workspace and reject concurrent stale saves", () => {
  const f = fixture(); try {
    const store = new PlanAdvanceStore(f.dir); const initial = store.policy(f.dir);
    store.save(f.dir, f.policy, initial.revision);
    assert.deepEqual(new PlanAdvanceStore(f.dir).policy(f.dir).policy, f.policy);
    assert.equal(store.policy(path.join(f.dir, "other")).policy.enabled, false);
    assert.throws(() => store.save(f.dir, f.policy, initial.revision), /changed/);
    assert.equal(fs.readdirSync(path.join(f.dir, "plan-advance-history")).length, 1);
  } finally { f.cleanup(); }
});

test("reservations survive restart; accepted fingerprints do not replay", () => {
  const f = fixture(); try {
    const store = new PlanAdvanceStore(f.dir); const receipt = store.reserve(f.dir, f.plan, "first", f.rule, 100000);
    const restarted = new PlanAdvanceStore(f.dir);
    assert.throws(() => restarted.reserve(f.dir, f.plan, "second", f.rule, 200000), /delivery_uncertain/);
    restarted.finish(f.dir, f.plan.id, receipt.id, "accepted");
    assert.throws(() => restarted.reserve(f.dir, f.plan, "first", f.rule, 200000), /already_consumed/);
    assert.throws(() => restarted.reserve(f.dir, f.plan, "second", f.rule, 100001), /cooldown/);
    const second = restarted.reserve(f.dir, f.plan, "second", f.rule, 200000); restarted.finish(f.dir, f.plan.id, second.id, "accepted");
    assert.throws(() => restarted.reserve(f.dir, f.plan, "third", f.rule, 300000), /step_limit/);
    f.plan.currentStepId = "s2"; assert.ok(restarted.reserve(f.dir, f.plan, "third", f.rule, 300000));
  } finally { f.cleanup(); }
});

test("unsent reservations restore prior limits without releasing unknown deliveries", () => {
  const f = fixture(); try {
    const store = new PlanAdvanceStore(f.dir);
    const first = store.reserve(f.dir, f.plan, "first", f.rule, 100000);
    assert.throws(() => store.cancelUnsent(f.dir, f.plan.id, "wrong-id"), /changed/);
    store.cancelUnsent(f.dir, f.plan.id, first.id);
    const accepted = store.reserve(f.dir, f.plan, "first", f.rule, 100000);
    store.finish(f.dir, f.plan.id, accepted.id, "accepted");
    const second = store.reserve(f.dir, f.plan, "second", f.rule, 200000);
    new PlanAdvanceStore(f.dir).cancelUnsent(f.dir, f.plan.id, second.id);
    assert.throws(() => store.reserve(f.dir, f.plan, "first", f.rule, 200000), /already_consumed/);
    const retried = store.reserve(f.dir, f.plan, "second", f.rule, 200000);
    assert.equal(retried.runs, 2);
    store.finish(f.dir, f.plan.id, retried.id, "uncertain");
    assert.throws(() => store.cancelUnsent(f.dir, f.plan.id, retried.id), /changed/);
    assert.throws(() => store.reserve(f.dir, f.plan, "third", f.rule, 300000), /delivery_uncertain/);
  } finally { f.cleanup(); }
});

test("consuming feedback does not itself change the fingerprint", () => {
  const f = fixture(); try {
    const feedback = [{ id: "feedback-1", author: "user", createdAt: "2026-01-03" }] as PlanFeedbackRecord[];
    const base = { ...f, workspace: f.dir, feedback, trigger: "manual" as const, now: Date.now() };
    const first = evaluateAdvance(base);
    const next = evaluateAdvance({ ...base, receipt: { id: "run", fingerprint: first.fingerprint, step: "s1", at: Date.now(), runs: 1, state: "accepted" } });
    assert.equal(next.fingerprint, first.fingerprint); assert.equal(next.reason, "already_consumed");
  } finally { f.cleanup(); }
});
