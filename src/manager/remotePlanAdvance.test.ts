import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import test from "node:test";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import type { PlanItem } from "../roleKnowledge.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import type { RolePlanPageReadInput } from "./managerReadWorkerPool.js";
import { createPlanAdvanceOwner, type PlanAdvanceContext } from "../plugins/io.rabiroute.manager.persona/src/manager/planAdvanceRoutes.js";
import { emptyAdvancePolicy, PlanAdvanceStore, type AdvanceRule } from "./planAdvancePolicy.js";

const sessionId = "same-session-on-each-owner";
const one = { instanceId: "fixture-computer-one", agentId: "fixture-dsh-one" };
const two = { instanceId: "fixture-computer-two", agentId: "fixture-dsh-one" };
const otherAgent = { instanceId: "fixture-computer-one", agentId: "fixture-dsh-two" };
type Checked = { items: Array<{ planId: string; fingerprint: string; eligible: boolean; reason: string }> };
type Run = { items: Array<{ planId: string; state: string; reason?: string }> };
const accepted = (): AgentThreadRequestResult => ({ statusCode: 200, data: { ok: true, status: "delivered" } });

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-plan-advance-"));
  const workflow = ensurePersonaPlanWorkflow(dir), store = new PlanAdvanceStore(dir);
  const rule: AdvanceRule = { enabled: true, prompt: "Inspect the existing original plan.", action: "inspect", condition: "changed", cooldownMinutes: 1, maxRunsPerStep: 2 };
  store.save(dir, { ...emptyAdvancePolicy(), enabled: true, rules: { [workflow.workflow.roles.execution]: rule } }, store.policy(dir).revision);
  const plans = new Map<string, PlanItem>();
  const add = (id: string, instanceBinding?: AgentInstanceBinding) => {
    const plan: PlanItem = {
      id, title: id, focus: "Inspect without creating another owner", status: workflow.workflow.roles.execution, archiveStatus: "未归档",
      currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect the original plan" }], attachments: [], keywords: ["fixture"],
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", storageRevision: id + "-revision-one",
      taskBinding: { agentType: "dsh", sessionId, workspace: dir, completionHook: { enabled: false }, ...(instanceBinding ? { instanceBinding } : {}) }
    };
    plans.set(id, plan); return plan;
  };
  add("local"); add("one-first", one); add("one-second", one); add("two", two); add("other-agent", otherAgent);
  const queries: RolePlanPageReadInput[] = [], sent: AgentThreadRequest[] = [], sockets: Socket[] = [];
  let sender: (request: AgentThreadRequest) => Promise<AgentThreadRequestResult> = async () => accepted();
  const context: PlanAdvanceContext = {
    roleDir: () => dir,
    getPlanAsync: async (_roleDir, id) => plans.get(id) ?? null,
    listFeedback: async () => [],
    worker: {
      run: async () => workflow,
      // Deliberately return an over-broad bounded test inventory: the owner must
      // fence wrong endpoints too, while the separate pagination tests own filtering.
      queryRolePlanPage: async (_roleDir: string, query: RolePlanPageReadInput) => { queries.push(query); return { items: [...plans.keys()].map(id => ({ id })), total: plans.size, nextCursor: "" }; }
    } as unknown as PlanAdvanceContext["worker"],
    service: {
      inspectPlans: async items => items.map(plan => ({ planId: plan.id, checkedAt: "2026-01-02", taskAgent: {
        role: "task", configured: true, agentType: "dsh", threadId: sessionId, threadTitle: plan.title, workspace: dir,
        instanceBinding: plan.taskBinding?.instanceBinding, working: false, agentStatus: "idle", sessionStatus: "idle", canOpen: true, checkedAt: "2026-01-02"
      } })),
      openPlanAgent: async () => { throw new Error("Advance must not open another task."); }
    },
    send: async request => { sent.push(structuredClone(request)); return sender(request); }
  };
  const owner = createPlanAdvanceOwner(context);
  const body = (instanceBinding?: AgentInstanceBinding, planIds?: string[]) => ({ workspace: dir, sessionIds: [sessionId], trigger: "manual", ...(instanceBinding ? { instanceBinding } : {}), ...(planIds ? { planIds } : {}) });
  const execute = async (action: "check" | "run", value: unknown, activeOwner = owner) => {
    const socket = new Socket(); sockets.push(socket);
    return activeOwner.prepare(new http.IncomingMessage(socket), "Fixture").execute(action, value);
  };
  const check = (instanceBinding?: AgentInstanceBinding, planIds?: string[]) => execute("check", body(instanceBinding, planIds)) as Promise<Checked>;
  const run = (checked: Checked, instanceBinding?: AgentInstanceBinding, planIds?: string[]) => execute("run", { ...body(instanceBinding, planIds), expected: Object.fromEntries(checked.items.map(item => [item.planId, item.fingerprint])) }) as Promise<Run>;
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, plans, queries, sent, context, body, execute, check, run, setSender: (value: typeof sender) => { sender = value; } };
}

test("advance checks fence equal session IDs by local, instance and Agent owner before status and dispatch", async t => {
  const f = fixture(t);
  for (const [endpoint, expectedIds] of [[undefined, ["local"]], [one, ["one-first", "one-second"]], [two, ["two"]], [otherAgent, ["other-agent"]]] as const) {
    const checked = await f.check(endpoint);
    const allowed = new Set<string>(expectedIds);
    assert.deepEqual(checked.items.filter(item => item.eligible).map(item => item.planId).sort(), [...expectedIds].sort());
    assert.ok(checked.items.filter(item => !allowed.has(item.planId)).every(item => item.reason === "binding_mismatch"));
    assert.deepEqual(f.queries.at(-1)?.bindingScope?.instanceBinding, endpoint);
  }
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.store.read().receipts, {});
});

