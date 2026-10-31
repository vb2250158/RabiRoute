import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { GenerationRuntime, type PluginRuntimeFailureEvent } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginContext, PluginModule, PluginPublication } from "../plugin-kernel/types.js";
import type { AgentRequestRecord } from "../agentRequests/store.js";
import { MemoryConsolidationScheduler } from "./memoryConsolidationScheduler.js";
import { ManualTriggerProcessRegistry } from "./manualTriggerProcess.js";
import { MessageProcessingAutomationService, type MessageProcessingAutomationServiceOptions } from "./messageProcessingAutomationService.js";
import { KnowledgeCallbackReminderService, type KnowledgeCallbackReminderServiceOptions } from "./knowledgeCallbackReminderService.js";

type Kind = "memory-consolidation" | "message-processing-automation";
const kinds: Kind[] = ["memory-consolidation", "message-processing-automation"];
const modules = new Map<Kind, PluginModule>();
for (const kind of kinds) modules.set(kind, await import(new URL(`../../plugins/builtin/io.rabiroute.manager.${kind}/1.0.0/manager.mjs`, import.meta.url).href));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Requirement = { id: string; knowledgeCallbackDueAt: string };
class ControlledChild extends EventEmitter {
  exitCode: number | null = null;
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  finish() { if (this.exitCode !== null) return; this.exitCode = 0; this.stdout.end(); this.stderr.end(); this.emit("exit", 0, null); }
}

