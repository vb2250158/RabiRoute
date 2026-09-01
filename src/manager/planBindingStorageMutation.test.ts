import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, PlanTaskBinding } from "../roleKnowledge.js";
import {
  ensurePlanSecretaryBindingForEvent,
  replacePlanSecretaryBindingForEvent,
  replacePlanTaskBindingForDelivery
} from "./planBindingStorageMutation.js";
import {
  RoleStorageApplicationError,
  roleStorageOperationKey,
  type RoleStorageApplication,
  type RoleStoragePlanProjection
} from "./roleStorageApplication.js";

function planWithBinding(binding: PlanTaskBinding): PlanItem {
  return {
    id: "plan-one",
    title: "Plan one",
    focus: "Exercise exact CAS",
    status: "进行中",
    currentStepId: "step-one",
    steps: [{ id: "step-one", title: "Step one", status: "进行中" }],
    keywords: ["cas"],
    taskBinding: binding,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  } as PlanItem;
}

function storageHarness(initial: PlanItem) {
  let plan = initial;
  let revisionNumber = 1;
  const calls: Array<{ key: string; revision: string; binding: PlanTaskBinding | null }> = [];
  const projection = (): RoleStoragePlanProjection => ({
    plan,
    revision: `inventory-${revisionNumber}`,
    approval: { count: 0 }
  });
  const storage = {
    queries: {
      plan: async () => projection()
    },
    commands: {
      updatePlanTaskBinding: async (_roleId: string, _planId: string, binding: PlanTaskBinding | null, context: { idempotencyKey?: string; expectedRevision?: string | null }) => {
        calls.push({ key: String(context.idempotencyKey), revision: String(context.expectedRevision), binding });
        plan = { ...plan, taskBinding: binding ?? undefined };
        revisionNumber += 1;
        return { projection: projection() };
      }
    }
  } as unknown as Pick<RoleStorageApplication, "queries" | "commands">;
  return {
    storage,
    calls,
    projection,
    setPlan: (next: PlanItem) => { plan = next; revisionNumber += 1; },
    setTaskCommand: (command: typeof storage.commands.updatePlanTaskBinding) => {
      (storage.commands as { updatePlanTaskBinding: typeof command }).updatePlanTaskBinding = command;
    }
  };
}

test("task binding CAS uses exact revisions and distinct A-to-B-to-A business keys", async () => {
  const a: PlanTaskBinding = { agentType: "codex", sessionId: "session-a", sessionTitle: "A", workspace: "C:\\work" };
  const harness = storageHarness(planWithBinding(a));
  await replacePlanTaskBindingForDelivery(harness.storage, {
    roleId: "YeYu",
    planId: "plan-one",
    deliveryId: "delivery-a-b",
    oldSessionId: "session-a",
    resolved: { id: "session-b", title: "B", cwd: "C:\\work" }
  });
  await replacePlanTaskBindingForDelivery(harness.storage, {
    roleId: "YeYu",
    planId: "plan-one",
    deliveryId: "delivery-b-a",
    oldSessionId: "session-b",
    resolved: { id: "session-a", title: "A", cwd: "C:\\work" }
  });

  assert.deepEqual(harness.calls.map(call => call.revision), ["inventory-1", "inventory-2"]);
  assert.equal(harness.calls[0]?.key, roleStorageOperationKey(
    "plan-task-binding-replace", "delivery-a-b", "session-a", "session-b", "plan-one"
  ));
  assert.equal(harness.calls[1]?.key, roleStorageOperationKey(
    "plan-task-binding-replace", "delivery-b-a", "session-b", "session-a", "plan-one"
  ));
  assert.notEqual(harness.calls[0]?.key, harness.calls[1]?.key);
});

test("task binding lost response replays the exact operation key and payload", async () => {
  const a: PlanTaskBinding = { agentType: "codex", sessionId: "session-a", workspace: "C:\\work" };
  const harness = storageHarness(planWithBinding(a));
  let first = true;
  const replayed: Array<{ key: string; revision: string; binding: PlanTaskBinding | null }> = [];
  harness.setTaskCommand(async (_roleId, _planId, binding, context) => {
    assert.ok(context);
    replayed.push({ key: String(context.idempotencyKey), revision: String(context.expectedRevision), binding });
    if (first) {
      first = false;
      throw new RoleStorageApplicationError("projection lost", "projection_unavailable", 503, context.idempotencyKey, "committed");
    }
    return { projection: { ...harness.projection(), plan: { ...harness.projection().plan, taskBinding: binding ?? undefined } } } as never;
  });
  await replacePlanTaskBindingForDelivery(harness.storage, {
    roleId: "YeYu",
    planId: "plan-one",
    deliveryId: "delivery-lost",
    oldSessionId: "session-a",
    resolved: { id: "session-b", cwd: "C:\\work" }
  });
  assert.equal(replayed.length, 2);
  assert.deepEqual(replayed[0], replayed[1]);
});

