import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateMemoryConsolidationSchedule,
  type MemoryConsolidationScheduleChild,
  type MemoryConsolidationScheduleChildFactory
} from "./memoryConsolidationScheduleWorkerClient.js";

class FakeDiagnosticStream extends EventEmitter {
  destroyCalls = 0;

  destroy(): void {
    this.destroyCalls += 1;
  }

  write(chunk: Buffer | string): void {
    this.emit("data", chunk);
  }
}

class FakeScheduleChild extends EventEmitter implements MemoryConsolidationScheduleChild {
  readonly pid: number;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new FakeDiagnosticStream();
  readonly stderr = new FakeDiagnosticStream();
  readonly killSignals: Array<NodeJS.Signals | number> = [];
  disconnectCalls = 0;
  unrefCalls = 0;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  sendResult(runId = "run-1"): void {
    this.emit("message", {
      ok: true,
      evaluation: { pending: { runId }, nextTriggerAt: 123 }
    });
  }

  sendFailure(rawError: string): void {
    this.emit("message", { ok: false, error: rawError });
  }

  exit(code: number | null = null, signal: NodeJS.Signals | null = "SIGTERM"): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function factoryFor(...children: FakeScheduleChild[]): MemoryConsolidationScheduleChildFactory {
  let index = 0;
  return () => {
    const child = children[index];
    index += 1;
    if (!child) throw new Error("unexpected child creation");
    return child;
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

function observeSettlement<T>(promise: Promise<T>): { isSettled(): boolean; observed: Promise<T> } {
  let settled = false;
  const observed = promise.finally(() => { settled = true; });
  void observed.catch(() => undefined);
  return { isSettled: () => settled, observed };
}

test("the real one-shot child returns an empty schedule and exits", async t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-schedule-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));

  const evaluation = await evaluateMemoryConsolidationSchedule(roleDir, {
    timeoutMs: 5_000,
    terminationTimeoutMs: 2_000
  });

  assert.deepEqual(evaluation, { pending: null });
});

test("a successful schedule result is not exposed until the child exit is confirmed", async () => {
  const first = new FakeScheduleChild(7101);
  const second = new FakeScheduleChild(7102);
  const childFactory = factoryFor(first, second);
  const firstEvaluation = evaluateMemoryConsolidationSchedule("C:/roles/one", {
    childFactory,
    timeoutMs: 1_000,
    terminationTimeoutMs: 1_000
  });
  const firstSettlement = observeSettlement(firstEvaluation);

  first.sendResult("run-one");
  await waitFor(() => first.killSignals.length === 1, "result did not request child termination");
  assert.equal(firstSettlement.isSettled(), false, "result escaped before child exit");

  first.exit();
  assert.deepEqual(await firstSettlement.observed, {
    pending: { runId: "run-one" },
    nextTriggerAt: 123
  });

  const secondEvaluation = evaluateMemoryConsolidationSchedule("C:/roles/two", {
    childFactory,
    timeoutMs: 1_000,
    terminationTimeoutMs: 1_000
  });
  second.sendResult("run-two");
  await waitFor(() => second.killSignals.length === 1, "serial second child was not terminated");
  second.exit();
  assert.equal((await secondEvaluation).pending?.runId, "run-two");
});

test("schedule timeout waits for confirmed child exit before rejecting", async () => {
  const child = new FakeScheduleChild(7201);
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/timeout", {
    childFactory: factoryFor(child),
    timeoutMs: 10,
    terminationTimeoutMs: 1_000
  });
  const settlement = observeSettlement(evaluation);

  await waitFor(() => child.killSignals.length === 1, "timeout did not request termination");
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(settlement.isSettled(), false, "timeout rejected before child exit");

  child.exit();
  await assert.rejects(settlement.observed, (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT");
    return true;
  });
});

