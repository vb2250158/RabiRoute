import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginManifest, PluginModule } from "../plugin-kernel/types.js";
import { FailureCircuitRegistry } from "../runtime/failureCircuit.js";
import { PlanFeedbackRecoveryService, type PlanFeedbackRecoveryServiceOptions } from "./planFeedbackRecoveryService.js";
import type { PlanFeedbackRecoveryCandidate, PlanFeedbackRecoveryOutcome } from "./planFeedbackRecovery.js";
import { attachNativeStorageWork, beginNativeStorageWork } from "./nativeStorageWork.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-feedback-publication-"));
  const entry = path.resolve("plugins/builtin/io.rabiroute.manager.plan-feedback-delivery/1.0.0/manager.mjs");
  const plugin: PluginModule = await import(pathToFileURL(entry).href);
  const manifest: PluginManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "rabi.plugin.json"), "utf8"));
  const instances: PlanFeedbackRecoveryService[] = [];
  const restores: ReturnType<PlanFeedbackRecoveryService["failureSummary"]>[] = [];
  const counts = { starts: 0, joins: 0, schedules: 0, events: 0, scans: 0 };
  let cleanupFailure: { error: Error; observed(): void } | undefined;
  class TrackedRecovery extends PlanFeedbackRecoveryService {
    constructor(options: PlanFeedbackRecoveryServiceOptions) {
      super({ ...options, retryDelayMs: 60000 }); instances.push(this); restores.push(this.failureSummary());
    }
    override start(reason: string) { counts.starts++; return super.start(reason); }
    override stopAndJoin() {
      counts.joins++;
      const joined = super.stopAndJoin(), failure = cleanupFailure;
      return failure ? joined.then(() => { failure.observed(); throw failure.error; }) : joined;
    }
  }
  let scan: PlanFeedbackRecoveryServiceOptions["listCandidates"] = () => [];
  let recover: (item: PlanFeedbackRecoveryCandidate, controls: { signal: AbortSignal; schedule(current: PlanFeedbackRecoveryCandidate): Promise<void> }) => Promise<PlanFeedbackRecoveryOutcome>
    = async (item, controls) => { await controls.schedule(item); return { state: "scheduled" }; };
  const host = {
    managerReadOnly: false, PlanFeedbackRecoveryService: TrackedRecovery,
    planFeedbackFailureStatePath: path.join(root, "state.json"), rootDir: root, rolesRoot: path.join(root, "roles"),
    planFeedbackDeliveryActive: false, planFeedbackRecoveryService: undefined as PlanFeedbackRecoveryService | undefined,
    startActivePlanFeedbackRecovery: () => {}, activePlanFeedbackDeliveryFlights: new Map<string, Promise<void>>(),
    managerOperationalLog: { record() {} }, managerOperationalError: (error: unknown) => String(error),
    ManagerReadWorkerError: Error,
    managerReadWorkerPool: { queryPlanFeedbackRecoveryCandidates(_root: string, { signal }: { signal: AbortSignal }) { counts.scans++; return scan(signal); } },
    inspectPlanFeedbackDelivery: async () => "missing",
    async recoverPlanFeedbackCandidate(item: PlanFeedbackRecoveryCandidate, controls: Parameters<typeof recover>[1]) { return recover(item, controls); },
    async scheduleAndWaitForPlanFeedbackDelivery() { counts.schedules++; },
    publishManagerEvent() { counts.events++; }
  };
  let effect: (() => Promise<() => void>) | undefined;
  let failPublication = false;
  let published: (() => void) | undefined;
  const retirements: Array<() => void | Promise<void>> = [];
  const generation = new GenerationRuntime({ host: "manager", hostServices: [
    { capability: "host.manager.plan-feedback-delivery@1", value: host },
    { capability: "manager.core@1", value: {} }, { capability: "manager.message-processing-control@1", value: {} }
  ], executor: { async prepare() {
    const stagedEffect = effect; effect = undefined;
    const fail = failPublication; failPublication = false;
    return { async activate(context) {
      await plugin.activate({ ...context, publication: { add(publication, label) {
        if (publication.retire) retirements.push(publication.retire);
        context.publication.add(publication, label);
      } } });
      if (stagedEffect) context.effects.add(stagedEffect);
      if (fail) context.publication.add({ publish() { throw new Error("controlled publication failure"); }, rollback() {} });
    } };
  } }, onPublished() { published?.(); } });
  function candidate(revision: string, shutdownTimeoutMs = 1000): PluginCandidate {
    return { instanceId: "manager:plan-feedback-delivery", revision, config: {}, manifest, entry: { execution: "in_process", path: entry },
      policy: { resources: { maxChildProcesses: 0, shutdownTimeoutMs }, restart: { mode: "never", maxAttempts: 0, windowMs: 1, initialBackoffMs: 1, maximumBackoffMs: 1 } } };
  }
  t.after(async () => {
    if (cleanupFailure) {
      const expected = cleanupFailure.error;
      await assert.rejects(generation.dispose(), error => error instanceof AggregateError
        && error.errors.some(cause => cause instanceof Error && cause.message === expected.message));
    } else {
      await generation.dispose();
    }
    await Promise.all(instances.map(instance => instance.stop()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("plan-feedback-publication-")); fs.rmSync(root, { recursive: true, force: true });
  });
  return { host, generation, candidate, instances, restores, counts, retirements,
    scan(value: typeof scan) { scan = value; }, recover(value: typeof recover) { recover = value; },
    stage(value: NonNullable<typeof effect>) { effect = value; }, failPublication() { failPublication = true; },
    failCleanup(error: Error, observed: () => void) { cleanupFailure = { error, observed }; },
    onPublished(value?: () => void) { published = value; } };
}

