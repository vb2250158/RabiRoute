import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, updatePlan, planUpdatePrimitives } from "./roleKnowledge.js";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-step-time-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plan = createPlan(directory, {
    id: "plan-time-fixture", title: "Timing fixture", keywords: ["fixture"],
    currentStepId: "first", steps: [{ id: "first", title: "First" }, { id: "second", title: "Second" }]
  });
  return { directory, plan };
}

test("changing focus retains the earlier step start without inventing its completion", t => {
  const { directory, plan } = fixture(t);
  const startedAt = plan.steps[0].startedAt;
  assert.ok(startedAt);
  const next = updatePlan(directory, plan.id, { currentStepId: "second", steps: plan.steps });
  assert.equal(next.steps[0].startedAt, startedAt);
  assert.equal(next.steps[0].completedAt, undefined);
  assert.ok(next.steps[1].startedAt);
});

test("an explicit clear still removes the earlier start", t => {
  const { directory, plan } = fixture(t);
  const next = updatePlan(directory, plan.id, {
    currentStepId: "second",
    steps: plan.steps.map(step => step.id === "first" ? { ...step, startedAt: null } : step)
  });
  assert.equal(next.steps[0].startedAt, undefined);
  assert.ok(next.steps[1].startedAt);
});

test("completed step timestamps retain their original values", () => {
  const first = { id: "first", title: "First", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-02T00:00:00.000Z" };
  const next = planUpdatePrimitives.recordPlanStepTimes(
    [first, { id: "second", title: "Second" }], [first], "second", "2026-01-03T00:00:00.000Z"
  );
  assert.deepEqual(next[0], first);
});