test("schedule abort waits for confirmed child exit and preserves the abort reason", async () => {
  const child = new FakeScheduleChild(7301);
  const controller = new AbortController();
  const reason = new DOMException("scheduler stopped", "AbortError");
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/abort", {
    childFactory: factoryFor(child),
    signal: controller.signal,
    timeoutMs: 1_000,
    terminationTimeoutMs: 1_000
  });
  const settlement = observeSettlement(evaluation);

  controller.abort(reason);
  await waitFor(() => child.killSignals.length === 1, "abort did not request termination");
  assert.equal(settlement.isSettled(), false, "abort rejected before child exit");

  child.exit();
  await assert.rejects(settlement.observed, error => error === reason);
});

test("a late child result cannot overwrite a timeout outcome", async () => {
  const child = new FakeScheduleChild(7401);
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/late", {
    childFactory: factoryFor(child),
    timeoutMs: 10,
    terminationTimeoutMs: 1_000
  });

  await waitFor(() => child.killSignals.length === 1, "timeout did not begin cleanup");
  child.sendResult("late-run");
  child.exit();
  await assert.rejects(evaluation, (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT");
    return true;
  });
});

test("unexpected child output is counted without exposing diagnostic content", async () => {
  const child = new FakeScheduleChild(7451);
  const privateDiagnostic = "Cannot load C:\\Users\\example-user\\private-role\\persona.md";
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/diagnostic", {
    childFactory: factoryFor(child),
    timeoutMs: 1_000,
    terminationTimeoutMs: 1_000
  });

  child.stderr.write(privateDiagnostic);
  child.exit(1, null);

  await assert.rejects(evaluation, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(`diagnosticBytes=${Buffer.byteLength(privateDiagnostic, "utf8")}`));
    assert.doesNotMatch(message, /example-user|private-role|persona\.md/);
    return true;
  });
});

test("structured child failures expose only a stable code and message", async () => {
  const child = new FakeScheduleChild(7452);
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/structured-failure", {
    childFactory: factoryFor(child),
    timeoutMs: 1_000,
    terminationTimeoutMs: 1_000
  });

  child.sendFailure("Cannot read C:\\Users\\example-user\\private-role\\persona.md; token=example-secret");
  await waitFor(() => child.killSignals.length === 1, "failure did not request child termination");
  child.exit();

  await assert.rejects(evaluation, (error: unknown) => {
    const failure = error as NodeJS.ErrnoException;
    assert.equal(failure.code, "MEMORY_SCHEDULE_INSPECTION_FAILED");
    assert.equal(failure.message, "Memory consolidation schedule inspection failed.");
    assert.doesNotMatch(JSON.stringify(failure), /example-user|private-role|persona\.md|example-secret/);
    return true;
  });
});

test("unconfirmed child termination is non-retryable and fences new children until exit", async () => {
  const child = new FakeScheduleChild(7501);
  let factoryCalls = 0;
  const childFactory: MemoryConsolidationScheduleChildFactory = () => {
    factoryCalls += 1;
    return child;
  };
  const evaluation = evaluateMemoryConsolidationSchedule("C:/roles/stuck", {
    childFactory,
    timeoutMs: 5,
    terminationTimeoutMs: 5
  });

  await assert.rejects(evaluation, (error: unknown) => {
    const failure = error as NodeJS.ErrnoException & { retryable?: boolean };
    assert.equal(failure.code, "MEMORY_SCHEDULE_CHILD_TERMINATION_UNCONFIRMED");
    assert.equal(failure.retryable, false);
    return true;
  });
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.disconnectCalls, 1);
  assert.equal(child.unrefCalls, 1);

  await assert.rejects(
    evaluateMemoryConsolidationSchedule("C:/roles/no-overlap", { childFactory }),
    (error: unknown) => {
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        "MEMORY_SCHEDULE_CHILD_TERMINATION_UNCONFIRMED"
      );
      return true;
    }
  );
  assert.equal(factoryCalls, 1, "a retry spawned while the previous child was not confirmed dead");

  child.exit();
  await new Promise<void>(resolve => setImmediate(resolve));
});