test("candidate preparation and effect failure preserve the old flag, recovery and readiness hook", async t => {
  const f = await fixture(t); await f.generation.switch([f.candidate("one")]);
  f.host.startActivePlanFeedbackRecovery(); await tick();
  const original = { recovery: f.host.planFeedbackRecoveryService, start: f.host.startActivePlanFeedbackRecovery };
  const staged = deferred(), fail = deferred();
  f.stage(async () => { staged.resolve(); await fail.promise; throw new Error("controlled effect failure"); });
  const switching = f.generation.switch([f.candidate("bad")]); await staged.promise;
  try {
    assert.equal(f.host.planFeedbackDeliveryActive, true);
    assert.equal(f.host.planFeedbackRecoveryService, original.recovery); assert.equal(f.host.startActivePlanFeedbackRecovery, original.start);
    assert.equal(f.instances.length, 1); assert.equal(f.counts.joins, 0);
  } finally { fail.resolve(); await switching; }
  assert.equal(f.host.planFeedbackDeliveryActive, true); assert.equal(f.host.planFeedbackRecoveryService, original.recovery);
  assert.equal(f.counts.joins, 0); assert.equal(original.recovery!.isActive(), true);
});

test("synchronous publication failure restores every original pointer without constructing recovery", async t => {
  const f = await fixture(t); await f.generation.switch([f.candidate("one")]);
  const service = f.host.planFeedbackRecoveryService, start = f.host.startActivePlanFeedbackRecovery;
  f.failPublication(); await assert.rejects(f.generation.switch([f.candidate("bad")]), /controlled publication failure/);
  assert.equal(f.host.planFeedbackDeliveryActive, true); assert.equal(f.host.planFeedbackRecoveryService, service);
  assert.equal(f.host.startActivePlanFeedbackRecovery, start); assert.equal(f.instances.length, 1); assert.equal(f.counts.joins, 0);
});

test("ready recovery automatically resumes on replacement and revision rollback while dormant recovery waits for readiness", async t => {
  const f = await fixture(t); await f.generation.switch([f.candidate("one")]);
  assert.equal(f.counts.starts, 0);
  await f.generation.switch([f.candidate("two")]); assert.equal(f.counts.starts, 0); assert.equal(f.host.planFeedbackDeliveryActive, true);
  f.host.startActivePlanFeedbackRecovery(); await tick(); assert.equal(f.counts.starts, 1);
  await f.generation.switch([f.candidate("three")]); await tick();
  assert.equal(f.counts.starts, 2); assert.equal(f.host.planFeedbackDeliveryActive, true); assert.equal(f.instances[1]!.isActive(), false);
  await f.generation.switch([f.candidate("two")]); await tick();
  assert.equal(f.counts.starts, 3); assert.equal(f.host.planFeedbackRecoveryService, f.instances[3]);
});

