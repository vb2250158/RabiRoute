import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentRequestStore, AgentRequestStoreUnavailableError } from "./store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions } from "./endpointDelivery.js";
import { configureTimeouts, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { acquireFileLockSync } from "../shared/filePersistence.js";
import { createOperationContext, installDataMutationAuditSink, runWithOperationContext } from "../observability/dataMutationAudit.js";

const preparation = () => ({ source: { threadId: "fixture-source", agentType: "agent" }, target: { threadId: "fixture-target", agentType: "agent" },
  responsePolicy: "required" as const, responseInstruction: "Return the fixture result." });

test("owner accepts the public timeout range and its real worker consumes only the committed timeout snapshot", { timeout: 15000 }, async t => {
  const previous = readTimeoutOverrides(), secret = process.env.RABI_TEST_PRIVATE_WORKER_VALUE;
  t.after(() => { configureTimeouts(previous); if (secret === undefined) delete process.env.RABI_TEST_PRIVATE_WORKER_VALUE; else process.env.RABI_TEST_PRIVATE_WORKER_VALUE = secret; });
  configureTimeouts({ ...previous, "backend.agentRequests.store.owner.timeoutMs": 600000, "storage.deliveryOwnerLock": 50 });
  process.env.RABI_TEST_PRIVATE_WORKER_VALUE = "fixture-private-value";
  // The launcher must read the configuration owner, not copy a mutable environment string.
  process.env.RABIROUTE_TIMEOUT_OVERRIDES = JSON.stringify({ "storage.deliveryOwnerLock": 1000 });
  const f = await fixture(t), owner = f.store();
  await owner.ready();
  const prepared = await owner.prepare(preparation());
  assert.equal(owner.get(prepared.requestId!)?.status, "pending_delivery");
  await owner.close();

  const release = acquireFileLockSync(`${f.statePath}.owner.lock`);
  t.after(release);
  const worker = path.join(f.root, "timeout-worker.mjs"), evidence = path.join(f.root, "timeout-evidence.json");
  const source = new URL(import.meta.url.endsWith(".ts") ? "./persistenceWorker.ts" : "./persistenceWorker.js", import.meta.url).href;
  const settings = new URL(import.meta.url.endsWith(".ts") ? "../shared/timeoutSettings.ts" : "../shared/timeoutSettings.js", import.meta.url).href;
  await fs.writeFile(worker, `import fs from 'node:fs';
const { readTimeoutOverrides } = await import(${JSON.stringify(settings)});
const snapshot = readTimeoutOverrides();
const open = fs.openSync, now = Date.now; let elapsed = 0, attempts = 0;
Date.now = () => now() + elapsed;
fs.openSync = function(file, ...args) {
  if (String(file) === process.argv[2] + '.owner.lock') {
    attempts++; elapsed += 10;
    fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ attempts, snapshot, privateValue: process.env.RABI_TEST_PRIVATE_WORKER_VALUE ?? null }));
  }
  return Reflect.apply(open, this, [file, ...args]);
};
await import(${JSON.stringify(source)});
`);
  const contender = f.store(undefined, { workerURL: pathToFileURL(worker) });
  await assert.rejects(contender.ready(), AgentRequestStoreUnavailableError);
  await contender.close();
  const result = JSON.parse(await fs.readFile(evidence, "utf8"));
  assert.equal(result.snapshot["storage.deliveryOwnerLock"], 50);
  assert.equal(result.snapshot["backend.agentRequests.store.owner.timeoutMs"], 600000);
  assert.equal(result.privateValue, null);
  assert.ok(result.attempts >= 1 && result.attempts <= 5, "the real lock acquisition must consume the 50 ms override, not its 1000 ms default");
  for (const timeoutMs of [0, 2.5, 2147483648]) assert.throws(() => f.store(undefined, { timeoutMs }), /expected integer milliseconds/);
});

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-agent-request-worker-"));
  const owners = new Set<AgentRequestStore>(), statePath = path.join(root, "agent-requests.json");
  t.after(async () => { await Promise.allSettled([...owners].map(owner => owner.close())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, statePath, store(now?: () => Date, options?: ConstructorParameters<typeof AgentRequestStore>[2]) {
    const owner = new AgentRequestStore(statePath, now, options); owners.add(owner); return owner;
  } };
}
async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) { if (performance.now() >= deadline) throw new Error("Fixture condition did not become true."); await delay(10); }
}
async function controlledWorker(root: string) {
  const source = new URL(import.meta.url.endsWith(".ts") ? "./persistenceWorker.ts" : "./persistenceWorker.js", import.meta.url).href;
  const file = path.join(root, "controlled-worker.mjs");
  await fs.writeFile(file, `import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const original = fs.renameSync;
fs.renameSync = function(source, destination) {
  fs.writeFileSync(root + '/entered', '1');
  while (fs.existsSync(root + '/hold')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (fs.existsSync(root + '/fail')) throw new Error('fixture durable replacement failed');
  original(source, destination);
  if (fs.existsSync(root + '/die')) process.exit(81);
};
await import(${JSON.stringify(source)});
`);
  return pathToFileURL(file);
}