test("task binding 412 requeries exact revision and stops when the old condition changed", async () => {
  const a: PlanTaskBinding = { agentType: "codex", sessionId: "session-a", workspace: "C:\\work" };
  const harness = storageHarness(planWithBinding(a));
  let first = true;
  const attempted: string[] = [];
  harness.setTaskCommand(async (_roleId, _planId, _binding, context) => {
    assert.ok(context);
    attempted.push(String(context.expectedRevision));
    if (first) {
      first = false;
      harness.setPlan(planWithBinding({ agentType: "codex", sessionId: "session-c", workspace: "C:\\work" }));
      throw new RoleStorageApplicationError("stale", "revision_conflict", 412, context.idempotencyKey);
    }
    throw new Error("must not write after the old binding condition changed");
  });
  const result = await replacePlanTaskBindingForDelivery(harness.storage, {
    roleId: "YeYu",
    planId: "plan-one",
    deliveryId: "delivery-stale",
    oldSessionId: "session-a",
    resolved: { id: "session-b", cwd: "C:\\work" }
  });
  assert.deepEqual(attempted, ["inventory-1"]);
  assert.equal(result.taskBinding?.sessionId, "session-c");
});

test("task binding 412 retries the same business key and payload against the refreshed revision", async () => {
  const a: PlanTaskBinding = { agentType: "codex", sessionId: "session-a", workspace: "C:\\work" };
  const harness = storageHarness(planWithBinding(a));
  let first = true;
  const attempted: Array<{ key: string; revision: string; binding: PlanTaskBinding | null }> = [];
  harness.setTaskCommand(async (_roleId, _planId, binding, context) => {
    assert.ok(context);
    attempted.push({ key: String(context.idempotencyKey), revision: String(context.expectedRevision), binding });
    if (first) {
      first = false;
      harness.setPlan({ ...harness.projection().plan, nextAction: "concurrent unrelated update" });
      throw new RoleStorageApplicationError("stale", "revision_conflict", 412, context.idempotencyKey);
    }
    return { projection: { ...harness.projection(), plan: { ...harness.projection().plan, taskBinding: binding ?? undefined } } } as never;
  });
  await replacePlanTaskBindingForDelivery(harness.storage, {
    roleId: "YeYu",
    planId: "plan-one",
    deliveryId: "delivery-refresh",
    oldSessionId: "session-a",
    resolved: { id: "session-b", cwd: "C:\\work" }
  });
  assert.deepEqual(attempted.map(item => item.revision), ["inventory-1", "inventory-2"]);
  assert.equal(attempted[0]?.key, attempted[1]?.key);
  assert.deepEqual(attempted[0]?.binding, attempted[1]?.binding);
});

test("secretary assignment and resolution use stable event identities over exact projections", async () => {
  let plan: PlanItem = { ...planWithBinding({ agentType: "codex", sessionId: "task", workspace: "C:\\work" }), secretaryBinding: undefined };
  let revision = 1;
  const calls: Array<{ key: string; revision: string }> = [];
  const storage = {
    queries: {
      plan: async () => ({ plan, revision: `inventory-${revision}`, approval: { count: 0 } })
    },
    commands: {
      updatePlanSecretaryBinding: async (_roleId: string, _planId: string, binding: PlanItem["secretaryBinding"], context: { idempotencyKey?: string; expectedRevision?: string | null }) => {
        calls.push({ key: String(context.idempotencyKey), revision: String(context.expectedRevision) });
        plan = { ...plan, secretaryBinding: binding ?? undefined };
        revision += 1;
        return { projection: { plan, revision: `inventory-${revision}`, approval: { count: 0 } } };
      }
    }
  } as unknown as Pick<RoleStorageApplication, "queries" | "commands">;
  const assigned = await ensurePlanSecretaryBindingForEvent(storage, {
    roleId: "YeYu",
    planId: "plan-one",
    eventId: "feedback:feedback-one",
    sessions: [{ threadId: "secretary-a", threadName: "Secretary A", workspace: "C:\\work", index: 1 }]
  });
  assert.equal(assigned.plan.secretaryBinding?.sessionId, "secretary-a");
  assert.equal(calls[0]?.key, roleStorageOperationKey(
    "plan-secretary-assignment", "feedback:feedback-one", "unassigned", "secretary-a", "plan-one"
  ));
  await replacePlanSecretaryBindingForEvent(storage, {
    roleId: "YeYu",
    planId: "plan-one",
    eventId: "completion:task:turn-one",
    oldSessionId: "secretary-a",
    binding: { ...assigned.plan.secretaryBinding!, sessionId: "secretary-b", sessionTitle: "Secretary B" }
  });
  assert.equal(calls[1]?.key, roleStorageOperationKey(
    "plan-secretary-resolution", "completion:task:turn-one", "secretary-a", "secretary-b", "plan-one"
  ));
  assert.deepEqual(calls.map(call => call.revision), ["inventory-1", "inventory-2"]);
});