test("readiness received while old delivery drains is replayed only after the old owner finishes", async t => {
  const f = await fixture(t); await f.generation.switch([f.candidate("one")]);
  const flight = deferred(), published = deferred();
  f.host.activePlanFeedbackDeliveryFlights.set("old-delivery", flight.promise);
  f.onPublished(() => { f.host.startActivePlanFeedbackRecovery(); published.resolve(); });
  const switching = f.generation.switch([f.candidate("two")]); await published.promise; await tick();
  try {
    assert.equal(f.host.planFeedbackDeliveryActive, false); assert.equal(f.host.planFeedbackRecoveryService, undefined);
    assert.equal(f.instances.length, 1); assert.equal(f.counts.starts, 0);
  } finally { flight.resolve(); await switching; }
  f.onPublished(); await tick();
  assert.equal(f.instances.length, 2); assert.equal(f.counts.starts, 1); assert.equal(f.host.planFeedbackDeliveryActive, true);
});

test("replacement joins a real aborted scan before loading the final persisted recovery circuits", async t => {
  const f = await fixture(t), scan = deferred(), entered = deferred();
  let first = true;
  f.scan(async signal => {
    if (!first) return []; first = false; entered.resolve(); await scan.promise;
    assert.equal(signal.aborted, true);
    new FailureCircuitRegistry({ baseDelayMs: 60000, maximumDelayMs: 60000, incidentThreshold: 5,
      persistencePath: f.host.planFeedbackFailureStatePath }).recordFailure("scan", new Error("last old-owner failure"));
    return [];
  });
  await f.generation.switch([f.candidate("one")]); f.host.startActivePlanFeedbackRecovery(); await entered.promise;
  const published = deferred(); f.onPublished(() => published.resolve());
  const switching = f.generation.switch([f.candidate("two")]); await published.promise; await tick();
  try { assert.equal(f.instances.length, 1); assert.equal(f.host.planFeedbackDeliveryActive, false); }
  finally { scan.resolve(); await switching; }
  f.onPublished(); assert.equal(f.restores[1]!.backoff, 1); assert.equal(f.host.planFeedbackRecoveryService, f.instances[1]);
  assert.equal(f.counts.starts, 2); assert.equal(f.host.planFeedbackDeliveryActive, true);
});

test("unconfirmed old retirement fails closed; late old cleanup cannot clear another owner", async t => {
  const f = await fixture(t), scan = deferred(), entered = deferred();
  f.scan(async () => { entered.resolve(); await scan.promise; return []; });
  await f.generation.switch([f.candidate("one", 5)]); f.host.startActivePlanFeedbackRecovery(); await entered.promise;
  const result = await f.generation.switch([f.candidate("two", 5)]);
  assert.ok(result.generation.cleanupDiagnostics.length); assert.equal(f.instances.length, 1);
  assert.equal(f.host.planFeedbackDeliveryActive, false); assert.equal(f.host.planFeedbackRecoveryService, undefined);
  const other = new PlanFeedbackRecoveryService({ listCandidates: () => [], recoverCandidate: async () => ({ state: "scheduled" }), onSummary() {}, onError() {} });
  const otherStart = () => {};
  f.host.planFeedbackRecoveryService = other; f.host.startActivePlanFeedbackRecovery = otherStart; f.host.planFeedbackDeliveryActive = true;
  scan.resolve(); await f.instances[0]!.stopAndJoin(); await tick();
  assert.equal(f.host.planFeedbackDeliveryActive, true); assert.equal(f.host.planFeedbackRecoveryService, other);
  assert.equal(f.host.startActivePlanFeedbackRecovery, otherStart); await other.stopAndJoin();
});

test("a rejected worker result retains its native closure until the original worker lease releases", async t => {
  const f = await fixture(t), entered = deferred();
  let release!: () => void;
  let first = true;
  f.scan(() => {
    if (!first) return []; first = false;
    const worker = beginNativeStorageWork(); release = worker.release; entered.resolve();
    return attachNativeStorageWork(Promise.reject(new Error("controlled worker termination unconfirmed")), worker.closed);
  });
  await f.generation.switch([f.candidate("one")]); f.host.startActivePlanFeedbackRecovery(); await entered.promise; await tick();
  const published = deferred(); f.onPublished(() => published.resolve());
  const switching = f.generation.switch([f.candidate("two")]); await published.promise; await tick();
  try { assert.equal(f.instances.length, 1); assert.equal(f.host.planFeedbackDeliveryActive, false); }
  finally { release(); await switching; }
  f.onPublished(); assert.equal(f.instances.length, 2); assert.equal(f.host.planFeedbackDeliveryActive, true);
});