test("real file owner resolves a renamed instance caller to its original committed receipt after restart", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const party = (id: string, alias = id) => ({ threadId: id, agentAdapter: "dsh" as const, agentType: "agent",
    endpoint: { kind: "instance" as const, managerInstanceId: "manager", instanceId: id, nodeId: id, agentId: alias,
      provider: "dsh", sessionId: id, authorizationIncarnation: "epoch" } });
  let dispatched = 0, alias = "source";
  const store = f.store();
  const options: EndpointDeliveryOptions = { store, managerInstanceId: "manager", resolveSource: () => party("source", alias), resolveTarget: () => party("target"),
    resolveExecutionOptions: () => ({}), authorize: () => {}, reconcile: async () => undefined,
    dispatch: async delivery => { dispatched++; return { deliveryId: delivery.deliveryId, generation: delivery.generation,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target, accepted: true, action: "started", transport: "fixture" }; } };
  const request = { action: "send" as const, deliveryId: "stable-caller", sourceThreadId: "source", sourceAgentType: "agent" as const,
    threadId: "target", agentAdapter: "dsh" as const, responsePolicy: "none" as const, prompt: "fixture body",
    messageSource: { type: "agent" as const, agentAdapter: "dsh" as const, sessionId: "source", sessionName: "Source" } };
  const before = await executeEndpointAgentDelivery(request, options); await store.close();
  alias = "renamed-source";
  const restarted = f.store();
  const after = await executeEndpointAgentDelivery(request, { ...options, store: restarted });
  assert.equal((after.data.delivery as { deliveryId: string }).deliveryId, (before.data.delivery as { deliveryId: string }).deliveryId);
  assert.equal(dispatched, 1);
});

test("file owner loads asynchronously, commits before success and remains old-reader compatible", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store();
  t.after(() => store.close());
  assert.throws(() => store.list(), AgentRequestStoreUnavailableError);
  assert.equal(store.getEndpointDeliveryEvidenceStatus().available, false);
  await store.ready();
  const prepared = await store.prepare(preparation());
  assert.equal(store.get(prepared.requestId!)?.status, "pending_delivery");
  const disk = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.requests[prepared.requestId!].status, "pending_delivery");
  await store.close();
  const restarted = f.store();
  t.after(() => restarted.close());
  await restarted.ready();
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.get(prepared.requestId!))), JSON.parse(JSON.stringify(store.get(prepared.requestId!))));
});