function fixture(t: test.TestContext, kind: Kind, readOnly = false) {
  const retired = new Map<string, ReturnType<typeof deferred>>();
  const candidates = new WeakMap<PluginCandidate, PluginModule>(), disposers = new Map<string, () => void | Promise<void>>();
  const cleanup: Array<() => void> = [], published: Array<() => void> = [];
  let reportFailure!: (event: PluginRuntimeFailureEvent) => void;
  const runtimeFailure = new Promise<PluginRuntimeFailureEvent>(resolve => { reportFailure = resolve; });
  const logs: string[] = [], scans: number[] = [], children: ControlledChild[] = [], stopping: ControlledChild[] = [];
  const timers: Array<{ callback: () => void | Promise<void>; cleared: boolean; owner: string }> = [];
  const subscribers = new Set<(event: { roleDir: string; after: unknown }) => void>();
  const schedulers: MemoryConsolidationScheduler[] = [], automations: MessageProcessingAutomationService[] = [], reminders: KnowledgeCallbackReminderService<Requirement>[] = [];
  let memory: MemoryConsolidationScheduler | undefined, automation: MessageProcessingAutomationService | undefined, knowledge: KnowledgeCallbackReminderService<Requirement> | undefined;
  let autoExit = false, memoryDue = false, failKnowledgeStart = false;
  let planWork = async () => {}, reminderWork = async () => {};
  const registry = new ManualTriggerProcessRegistry(async child => {
    const original = child as unknown as ControlledChild; stopping.push(original); if (autoExit) original.finish();
  }, undefined, { terminateTimeoutMs: 1000, forceKillTimeoutMs: 1000, forceStopProcess: async () => { throw new Error("Controlled child must exit explicitly."); } });
  const launch = (owner: string, key: string) => new Promise<void>(resolve => {
    const child = new ControlledChild(); children.push(child);
    registry.launchOwned(owner, key, () => child as unknown as ChildProcess, { onExit: () => resolve() });
  });
  const request: AgentRequestRecord = { id: "request", deliveryId: "delivery", status: "awaiting_response", source: { threadId: "source", agentType: "source" },
    target: { threadId: "target", agentType: "target" }, responseInstruction: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    nextReminderAt: new Date(0).toISOString(), reminderCount: 0 };
  const requirement: Requirement = { id: "requirement", knowledgeCallbackDueAt: new Date(0).toISOString() };
  const schedule = (owner: string) => (callback: () => void | Promise<void>): NodeJS.Timeout => {
    const item = { callback, cleared: false, owner }; timers.push(item);
    item.callback = () => { item.cleared = true; return callback(); };
    return Object.assign(item, { unref() {} }) as unknown as NodeJS.Timeout;
  };
  const clear = (timer: NodeJS.Timeout) => { (timer as unknown as { cleared: boolean }).cleared = true; };
  class Automation extends MessageProcessingAutomationService {
    constructor(options: MessageProcessingAutomationServiceOptions) { super({ ...options, scheduleTimer: schedule(`automation:${automations.length}`), clearTimer: clear }); automations.push(this); }
    override start() { logs.push("automation-start"); super.start(); }
  }
  class Knowledge extends KnowledgeCallbackReminderService<Requirement> {
    constructor(options: KnowledgeCallbackReminderServiceOptions<Requirement>) { super({ ...options, scheduleTimer: schedule(`knowledge:${reminders.length}`), clearTimer: clear }); reminders.push(this); }
    override async start() { logs.push("knowledge-start"); if (failKnowledgeStart) throw new Error("Controlled knowledge startup failure."); await super.start(); }
  }
  const host = {
    managerReadOnly: readOnly,
    createMemoryConsolidationScheduler: () => {
      const number = schedulers.length;
      const scheduler = new MemoryConsolidationScheduler({
        listTargets: () => { scans.push(number); return memoryDue ? [{ gatewayId: "route", roleId: "role", roleKey: "role", roleDir: "/fixture" }] : []; },
        requestDueRun: () => ({ runId: `run-${number}`, revision: "one" }),
        deliver: () => launch("manager:memory-consolidation", "route:memory")
      }); schedulers.push(scheduler); return scheduler;
    },
    manualTriggerProcesses: { stopOwner: (owner: string) => { logs.push(`stop-owner:${owner}`); return registry.stopOwner(owner); } },
    get memoryConsolidationScheduler() { return memory; }, set memoryConsolidationScheduler(value) { memory = value; },
    MessageProcessingAutomationService: Automation, KnowledgeCallbackReminderService: Knowledge,
    agentRequests: { ready: async () => {}, list: () => [request], get: () => request },
    messageProcessingBoard: { list: () => [requirement], getRequirement: () => requirement, pendingKnowledgeMatches: () => ["pending"], recordKnowledgeReminder: () => undefined },
    deliverAgentRequestReminder: () => reminderWork(), deliverKnowledgeCallbackReminder: () => reminderWork(), recordAgentRequestReminderFailure: () => {},
    managerOperationalLog: { record: (_level: string, event: string) => { logs.push(event); } }, managerOperationalError: () => "controlled", rootDir: "/fixture",
    subscribePlanUpdates: (callback: (event: { roleDir: string; after: unknown }) => void) => { logs.push("subscribe"); subscribers.add(callback); return () => { logs.push("unsubscribe"); subscribers.delete(callback); }; },
    handleMessageProcessingPlanUpdate: () => planWork(),
    get messageProcessingAutomationService() { return automation; }, set messageProcessingAutomationService(value) { automation = value; },
    get knowledgeCallbackReminderService() { return knowledge; }, set knowledgeCallbackReminderService(value) { knowledge = value; }
  };
  const kernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: `host.manager.${kind}@1`, value: host }],
    executor: { prepare: async candidate => candidates.get(candidate)! }, onPublished: () => { for (const resolve of published.splice(0)) resolve(); }, onRuntimeFailure: reportFailure });
  const candidate = (revision: string, afterPrepare?: () => Promise<void>, publication?: PluginPublication) => {
    const result: PluginCandidate = { instanceId: `manager:${kind}`, revision, config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: `io.test.${kind}`, version: "1.0.0", provides: [`manager.${kind}@1`], requires: [`host.manager.${kind}@1`], optional: [], permissions: [],
        entries: { manager: { execution: "in_process", module: "fixture.mjs" } } } };
    candidates.set(result, { activate: async context => {
      const scoped: PluginContext = { ...context, effects: { ...context.effects, add(starter, label) {
        context.effects.add(async () => {
          const dispose = await starter(); disposers.set(revision, dispose);
          const completion = deferred(); retired.set(revision, completion);
          return async () => { try { await dispose(); } finally { completion.resolve(); } };
        }, label);
      } } };
      await modules.get(kind)!.activate(scoped);
      if (afterPrepare) context.effects.add(async () => { await afterPrepare(); return () => {}; });
      if (publication) context.publication.add(publication);
    } });
    return result;
  };
  t.after(async () => { for (const release of cleanup) release(); autoExit = true; for (const child of children) child.finish(); await kernel.dispose().catch(() => {}); });
  return { host, kernel, candidate, runtimeFailure, retired, logs, scans, children, stopping, timers, subscribers, schedulers, automations, reminders, disposers, cleanup,
    nextPublication: () => new Promise<void>(resolve => published.push(resolve)), memoryDue: () => { memoryDue = true; }, failKnowledgeStart: () => { failKnowledgeStart = true; },
    planWork: (run: typeof planWork) => { planWork = run; }, reminderWork: (run: typeof reminderWork) => { reminderWork = run; },
    firePlan: () => { for (const callback of subscribers) callback({ roleDir: "/fixture", after: {} }); }, launch };
}