test("late delivered outcome after abort emits no stale event and retirement is idempotent", async t => {
  const f = await fixture(t), finishing = deferred(), entered = deferred();
  const item = { roleDir: "fixture", roleId: "planner", plan: { id: "plan-one" }, feedback: { id: "feedback-one" } } as PlanFeedbackRecoveryCandidate;
  f.scan(() => [item]); f.recover(async () => { entered.resolve(); await finishing.promise; return { state: "delivered", record: item.feedback }; });
  await f.generation.switch([f.candidate("one")]); f.host.startActivePlanFeedbackRecovery(); await entered.promise;
  const removing = f.generation.switch([]); await tick();
  const recovery = f.instances[0]!, joining = recovery.stopAndJoin(); assert.equal(recovery.stopAndJoin(), joining);
  finishing.resolve(); await removing; await joining;
  assert.equal(f.counts.events, 0); assert.equal(f.host.planFeedbackDeliveryActive, false);
});

test("read-only candidates allocate no recovery or shared state", async t => {
  const f = await fixture(t); f.host.managerReadOnly = true;
  const start = f.host.startActivePlanFeedbackRecovery;
  await f.generation.switch([f.candidate("readonly")]);
  assert.equal(f.instances.length, 0); assert.equal(f.host.planFeedbackDeliveryActive, false);
  assert.equal(f.host.startActivePlanFeedbackRecovery, start); assert.equal(f.counts.scans, 0);
});

test("repeated plugin retirement and kernel disposal join the same cleanup without stopping twice", async t => {
  const f = await fixture(t), flight = deferred(); await f.generation.switch([f.candidate("one")]);
  f.host.activePlanFeedbackDeliveryFlights.set("owned", flight.promise);
  const retire = f.retirements[0]!, first = retire(); assert.equal(retire(), first); await tick();
  try { assert.equal(f.counts.joins, 1); assert.equal(f.host.planFeedbackDeliveryActive, false); }
  finally { flight.resolve(); await first; }
  assert.equal(retire(), first); await f.generation.dispose(); assert.equal(f.counts.joins, 1);
});

test("recovery cleanup rejection still joins accepted flights before kernel disposal and repeated retire reject", async t => {
  const f = await fixture(t), flight = deferred(), failed = deferred();
  await f.generation.switch([f.candidate("one")]);
  const fault = new Error("controlled recovery cleanup failure");
  f.failCleanup(fault, failed.resolve);
  let flightFinished = false;
  const acceptedFlight = flight.promise.then(() => { flightFinished = true; });
  f.host.activePlanFeedbackDeliveryFlights.set("accepted-native-delivery", acceptedFlight);
  let kernelState = "pending";
  const disposal = f.generation.dispose();
  const observedDisposal = disposal.then(() => { kernelState = "fulfilled"; }, () => { kernelState = "rejected"; });
  await failed.promise;
  const retire = f.retirements[0]!, retirement = retire();
  assert.equal(retire(), retirement);
  let retirementState = "pending";
  const observedRetirement = Promise.resolve(retirement).then(() => { retirementState = "fulfilled"; }, () => { retirementState = "rejected"; });
  await tick();
  try {
    assert.equal(kernelState, "pending"); assert.equal(retirementState, "pending");
    assert.equal(flightFinished, false); assert.equal(f.counts.joins, 1);
  } finally {
    flight.resolve(); await Promise.all([acceptedFlight, observedDisposal, observedRetirement]);
  }
  assert.equal(kernelState, "rejected"); assert.equal(retirementState, "rejected");
  await assert.rejects(Promise.resolve(retirement), error => error === fault);
  assert.equal(retire(), retirement); await assert.rejects(Promise.resolve(retire()), error => error === fault);
  assert.equal(f.counts.joins, 1); assert.equal(flightFinished, true);
});

test("native exclusive join retains a schedule producer even when its caller returns without awaiting it", async () => {
  const schedule = deferred(), entered = deferred();
  const item = { roleDir: "fixture", roleId: "planner", plan: { id: "plan-one" }, feedback: { id: "feedback-one" } } as PlanFeedbackRecoveryCandidate;
  const service = new PlanFeedbackRecoveryService({ listCandidates: () => [item],
    recoverCandidate(_item, controls) { void controls.scheduleOnce(async () => { entered.resolve(); await schedule.promise; }).catch(() => {}); return { state: "scheduled" }; },
    onSummary() {}, onError() {} });
  await service.start("test"); await entered.promise; await service.stop();
  let joined = false; const joining = service.stopAndJoin().then(() => { joined = true; });
  await tick(); assert.equal(joined, false); schedule.resolve(); await joining; assert.equal(joined, true);
});