test("pending durable commit publishes no tentative reminder fields, events or success", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store(undefined, { workerURL: await controlledWorker(f.root) });
  t.after(() => store.close());
  const prepared = await store.prepare(preparation());
  await store.commit(prepared);
  await fs.rm(path.join(f.root, "entered"), { force: true });
  await fs.writeFile(path.join(f.root, "hold"), "1");
  let complete = false, events = 0;
  store.onEndpointDeliveryChange(() => { events++; });
  const pending = store.recordReminderResult(prepared.requestId!, false, new Error("fixture target unavailable")).finally(() => { complete = true; });
  try {
    await until(() => fs.access(path.join(f.root, "entered")).then(() => true, () => false));
    assert.equal(store.get(prepared.requestId!)?.reminderCount, 0);
    assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).requests[prepared.requestId!].reminderCount, 0);
    assert.equal(events, 0); assert.equal(complete, false);
  } finally { await fs.rm(path.join(f.root, "hold"), { force: true }); await pending; }
  assert.equal(events, 1);
  assert.equal(store.get(prepared.requestId!)?.reminderCount, 1);
});

test("failed durable reminder write discards its draft and a later mutation uses committed fields", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store(undefined, { workerURL: await controlledWorker(f.root) });
  t.after(() => store.close());
  const prepared = await store.prepare(preparation()); await store.commit(prepared);
  const before = store.get(prepared.requestId!), original = await fs.readFile(f.statePath);
  await fs.writeFile(path.join(f.root, "fail"), "1");
  await assert.rejects(store.recordReminderResult(prepared.requestId!, false, "fixture failure"), /durable replacement failed/);
  assert.deepEqual(store.get(prepared.requestId!), before);
  assert.deepEqual(await fs.readFile(f.statePath), original);
  await fs.rm(path.join(f.root, "fail"));
  const committed = await store.recordReminderResult(prepared.requestId!, true);
  assert.equal(committed.reminderCount, 1);
  assert.equal(committed.lastReminderError, undefined);
});

test("worker loss after durable replacement fences the unknown result and close waits real child exit", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store(undefined, { workerURL: await controlledWorker(f.root) });
  t.after(() => store.close().catch(() => {}));
  const prepared = await store.prepare(preparation()); await store.commit(prepared);
  await fs.writeFile(path.join(f.root, "die"), "1");
  await assert.rejects(store.recordReminderResult(prepared.requestId!, true), (error: any) => error.code === "AGENT_REQUEST_COMMIT_UNKNOWN" && error.commitState === "unknown");
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).requests[prepared.requestId!].reminderCount, 1);
  assert.throws(() => store.get(prepared.requestId!), AgentRequestStoreUnavailableError);
  await assert.rejects(store.cancel(prepared.requestId!), AgentRequestStoreUnavailableError);
  await assert.rejects(store.close(), AgentRequestStoreUnavailableError);
});

test("close drains an accepted commit and excludes subsequent mutations", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store(undefined, { workerURL: await controlledWorker(f.root) });
  t.after(() => store.close());
  const prepared = await store.prepare(preparation()); await store.commit(prepared);
  await fs.rm(path.join(f.root, "entered"), { force: true }); await fs.writeFile(path.join(f.root, "hold"), "1");
  const mutation = store.recordReminderResult(prepared.requestId!, true);
  await until(() => fs.access(path.join(f.root, "entered")).then(() => true, () => false));
  const queued = store.recordReminderResult(prepared.requestId!, false, "This mutation must never be dispatched.");
  const rejectedQueued = assert.rejects(queued, (error: any) => error.statusCode === 503 && error.commitState === "not_started");
  let closed = false;
  const closing = store.close().then(() => { closed = true; });
  try { await rejectedQueued; await delay(30); assert.equal(closed, false); await assert.rejects(store.cancel(prepared.requestId!), /closing/); }
  finally { await fs.rm(path.join(f.root, "hold"), { force: true }); await mutation; await closing; }
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).requests[prepared.requestId!].reminderCount, 1);
});