for (const kind of kinds) {
  test(`${kind}: failed candidate never replaces active pointers or starts background work`, { timeout: 15000 }, async t => {
    const f = fixture(t, kind); await f.kernel.switch([f.candidate("old")]); f.host.memoryConsolidationScheduler?.start();
    const original = [f.host.memoryConsolidationScheduler, f.host.messageProcessingAutomationService, f.host.knowledgeCallbackReminderService];
    const before = [...f.logs], scans = [...f.scans], timers = f.timers.length;
    const entered = deferred(), release = deferred(); f.cleanup.push(release.resolve);
    const switching = f.kernel.switch([f.candidate("failed", async () => { entered.resolve(); await release.promise; throw new Error("Controlled candidate failure."); })]);
    await entered.promise;
    assert.deepEqual([f.host.memoryConsolidationScheduler, f.host.messageProcessingAutomationService, f.host.knowledgeCallbackReminderService], original);
    assert.deepEqual(f.logs, before); assert.deepEqual(f.scans, scans); assert.equal(f.timers.length, timers);
    release.resolve(); const result = await switching;
    assert.equal(result.generation.records[0]!.error?.code, "update_failed_using_previous_revision");
    assert.deepEqual([f.host.memoryConsolidationScheduler, f.host.messageProcessingAutomationService, f.host.knowledgeCallbackReminderService], original);
    assert.equal(f.logs.filter(value => value.startsWith("stop-owner")).length, 0); assert.equal(f.timers.length, timers);
  });
  test(`${kind}: synchronous publication failure restores original generation and all pointers`, { timeout: 15000 }, async t => {
    const f = fixture(t, kind); await f.kernel.switch([f.candidate("old")]); f.host.memoryConsolidationScheduler?.start();
    const before = f.kernel.current(), memory = f.host.memoryConsolidationScheduler, automation = f.host.messageProcessingAutomationService, knowledge = f.host.knowledgeCallbackReminderService;
    await assert.rejects(f.kernel.switch([f.candidate("failed", undefined, { publish() { throw new Error("Controlled publication failure."); }, rollback() {} })]), /Controlled publication failure/);
    assert.equal(f.kernel.current(), before); assert.equal(f.host.memoryConsolidationScheduler, memory); assert.equal(f.host.messageProcessingAutomationService, automation); assert.equal(f.host.knowledgeCallbackReminderService, knowledge);
    assert.equal(f.logs.filter(value => value.startsWith("stop-owner")).length, 0);
  });
  test(`${kind}: readonly activation constructs no scheduler, reminders, subscriptions or timers`, async t => {
    const f = fixture(t, kind, true); await f.kernel.switch([f.candidate("one")]); await f.kernel.dispose();
    assert.equal(f.schedulers.length + f.automations.length + f.reminders.length + f.subscribers.size + f.timers.length, 0); assert.deepEqual(f.logs, []);
  });
  test(`${kind}: final readiness rejection leaves old pointers and background owners intact`, async t => {
    const f = fixture(t, kind); await f.kernel.switch([f.candidate("old")]); f.host.memoryConsolidationScheduler?.start();
    const original = [f.host.memoryConsolidationScheduler, f.host.messageProcessingAutomationService, f.host.knowledgeCallbackReminderService], before = [...f.logs];
    await assert.rejects(f.kernel.switch([f.candidate("missing-capability")], { readyRequires: ["missing.fixture@1"] }), /Required plugin capabilities/);
    assert.deepEqual([f.host.memoryConsolidationScheduler, f.host.messageProcessingAutomationService, f.host.knowledgeCallbackReminderService], original);
    assert.deepEqual(f.logs, before);
  });
}