test("one exact remote owner receives a single combined request and durable per-plan receipts while other owners remain untouched", async t => {
  const f = fixture(t), checked = await f.check(one);
  const result = await f.run(checked, one);
  assert.deepEqual(result.items.filter(item => item.state === "accepted").map(item => item.planId).sort(), ["one-first", "one-second"]);
  assert.equal(f.sent.length, 1);
  const request = f.sent[0]!;
  assert.deepEqual(request.instanceBinding, one);
  assert.equal(request.threadId, sessionId);
  assert.equal(request.agentAdapter, "dsh");
  assert.equal(request.createIfMissing, false);
  assert.equal(request.cwd, f.queries[0]?.bindingScope?.workspace);
  assert.match(request.prompt!, /one-first/); assert.match(request.prompt!, /one-second/);
  assert.doesNotMatch(request.prompt!, /plans\/(local|two|other-agent)(?:\n|\b)/);
  const persisted = new PlanAdvanceStore(f.dir).read();
  assert.equal(Object.keys(persisted.receipts).length, 2);
  for (const id of ["one-first", "one-second"]) assert.equal(persisted.receipts[f.store.receiptKey(f.dir, id)]?.state, "accepted");
  assert.equal(persisted.receipts[f.store.receiptKey(f.dir, "two")], undefined);
  const reopened = createPlanAdvanceOwner(f.context);
  const after = await f.execute("check", f.body(one), reopened) as Checked;
  assert.ok(after.items.filter(item => item.planId.startsWith("one-")).every(item => !item.eligible && item.reason === "already_consumed"));
  await f.execute("run", { ...f.body(one), expected: Object.fromEntries(checked.items.map(item => [item.planId, item.fingerprint])) }, reopened);
  assert.equal(f.sent.length, 1, "restart/check must not replay accepted receipts");
});

test("a busy exact owner blocks its second plan but does not block the same session on another instance or Agent", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  f.setSender(async request => {
    if (request.instanceBinding?.instanceId === one.instanceId && request.instanceBinding.agentId === one.agentId) { enter(); await released; }
    return accepted();
  });
  const a1 = await f.check(one, ["one-first"]), a2 = await f.check(one, ["one-second"]);
  const b = await f.check(two, ["two"]), c = await f.check(otherAgent, ["other-agent"]), local = await f.check(undefined, ["local"]);
  const pending = f.run(a1, one, ["one-first"]);
  try {
    await entered;
    const busy = await f.run(a2, one, ["one-second"]);
    assert.deepEqual(busy.items, [{ planId: "one-second", state: "skipped", reason: "session_reserved" }]);
    assert.equal(f.store.read().receipts[f.store.receiptKey(f.dir, "one-second")], undefined);
    // Each other owner completes while the first send is still in flight.
    // Persisted writes share one JSON owner, so do not turn this identity test
    // into unrelated simultaneous async-read/sync-rename file contention.
    const otherResults = [await f.run(b, two, ["two"]), await f.run(c, otherAgent, ["other-agent"]), await f.run(local, undefined, ["local"])];
    assert.ok(otherResults.every(result => result.items.length === 1 && result.items[0]?.state === "accepted"), JSON.stringify(otherResults));
    assert.equal(f.sent.length, 4);
    assert.deepEqual(f.sent.find(request => request.prompt?.includes('"planId":"other-agent"'))?.instanceBinding, otherAgent);
    assert.deepEqual(f.sent.find(request => request.prompt?.includes('"planId":"two"'))?.instanceBinding, two);
    assert.equal(f.sent.find(request => request.prompt?.includes('"planId":"local"'))?.instanceBinding, undefined);
  } finally { release(); await pending; }
  const retry = await f.run(a2, one, ["one-second"]);
  assert.equal(retry.items[0]?.state, "accepted");
  assert.equal(f.sent.length, 5);
  assert.equal(new Set(f.sent.map(request => request.deliveryId)).size, 5);
});

test("an uncertain remote reservation remains under its original plan after re-open and cannot be replayed by a new owner", async t => {
  const f = fixture(t);
  f.setSender(async request => request.instanceBinding?.instanceId === one.instanceId && request.instanceBinding.agentId === one.agentId
    ? { statusCode: 202, data: { ok: false, status: "delivery_unconfirmed" } } : accepted());
  const checked = await f.check(one, ["one-first"]);
  const result = await f.run(checked, one, ["one-first"]);
  assert.equal(result.items[0]?.state, "uncertain");
  const receipt = new PlanAdvanceStore(f.dir).read().receipts[f.store.receiptKey(f.dir, "one-first")]!;
  assert.equal(receipt.state, "uncertain");
  const plan = f.plans.get("one-first")!;
  f.plans.set(plan.id, { ...plan, storageRevision: plan.storageRevision + "-rebound", taskBinding: { ...plan.taskBinding!, instanceBinding: two } });
  const reopened = createPlanAdvanceOwner(f.context);
  const later = await f.execute("check", f.body(two, [plan.id]), reopened) as Checked;
  assert.equal(later.items[0]?.reason, "delivery_uncertain");
  const blocked = await f.execute("run", { ...f.body(two, [plan.id]), expected: { [plan.id]: later.items[0]!.fingerprint } }, reopened) as Run;
  assert.equal(blocked.items[0]?.state, "skipped");
  assert.equal(f.sent.length, 1, "changing instance cannot replay the original uncertain business operation");
  assert.equal(new PlanAdvanceStore(f.dir).read().receipts[f.store.receiptKey(f.dir, plan.id)]?.id, receipt.id);
  const differentPlan = await f.check(two, ["two"]);
  assert.equal((await f.run(differentPlan, two, ["two"])).items[0]?.state, "accepted");
  assert.equal(f.sent.length, 2);
});