test("corrupt file is local unavailable evidence and close still retires its worker", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await fs.writeFile(f.statePath, "{fixture-damaged");
  const store = f.store(); t.after(() => store.close());
  await assert.rejects(store.ready(), AgentRequestStoreUnavailableError);
  assert.throws(() => store.list(), AgentRequestStoreUnavailableError);
  await assert.rejects(store.prepare(preparation()), AgentRequestStoreUnavailableError);
  assert.equal(await fs.readFile(f.statePath, "utf8"), "{fixture-damaged");
});

test("injected memory owner initializes synchronously but all mutations settle asynchronously", async () => {
  let persisted: unknown, fail = false;
  const store = new AgentRequestStore({ read: () => persisted, write: value => { if (fail) throw undefined; persisted = structuredClone(value); } });
  assert.deepEqual(store.list(), []);
  const prepared = await store.prepare(preparation()); await store.commit(prepared);
  fail = true;
  let rejected = false;
  await store.recordReminderResult(prepared.requestId!, true).then(() => assert.fail("Expected rejection"), error => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true); assert.equal(store.get(prepared.requestId!)?.reminderCount, 0);
  await store.close();
});

test("one physical state file has one active writer and a rejected second owner cannot change it", { timeout: 15_000 }, async t => {
  const f = await fixture(t), owner = f.store(), contender = f.store();
  t.after(async () => { await Promise.allSettled([owner.close(), contender.close()]); });
  // Either child may win startup ordering, but exactly one owns the physical file.
  const ready = await Promise.allSettled([owner.ready(), contender.ready()]);
  assert.equal(ready.filter(result => result.status === "fulfilled").length, 1);
  const winner = ready[0]!.status === "fulfilled" ? owner : contender;
  const loser = winner === owner ? contender : owner;
  const prepared = await winner.prepare(preparation());
  await assert.rejects(loser.prepare(preparation()), AgentRequestStoreUnavailableError);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(f.statePath, "utf8")).requests).length, 1);
  assert.equal(winner.get(prepared.requestId!)?.status, "pending_delivery");
  await loser.close();
});

test("known worker initialization failure is local unavailable and actual child close is clean retirement", { timeout: 10_000 }, async t => {
  const f = await fixture(t), store = new AgentRequestStore(f.statePath, undefined,
    { workerURL: pathToFileURL(path.join(f.root, "missing-fixture-worker.mjs")), timeoutMs: 3000 });
  t.after(() => store.close());
  await assert.rejects(store.ready(), AgentRequestStoreUnavailableError);
  await assert.rejects(store.prepare(preparation()), AgentRequestStoreUnavailableError);
  await store.close();
  await assert.rejects(fs.readFile(f.statePath), (error: any) => error.code === "ENOENT");
});

test("throwing or rejected observers cannot roll back a durable result or deadlock a reentrant mutation", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store();
  const prepared = await store.prepare(preparation());
  const messages: string[] = [];
  t.mock.method(console, "error", (value: string) => { messages.push(value); });
  const removeSink = installDataMutationAuditSink(() => { throw new Error("fixture audit observer failure"); });
  t.after(removeSink);
  store.onEndpointDeliveryChange(() => { throw new Error("fixture synchronous observer failure"); });
  store.onEndpointDeliveryChange(async () => { throw new Error("fixture asynchronous observer failure"); });
  let reentered = false, followup: Promise<unknown> | undefined;
  store.onEndpointDeliveryChange(() => {
    if (!reentered) { reentered = true; followup = store.cancel(prepared.requestId!, "fixture reentrant cancellation"); return followup; }
  });
  const committed = await store.commit(prepared);
  assert.equal(committed.request?.status, "awaiting_response");
  await followup;
  await delay(0);
  assert.equal(store.get(prepared.requestId!)?.status, "cancelled");
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).requests[prepared.requestId!].status, "cancelled");
  assert.equal(messages.length, 4);
  await store.close();
});