test("memory replacement resumes readiness only after original process exit; repeated old disposal preserves new child", { timeout: 15000 }, async t => {
  const f = fixture(t, "memory-consolidation"); f.memoryDue(); await f.kernel.switch([f.candidate("old")]);
  assert.deepEqual(f.scans, []); f.host.memoryConsolidationScheduler!.start(); await tick(); assert.equal(f.children.length, 1);
  const published = f.nextPublication(); let finished = false;
  const switching = f.kernel.switch([f.candidate("next")]).then(() => { finished = true; }); await published; await tick();
  // Concurrent Manager readiness/reschedule calls cannot bypass retirement.
  f.host.memoryConsolidationScheduler!.start(); f.host.memoryConsolidationScheduler!.reschedule(); await f.host.memoryConsolidationScheduler!.runOnce();
  assert.equal(finished, false); assert.equal(f.children.length, 1); assert.deepEqual(f.stopping, [f.children[0]]);
  f.children[0]!.finish(); await switching; await tick(); assert.equal(f.children.length, 2);
  await f.disposers.get("old")!(); assert.equal(f.children[1]!.exitCode, null); assert.deepEqual(f.stopping, [f.children[0]]);
  assert.equal(f.logs.filter(value => value.startsWith("stop-owner")).length, 1);
});

test("memory hot rollback starts the replacement scheduler and clears only its own pointer on removal", { timeout: 15000 }, async t => {
  const f = fixture(t, "memory-consolidation"); await f.kernel.switch([f.candidate("old")]); f.host.memoryConsolidationScheduler!.start();
  await f.kernel.switch([f.candidate("next")]); await f.kernel.switch([f.candidate("old")]);
  assert.deepEqual(f.scans, [0, 1, 2]); assert.equal(f.host.memoryConsolidationScheduler!.isStarted(), true);
  await f.disposers.get("next")!(); assert.equal(f.host.memoryConsolidationScheduler, f.schedulers[2]);
  await f.kernel.switch([]); assert.equal(f.host.memoryConsolidationScheduler, undefined);
});

test("memory legacy predecessor fails with a concrete migration boundary while preserving the original pointer", async t => {
  const f = fixture(t, "memory-consolidation"); await f.kernel.switch([f.candidate("old")]);
  const originalGeneration = f.kernel.current(), original = f.schedulers[0]!;
  // Old idle instances expose no reliable started-vs-not-ready fact.
  const legacy = { start() {}, stop: () => Promise.resolve(), reschedule() {} } as unknown as MemoryConsolidationScheduler;
  f.host.memoryConsolidationScheduler = legacy;
  await assert.rejects(f.kernel.switch([f.candidate("new")]), { code: "memory_scheduler_activation_requires_switch" });
  assert.equal(f.kernel.current(), originalGeneration); assert.equal(f.host.memoryConsolidationScheduler, legacy);
  assert.equal(f.logs.filter(value => value.startsWith("stop-owner")).length, 0);
  f.host.memoryConsolidationScheduler = original;
});

test("memory legacy factory rejects the candidate before any startup or owner shutdown", async t => {
  const f = fixture(t, "memory-consolidation"); await f.kernel.switch([f.candidate("old")]);
  const original = f.host.memoryConsolidationScheduler;
  f.host.createMemoryConsolidationScheduler = () => ({ start() {}, stop: () => Promise.resolve() } as unknown as MemoryConsolidationScheduler);
  const result = await f.kernel.switch([f.candidate("new")]);
  assert.match(result.generation.records[0]!.error!.message, /factory lacks activation lifecycle state/);
  assert.equal(f.host.memoryConsolidationScheduler, original); assert.equal(f.logs.filter(value => value.startsWith("stop-owner")).length, 0);
});

test("automation replacement waits for original plan work and removes subscription before starting new reminders", { timeout: 15000 }, async t => {
  const f = fixture(t, "message-processing-automation"), entered = deferred(), release = deferred(); f.cleanup.push(release.resolve);
  f.planWork(async () => { entered.resolve(); await release.promise; });
  await f.kernel.switch([f.candidate("old")]); f.firePlan(); await entered.promise;
  const published = f.nextPublication(); let finished = false; const switching = f.kernel.switch([f.candidate("next")]).then(() => { finished = true; });
  await published; await tick(); assert.equal(f.subscribers.size, 0); assert.equal(finished, false); assert.equal(f.logs.filter(value => value === "automation-start").length, 1);
  release.resolve(); await switching; assert.equal(f.subscribers.size, 1); assert.equal(f.logs.filter(value => value === "automation-start").length, 2);
  const currentAutomation = f.host.messageProcessingAutomationService, currentKnowledge = f.host.knowledgeCallbackReminderService;
  await f.disposers.get("old")!(); assert.equal(f.host.messageProcessingAutomationService, currentAutomation); assert.equal(f.host.knowledgeCallbackReminderService, currentKnowledge); assert.equal(f.subscribers.size, 1);
});

