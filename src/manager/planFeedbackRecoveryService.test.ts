import assert from "node:assert/strict";
import test from "node:test";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import type {
  PlanFeedbackRecoveryCandidate,
  PlanFeedbackRecoveryOutcome
} from "./planFeedbackRecovery.js";
import {
  PlanFeedbackRecoveryService,
  type PlanFeedbackRecoverySweepSummary
} from "./planFeedbackRecoveryService.js";

function candidate(roleId: string, planId: string, feedbackId: string): PlanFeedbackRecoveryCandidate {
  return {
    roleDir: `C:\\roles\\${roleId}`,
    roleId,
    plan: { id: planId },
    feedback: { id: feedbackId }
  } as PlanFeedbackRecoveryCandidate;
}

function delivered(): PlanFeedbackRecoveryOutcome {
  return {
    state: "delivered",
    record: { id: "delivered" } as PlanFeedbackRecord
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for recovery service state.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("start sweeps immediately and schedules each recovery key once per service instance", async () => {
  const item = candidate("Planner", "plan-1", "feedback-1");
  const summaries: PlanFeedbackRecoverySweepSummary[] = [];
  let recoverCalls = 0;
  let scheduleCalls = 0;

  const service = new PlanFeedbackRecoveryService({
    listCandidates: async () => [item, item],
    recoverCandidate: async (_candidate, controls) => {
      recoverCalls += 1;
      await controls.scheduleOnce(async () => {
        scheduleCalls += 1;
      });
      return { state: "scheduled" };
    },
    onSummary: summary => {
      summaries.push(summary);
    },
    onError: () => {
      assert.fail("unexpected recovery error");
    }
  });

  await service.start("manager startup");
  await service.start("manual retry");

  assert.equal(recoverCalls, 1);
  assert.equal(scheduleCalls, 1);
  assert.deepEqual(
    summaries.map(summary => ({
      reason: summary.reason,
      candidates: summary.candidates,
      scheduled: summary.scheduled,
      alreadyAttempted: summary.alreadyAttempted
    })),
    [
      { reason: "manager startup", candidates: 2, scheduled: 1, alreadyAttempted: 1 },
      { reason: "manual retry", candidates: 2, scheduled: 0, alreadyAttempted: 2 }
    ]
  );

  await service.stop();
});

test("deferred outcomes retry after the configured delay", async () => {
  const item = candidate("Planner", "plan-2", "feedback-2");
  const reasons: string[] = [];
  let recoverCalls = 0;

  const service = new PlanFeedbackRecoveryService({
    retryDelayMs: 10,
    listCandidates: () => [item],
    recoverCandidate: async () => {
      recoverCalls += 1;
      return recoverCalls === 1
        ? { state: "deferred", reason: "Desktop busy" }
        : delivered();
    },
    onSummary: summary => {
      reasons.push(summary.reason);
    },
    onError: () => {
      assert.fail("unexpected recovery error");
    }
  });

  await service.start("manager startup");
  await waitUntil(() => reasons.length === 2);

  assert.deepEqual(reasons, ["manager startup", "deferred delivery readback"]);
  assert.equal(recoverCalls, 2);
  await service.stop();
});

test("scan errors publish one error and retry after the configured delay", async () => {
  const reasons: string[] = [];
  const errors: string[] = [];
  let scans = 0;

  const service = new PlanFeedbackRecoveryService({
    retryDelayMs: 10,
    listCandidates: () => {
      scans += 1;
      if (scans === 1) throw new Error("NAS unavailable");
      return [];
    },
    recoverCandidate: async () => delivered(),
    onSummary: summary => {
      reasons.push(summary.reason);
    },
    onError: event => {
      errors.push(`${event.stage}:${event.reason}:${event.error instanceof Error ? event.error.message : String(event.error)}`);
    }
  });

  await service.start("manager startup");
  await waitUntil(() => reasons.length === 1);

  assert.deepEqual(errors, ["scan:manager startup:NAS unavailable"]);
  assert.deepEqual(reasons, ["recovery scan retry"]);
  assert.equal(scans, 2);
  await service.stop();
});

test("queue keeps only the first pending timer", async () => {
  const reasons: string[] = [];
  const service = new PlanFeedbackRecoveryService({
    retryDelayMs: 10,
    listCandidates: () => [],
    recoverCandidate: async () => delivered(),
    onSummary: summary => {
      reasons.push(summary.reason);
    },
    onError: () => {
      assert.fail("unexpected recovery error");
    }
  });

  await service.start("manager startup");
  assert.equal(service.queue("first timer", 10), true);
  assert.equal(service.queue("duplicate timer", 0), false);
  await waitUntil(() => reasons.length === 2);

  assert.deepEqual(reasons, ["manager startup", "first timer"]);
  await service.stop();
});

test("sweeps never overlap when a queued timer fires during recovery", async () => {
  const item = candidate("Planner", "plan-3", "feedback-3");
  const reasons: string[] = [];
  let activeRecoveries = 0;
  let maxActiveRecoveries = 0;
  let releases = 0;

  const service = new PlanFeedbackRecoveryService({
    listCandidates: () => [item],
    recoverCandidate: async () => {
      activeRecoveries += 1;
      maxActiveRecoveries = Math.max(maxActiveRecoveries, activeRecoveries);
      await waitUntil(() => releases > 0);
      releases -= 1;
      activeRecoveries -= 1;
      return delivered();
    },
    onSummary: summary => {
      reasons.push(summary.reason);
    },
    onError: () => {
      assert.fail("unexpected recovery error");
    }
  });

  const first = service.start("first sweep");
  await waitUntil(() => activeRecoveries === 1);
  assert.equal(service.queue("queued sweep", 0), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(activeRecoveries, 1);

  releases += 1;
  await first;
  await waitUntil(() => activeRecoveries === 1);
  releases += 1;
  await waitUntil(() => reasons.length === 2);

  assert.equal(maxActiveRecoveries, 1);
  assert.deepEqual(reasons, ["first sweep", "queued sweep"]);
  await service.stop();
});

test("stop clears timers, waits for the active sweep, and suppresses stale publication and retry", async () => {
  const item = candidate("Planner", "plan-4", "feedback-4");
  const summaries: PlanFeedbackRecoverySweepSummary[] = [];
  let recoveryStarted = false;
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>(resolve => {
    releaseRecovery = resolve;
  });

  const service = new PlanFeedbackRecoveryService({
    retryDelayMs: 10,
    listCandidates: () => [item],
    recoverCandidate: async () => {
      recoveryStarted = true;
      await recoveryGate;
      return { state: "deferred", reason: "wait" };
    },
    onSummary: summary => {
      summaries.push(summary);
    },
    onError: () => {
      assert.fail("unexpected recovery error");
    }
  });

  const sweep = service.start("manager startup");
  await waitUntil(() => recoveryStarted);
  assert.equal(service.queue("stale timer", 10), true);

  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false);

  releaseRecovery();
  await Promise.all([sweep, stopping]);
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.deepEqual(summaries, []);
  assert.equal(service.queue("after stop", 0), false);
});



test("allowRetry releases a scheduled recovery key", async () => {
  const item = candidate("Planner", "plan-retry", "feedback-retry");
  let recoverCalls = 0;
  const service = new PlanFeedbackRecoveryService({
    listCandidates: () => [item],
    recoverCandidate: async (_candidate, controls) => {
      recoverCalls += 1;
      await controls.scheduleOnce(() => {});
      return { state: "scheduled" };
    },
    onSummary: () => {},
    onError: () => { assert.fail("unexpected recovery error"); }
  });

  await service.start("first");
  await service.start("skipped");
  assert.equal(recoverCalls, 1);
  service.allowRetry(item.roleId, item.plan.id, item.feedback.id);
  await service.start("retry");
  assert.equal(recoverCalls, 2);
  await service.stop();
});


test("failed schedule releases the recovery key for a later sweep", async () => {
  const item = candidate("Planner", "plan-failure", "feedback-failure");
  let recoverCalls = 0;
  const service = new PlanFeedbackRecoveryService({
    retryDelayMs: 10,
    listCandidates: () => [item],
    recoverCandidate: async (_candidate, controls) => {
      recoverCalls += 1;
      await controls.scheduleOnce(() => {
        if (recoverCalls === 1) throw new Error("schedule failed");
      });
      return { state: "scheduled" };
    },
    onSummary: () => {},
    onError: () => {}
  });

  await service.start("first");
  await service.start("second");
  assert.equal(recoverCalls, 2);
  await service.stop();
});