test("injected persistence acknowledgement loss has the same unknown fence as a file worker", async () => {
  let persisted: any, unknown = false;
  const store = new AgentRequestStore({ read: () => persisted, write: value => {
    persisted = structuredClone(value);
    if (unknown) throw Object.assign(new Error("fixture replacement acknowledgement lost"), { commitState: "unknown" });
  } });
  const prepared = await store.prepare(preparation()); await store.commit(prepared);
  unknown = true;
  await assert.rejects(store.recordReminderResult(prepared.requestId!, true), (error: any) => error.code === "AGENT_REQUEST_COMMIT_UNKNOWN");
  assert.equal(persisted.requests[prepared.requestId!].reminderCount, 1);
  assert.throws(() => store.get(prepared.requestId!), AgentRequestStoreUnavailableError);
  await assert.rejects(store.cancel(prepared.requestId!), AgentRequestStoreUnavailableError);
  await assert.rejects(store.close(), AgentRequestStoreUnavailableError);
});

test("close cancels an uncommitted loading child and joins real close without awaiting its readiness budget", { timeout: 10_000 }, async t => {
  const f = await fixture(t), entry = path.join(f.root, "loading-worker.mjs"), started = path.join(f.root, "started");
  await fs.writeFile(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)},'1'); process.on('message',()=>{}); await new Promise(()=>{});`);
  const store = f.store(undefined, { workerURL: pathToFileURL(entry), timeoutMs: 60_000 });
  const rejectedReadiness = assert.rejects(store.ready(), AgentRequestStoreUnavailableError);
  await until(() => fs.access(started).then(() => true, () => false));
  const closing = performance.now(); await store.close();
  assert.ok(performance.now() - closing < 2000, "A read-only initialization must not occupy the mutation drain budget.");
  await rejectedReadiness;
  await assert.rejects(fs.readFile(f.statePath), (error: any) => error.code === "ENOENT");
});

test("an unused file owner closes without starting an initialization child", { timeout: 10_000 }, async t => {
  const f = await fixture(t), store = f.store();
  await store.close();
  await assert.rejects(store.ready(), AgentRequestStoreUnavailableError);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("queued worker commits preserve each caller audit and all AsyncLocalStorage contexts", { timeout: 15_000 }, async t => {
  const f = await fixture(t), store = f.store(undefined, { workerURL: await controlledWorker(f.root) });
  const first = await store.prepare(preparation()), second = await store.prepare(preparation());
  await store.commit(first); await store.commit(second);
  await fs.rm(path.join(f.root, "entered"), { force: true }); await fs.writeFile(path.join(f.root, "hold"), "1");
  const local = new AsyncLocalStorage<string>();
  const audits: Array<{ target: string; actor?: string; requestId?: string; local?: string }> = [];
  const remove = installDataMutationAuditSink(record => {
    if (record.group === "agent.request") audits.push({ target: record.target.id, actor: record.actor.id, requestId: record.requestId, local: local.getStore() });
  });
  t.after(remove);
  const context = (number: number) => createOperationContext({ source: "http", actor: { kind: "agent", id: `fixture-caller-${number}` }, requestId: `fixture-http-${number}` });
  const active = local.run("fixture-local-one", () => runWithOperationContext(context(1), () => store.recordReminderResult(first.requestId!, true)));
  await until(() => fs.access(path.join(f.root, "entered")).then(() => true, () => false));
  const queued = local.run("fixture-local-two", () => runWithOperationContext(context(2), () => store.cancel(second.requestId!, "Fixture cancellation.")));
  const withoutContext = store.recordReminderResult(first.requestId!, false, "Fixture later retry.");
  try { assert.equal(audits.length, 0); }
  finally { await fs.rm(path.join(f.root, "hold"), { force: true }); await Promise.all([active, queued, withoutContext]); }
  assert.deepEqual(audits, [
    { target: first.requestId, actor: "fixture-caller-1", requestId: "fixture-http-1", local: "fixture-local-one" },
    { target: second.requestId, actor: "fixture-caller-2", requestId: "fixture-http-2", local: "fixture-local-two" },
    { target: first.requestId, actor: undefined, requestId: undefined, local: undefined }
  ]);
});