test("automation retirement joins accepted original reminder delivery and startup failure cleans both native owners", { timeout: 15000 }, async t => {
  const f = fixture(t, "message-processing-automation"), entered = deferred(), release = deferred(); f.cleanup.push(release.resolve);
  f.reminderWork(async () => { entered.resolve(); await release.promise; });
  await f.kernel.switch([f.candidate("old")]); f.timers.find(timer => timer.owner.startsWith("automation:"))!.callback(); await entered.promise;
  const published = f.nextPublication(); let finished = false; const switching = f.kernel.switch([f.candidate("next")]).then(() => { finished = true; }); await published; await tick(); assert.equal(finished, false);
  release.resolve(); await switching;
  f.failKnowledgeStart(); await f.kernel.switch([f.candidate("broken-startup")]);
  const failure = await f.runtimeFailure;
  await f.retired.get("broken-startup")!.promise;
  assert.equal(failure.generation.records[0]!.error?.code, "runtime_failed"); assert.equal(f.subscribers.size, 0);
  assert.equal(f.host.messageProcessingAutomationService, undefined); assert.equal(f.host.knowledgeCallbackReminderService, undefined);
  assert.equal(f.timers.filter(timer => !timer.cleared).length, 0);
});

test("automation revision rollback starts one subscription and late disposal cannot clear the restored owners", async t => {
  const f = fixture(t, "message-processing-automation");
  await f.kernel.switch([f.candidate("old")]); await f.kernel.switch([f.candidate("next")]); await f.kernel.switch([f.candidate("old")]);
  const automation = f.host.messageProcessingAutomationService, knowledge = f.host.knowledgeCallbackReminderService;
  await f.disposers.get("next")!();
  assert.equal(f.host.messageProcessingAutomationService, automation); assert.equal(f.host.knowledgeCallbackReminderService, knowledge);
  assert.equal(f.subscribers.size, 1); assert.equal(f.logs.filter(value => value === "automation-start").length, 3);
  await f.kernel.switch([]); assert.equal(f.subscribers.size, 0); assert.equal(f.host.messageProcessingAutomationService, undefined);
});

test("automation cleanup failure still joins the other owner and prevents replacement startup", { timeout: 15000 }, async t => {
  const f = fixture(t, "message-processing-automation"), entered = deferred(), release = deferred(); f.cleanup.push(release.resolve);
  await f.kernel.switch([f.candidate("old")]);
  const stopAutomation = f.automations[0]!.stop.bind(f.automations[0]);
  f.automations[0]!.stop = async () => { await stopAutomation(); throw new Error("Controlled old reminder cleanup failure."); };
  const stopKnowledge = f.reminders[0]!.stop.bind(f.reminders[0]);
  f.reminders[0]!.stop = async () => { const pending = stopKnowledge(); entered.resolve(); await release.promise; await pending; };
  let finished = false; const switching = f.kernel.switch([f.candidate("next")]).then(value => { finished = true; return value; });
  await entered.promise; await tick(); assert.equal(finished, false); assert.equal(f.subscribers.size, 0);
  assert.equal(f.logs.filter(value => value === "automation-start").length, 1);
  release.resolve(); const result = await switching;
  const failure = await f.runtimeFailure;
  await f.retired.get("next")!.promise;
  assert.equal(failure.generation.records[0]!.error?.code, "runtime_failed");
  assert.match(result.generation.cleanupDiagnostics.map(value => value.message).join("\n"), /Controlled old reminder cleanup failure/);
  assert.equal(f.host.messageProcessingAutomationService, undefined); assert.equal(f.host.knowledgeCallbackReminderService, undefined);
  await assert.rejects(Promise.resolve(f.disposers.get("old")!()), /Controlled old reminder cleanup failure/);
});
