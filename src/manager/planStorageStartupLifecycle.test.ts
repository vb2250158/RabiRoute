import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPlanStorageStartupAttempt,
  PlanStorageStartupLifecycle,
  type PlanStorageStartupAttempt,
  type PlanStorageStartupLifecycleSnapshot
} from "./planStorageStartupLifecycle.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

const SUCCESS_SUMMARY: PlanStorageStartupGateSummary = Object.freeze({
  roles: 2,
  migrated: 1,
  reconciled: 1,
  failures: [],
  skipped: false
});

test("real startup child skips a read-only snapshot without probing the roles root", async () => {
  const attempt = createPlanStorageStartupAttempt({
    rolesRoot: "Q:\\example-path-must-not-be-probed\\roles",
    readOnly: true,
    terminateTimeoutMs: 2_000
  });
  const summary = await attempt.result;
  assert.deepEqual(summary, {
    roles: 0,
    migrated: 0,
    reconciled: 0,
    failures: [],
    skipped: true
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

function lifecycleWithAttempt(
  attempt: PlanStorageStartupAttempt,
  onStatus?: (snapshot: PlanStorageStartupLifecycleSnapshot) => void,
  overrides: Readonly<{
    attemptTimeoutMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
  }> = {}
): PlanStorageStartupLifecycle {
  return new PlanStorageStartupLifecycle({
    rolesRoot: "Z:\\ExampleShare\\Project\\data\\roles",
    readOnly: false,
    attemptFactory: () => attempt,
    onStatus,
    ...overrides
  });
}

test("plan storage startup lifecycle reaches ready after one successful attempt", async () => {
  const completion = deferred<PlanStorageStartupGateSummary>();
  const statuses: PlanStorageStartupLifecycleSnapshot[] = [];
  let cancelled = 0;
  const ready: PlanStorageStartupGateSummary[] = [];
  const lifecycle = lifecycleWithAttempt({
    pid: 4101,
    result: completion.promise,
    cancel: async () => { cancelled += 1; }
  }, snapshot => statuses.push(snapshot));
  lifecycle.onReady(summary => ready.push(summary));

  assert.deepEqual(lifecycle.snapshot(), {
    state: "idle",
    attempt: 0,
    incidents: 0,
    lastTransitionAt: lifecycle.snapshot().lastTransitionAt,
    summary: undefined
  });

  lifecycle.start();
  assert.equal(lifecycle.snapshot().state, "running");
  assert.equal(lifecycle.snapshot().attempt, 1);
  assert.equal(lifecycle.snapshot().incidents, 0);
  assert.equal(lifecycle.snapshot().childPid, 4101);

  completion.resolve(SUCCESS_SUMMARY);
  await waitFor(() => lifecycle.snapshot().state === "ready", "successful startup did not reach ready");

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.attempt, 1);
  assert.equal(snapshot.incidents, 0);
  assert.equal(snapshot.childPid, undefined);
  assert.deepEqual(snapshot.summary, SUCCESS_SUMMARY);
  assert.deepEqual(ready, [SUCCESS_SUMMARY]);
  assert.equal(cancelled, 0);
  assert.deepEqual(statuses.map(status => status.state), ["running", "ready"]);
});

test("hung startup attempt times out, is cancelled, and reports one degraded incident", async () => {
  const completion = deferred<PlanStorageStartupGateSummary>();
  const statuses: PlanStorageStartupLifecycleSnapshot[] = [];
  let cancelled = 0;
  const lifecycle = lifecycleWithAttempt({
    pid: 4102,
    result: completion.promise,
    cancel: async () => { cancelled += 1; }
  }, snapshot => statuses.push(snapshot), {
    attemptTimeoutMs: 15,
    retryBaseMs: 10_000,
    retryMaxMs: 10_000
  });

  lifecycle.start();
  await waitFor(() => lifecycle.snapshot().state === "degraded", "hung startup did not become degraded");

  const snapshot = lifecycle.snapshot();
  assert.equal(cancelled, 1);
  assert.equal(snapshot.attempt, 1);
  assert.equal(snapshot.incidents, 1);
  assert.equal(snapshot.childPid, undefined);
  assert.match(snapshot.lastError || "", /timed out after 15ms/);
  assert.ok(snapshot.nextRetryAt);
  assert.deepEqual(statuses.map(status => [status.state, status.incidents]), [
    ["running", 0],
    ["degraded", 1]
  ]);

  await lifecycle.stop();
});

test("stop during timeout cancellation awaits one shared cancellation flight and emits no late retry", async () => {
  const completion = deferred<PlanStorageStartupGateSummary>();
  const cancellationStarted = deferred<void>();
  const releaseCancellation = deferred<void>();
  const statuses: PlanStorageStartupLifecycleSnapshot[] = [];
  let cancelCalls = 0;
  const lifecycle = lifecycleWithAttempt({
    pid: 4104,
    result: completion.promise,
    cancel: async () => {
      cancelCalls += 1;
      cancellationStarted.resolve(undefined);
      await releaseCancellation.promise;
    }
  }, snapshot => statuses.push(snapshot), {
    attemptTimeoutMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 10
  });

  lifecycle.start();
  await cancellationStarted.promise;

  let stopSettled = false;
  const sharedStop = lifecycle.stop();
  const firstStop = sharedStop.finally(() => { stopSettled = true; });
  const secondStop = lifecycle.stop();
  assert.equal(secondStop, sharedStop, "concurrent stop calls must return the shared stop flight");
  assert.equal(lifecycle.stop(), sharedStop, "repeated stop calls must return the shared stop flight");
  await new Promise<void>(resolve => setTimeout(resolve, 20));

  assert.equal(stopSettled, false, "stop must wait for timeout cancellation to finish");
  assert.equal(lifecycle.snapshot().state, "stopping");
  assert.equal(cancelCalls, 1);

  releaseCancellation.resolve(undefined);
  await Promise.all([firstStop, secondStop]);
  await new Promise<void>(resolve => setTimeout(resolve, 25));

  assert.equal(lifecycle.snapshot().state, "stopped");
  assert.equal(lifecycle.snapshot().attempt, 1);
  assert.equal(cancelCalls, 1);
  assert.deepEqual(statuses.map(status => status.state), ["running", "stopping", "stopped"]);
});

test("startup retry backoff is capped and does not grow beyond retryMaxMs", async () => {
  const pending = deferred<PlanStorageStartupGateSummary>();
  const statuses: PlanStorageStartupLifecycleSnapshot[] = [];
  let attempts = 0;
  let pendingCancelled = 0;
  const lifecycle = new PlanStorageStartupLifecycle({
    rolesRoot: "Z:\\ExampleShare\\Project\\data\\roles",
    readOnly: false,
    retryBaseMs: 20,
    retryMaxMs: 25,
    attemptTimeoutMs: 10_000,
    onStatus: snapshot => statuses.push(snapshot),
    attemptFactory: () => {
      attempts += 1;
      if (attempts <= 3) {
        return {
          result: Promise.reject(new Error(`attempt ${attempts} failed`)),
          cancel: async () => undefined
        };
      }
      return {
        result: pending.promise,
        cancel: async () => { pendingCancelled += 1; }
      };
    }
  });

  lifecycle.start();
  await waitFor(
    () => lifecycle.snapshot().state === "running" && lifecycle.snapshot().attempt === 4,
    "bounded retry did not start the fourth attempt"
  );

  const degraded = statuses.filter(status => status.state === "degraded");
  assert.deepEqual(degraded.map(status => [status.attempt, status.incidents]), [
    [1, 1],
    [2, 1],
    [3, 1]
  ]);
  const retryDelays = degraded.map(status => {
    assert.ok(status.completedAt);
    assert.ok(status.nextRetryAt);
    return Date.parse(status.nextRetryAt) - Date.parse(status.completedAt);
  });
  assert.ok(retryDelays[0] >= 18 && retryDelays[0] <= 20, `unexpected first retry delay: ${retryDelays[0]}`);
  assert.ok(retryDelays[1] >= 23 && retryDelays[1] <= 25, `unexpected capped retry delay: ${retryDelays[1]}`);
  assert.ok(retryDelays[2] >= 23 && retryDelays[2] <= 25, `retry exceeded cap: ${retryDelays[2]}`);
  assert.equal(Math.max(...retryDelays), 25);

  await lifecycle.stop();
  assert.equal(pendingCancelled, 1);
});

test("stop suppresses late attempt completion and emits no state after stopped", async () => {
  const completion = deferred<PlanStorageStartupGateSummary>();
  const statuses: PlanStorageStartupLifecycleSnapshot[] = [];
  let cancelled = 0;
  let readyCalls = 0;
  const lifecycle = lifecycleWithAttempt({
    pid: 4103,
    result: completion.promise,
    cancel: async () => { cancelled += 1; }
  }, snapshot => statuses.push(snapshot));
  lifecycle.onReady(() => { readyCalls += 1; });

  lifecycle.start();
  await lifecycle.stop();
  const statusCountAtStop = statuses.length;
  completion.resolve(SUCCESS_SUMMARY);
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(cancelled, 1);
  assert.equal(lifecycle.snapshot().state, "stopped");
  assert.equal(lifecycle.snapshot().incidents, 0);
  assert.equal(readyCalls, 0);
  assert.equal(statuses.length, statusCountAtStop);
  assert.deepEqual(statuses.map(status => status.state), ["running", "stopping", "stopped"]);
});

test("plan startup child diagnostics remain opaque outside the child boundary", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./planStorageStartupLifecycle.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /diagnosticTail|diagnostics=/);
  assert.doesNotMatch(source, /message\?\.error|reject\(error\)/);
  assert.match(source, /diagnosticBytes/);
  assert.match(source, /Plan storage startup gate failed\./);
});
