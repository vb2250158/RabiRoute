import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "./personaStorageOperations.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerReadWorkerPool, managerCatalogWorkerPool, managerKnowledgePageWorkerPool, type ManagerReadWorkerChild } from "./managerReadWorkerPool.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import type { ApiOperationInput, ApiOperationResult } from "./apiOperationContract.js";
import { RoleStorageApplicationError } from "./roleStorageApplication.js";

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: test.TestContext, customize?: (context: PersonaStorageOperationsContext) => Partial<PersonaStorageOperationsContext>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-storage-api-")), roleDir = path.join(root, "Fixture"); fs.mkdirSync(roleDir);
  ensurePersonaPlanWorkflow(roleDir);
  const identity = { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" };
  const reads = new ManagerReadWorkerPool({ maxConcurrency: 2, timeoutMs: 30_000 });
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, currentIdentity: () => identity, readPool: reads, catalogReadPool: reads });
  let currentApplication = application, currentDirectory = roleDir, readOnly = false;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [], scheduled: unknown[][] = [], actorInputs: Record<string, unknown>[] = [];
  let reschedules = 0;
  const context: PersonaStorageOperationsContext = {
    application: () => currentApplication, roleDirectory: () => currentDirectory, identity: () => identity, readOnly: () => readOnly,
    planHistoryContext: async (_request, body, command) => { actorInputs.push(body); return { ...command, actor: { kind: "unknown" } }; },
    scheduleFeedbackPostCommit: (...args) => { scheduled.push(args); }, reportFeedbackScheduleError: () => {},
    publish: (type, data) => { events.push({ type, data }); }, rescheduleMemory: () => { reschedules++; }, noteMemoryRunCompleted: () => {},
    pools: { knowledge: reads, catalog: reads, read: reads }
  };
  Object.assign(context, customize?.(context));
  const owner = new PersonaStorageOwner(context), definitions = createPersonaStorageOperations(owner), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("persona-storage-fixture", definitions);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") }), credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-empty-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await owner.stop(); await application.stop(); await reads.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  async function send(suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, prefix = "/api/roles/Fixture/") {
    const response = await fetch(baseUrl + prefix + suffix, { method, headers: { authorization: "Bearer " + credential.token, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }
  return { root, roleDir, application, context, owner, definitions, registration, reads, send, events, scheduled, actorInputs, authority, credential,
    get reschedules() { return reschedules; }, setReadOnly: (value: boolean) => { readOnly = value; }, changeApplication: (value: RoleStorageApplication) => { currentApplication = value; }, changeDirectory: (value: string) => { currentDirectory = value; }, identity };
}

test("58 exact contracts retain both role prefixes, ignored counts IDs and derived manual IDs", async t => {
  const f = await fixture(t);
  assert.equal(f.definitions.length, 58);
  assert.equal(new Set(f.definitions.map(value => value.contract.operationId)).size, 58);
  for (const { contract } of f.definitions) {
    assert.deepEqual(contract.aliases, ["persona:" + contract.method + ":" + contract.pathTemplate]);
    assert.equal(contract.pathTemplate.includes("*"), false);
    assert.equal(contract.request.body.kind === "passthrough", false);
  }
  const first = await f.send("counts"), ignored = await f.send("counts/ignored", "GET", undefined, {}, "/roles/Fixture/");
  assert.equal(first.status, 200); assert.equal(ignored.status, 200); assert.deepEqual(first.body, ignored.body);
  // Routing coverage uses a controlled action; native persistence behavior is exercised below.
  f.owner.execute = async (spec, input) => ({ status: 200, body: { code: 0, data: { action: spec.id, path: input.path } } });
  for (const { contract } of f.definitions) {
    const url = contract.pathTemplate.replace(":roleId", "Fixture").replace(/:(planId|statusKey|memoryId|runId|ignoredItemId)/g, "fixture-id");
    const response = await f.send(url, contract.method, contract.request.body.kind === "json" ? {} : undefined, {}, "");
    assert.equal(response.status, 200, contract.operationId + ": " + JSON.stringify(response.body)); assert.equal(response.body.data.path.roleId, "Fixture");
  }
});

test("feedback rejects invalid plan IDs before native work while unexpected native errors remain 500", async t => {
  const f = await fixture(t);
  let reads = 0, writes = 0;
  const failures: ApiOperationResult[] = [], originalError = f.owner.error.bind(f.owner);
  f.owner.error = (spec, error) => { const result = originalError(spec, error); failures.push(result); return result; };
  f.application.queries.planFeedback = async () => { reads++; throw new Error("Unexpected native read failure"); };
  f.application.commands.submitPlanFeedback = async () => { writes++; throw new Error("Unexpected native write failure"); };
  for (const prefix of ["/api/roles/Fixture/", "/roles/Fixture/"]) {
    for (const method of ["GET", "POST"]) {
      for (const id of ["%20plan-fixture", "plan-fixture%20", "e%CC%81"]) {
        const response = await f.send("plans/" + id + "/feedback", method, method === "POST" ? {} : undefined, {}, prefix);
        assert.equal(response.status, 400, method + " " + prefix + id + ": " + JSON.stringify(response.body));
        assert.equal(response.body.state, "invalid_request");
        assert.equal(response.body.commitState, "not_started");
      }
    }
  }
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(f.actorInputs.length, 0);
  assert.equal(failures.length, 12); assert.ok(failures.every(result => result.mutationOutcome === "not_started"));
  for (const method of ["GET", "POST"]) {
    const response = await f.send("plans/plan-fixture/feedback", method, method === "POST" ? {} : undefined);
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.equal(response.body.commitState, undefined);
  }
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.ok(failures.slice(12).every(result => result.mutationOutcome === undefined));
});

test("original temporary storage keeps plan CAS, idempotency, view ETags and recorded history through both aliases", { timeout: 90_000 }, async t => {
  const f = await fixture(t), create = { id: "plan-fixture", title: "Fixture Plan", focus: "Controlled test", status: "分析中", currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }], keywords: ["fixture"], actor: { kind: "user", displayName: "forged" } };
  const created = await f.send("plans", "POST", create, { "idempotency-key": "fixture-plan-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.data.id, "plan-fixture"); assert.ok(created.headers.get("etag"));
  const replay = await f.send("plans", "POST", create, { "idempotency-key": "fixture-plan-create" }, "/roles/Fixture/");
  assert.equal(replay.status, 201); assert.equal(replay.headers.get("idempotency-key"), created.headers.get("idempotency-key"));
  const read = await f.send("plans/plan-fixture"); assert.equal(read.status, 200); assert.equal(read.body.data.title, "Fixture Plan");
  const view = await f.send("plans/plan-fixture", "GET", undefined, { "if-plan-view-revision": read.headers.get("x-plan-view-revision")! });
  assert.equal(view.status, 304); assert.equal(view.body, undefined); assert.equal(view.headers.get("etag"), read.headers.get("etag"));
  const changed = await f.send("plans/plan-fixture", "PATCH", { title: "Changed Fixture" }, { "idempotency-key": "fixture-plan-change", "if-match": read.headers.get("etag")! }, "/roles/Fixture/");
  assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.data.title, "Changed Fixture");
  const stale = await f.send("plans/plan-fixture", "PATCH", { title: "Stale Fixture" }, { "idempotency-key": "fixture-plan-stale", "if-match": read.headers.get("etag")! });
  assert.equal(stale.status, 412); assert.equal(stale.body.commitState, "not_started");
  const history = await f.send("plans/plan-fixture/history", "GET", undefined, {}, "/roles/Fixture/");
  assert.equal(history.status, 200); assert.equal(history.body.data.count, 2); assert.equal(history.body.data.records[0].actor.kind, "unknown");
  const after = await f.send("plans/plan-fixture"); assert.equal(after.body.data.title, "Changed Fixture");
  const feedback = await f.send("plans/plan-fixture/feedback", "POST", { feedbackId: "feedback-fixture", kind: "approval_suggestion", author: "user", source: "api", text: "Controlled stored feedback", notifyAgent: false }, { "idempotency-key": "fixture-feedback", "if-match": after.headers.get("etag")! });
  assert.equal(feedback.status, 202, JSON.stringify(feedback.body)); assert.equal(feedback.body.data.id, "feedback-fixture"); assert.equal(f.scheduled[0]![5], f.application);
  const feedbackRead = await f.send("plans/plan-fixture/feedback", "GET", undefined, {}, "/roles/Fixture/"); assert.equal(feedbackRead.status, 200); assert.equal(feedbackRead.body.data.count, 1); assert.ok(feedbackRead.headers.get("etag"));
  const catalog = await f.send("plans"), page = await f.send("plans?limit=1&detail=summary&status=active&status=paused&tag=fixture&tag=other");
  assert.equal(catalog.status, 200); assert.equal(catalog.body.data.length, 1); assert.equal(page.status, 200);
  const query = await f.send("plans/query", "POST", { bindingScope: { agentType: "codex", workspace: f.root, sessionIds: [] }, limit: 1 }); assert.equal(query.status, 200, JSON.stringify(query.body));
  const invalidQuery = await f.send("plans/query", "POST", {}); assert.equal(invalidQuery.status, 400);
});

test("native workflow aliases mutate one revisioned catalog and publish native retirement results", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  let current = await f.send("plan-statuses"); assert.equal(current.status, 200);
  const template = current.body.data.statuses.find((status: { state: string }) => status.state === "enabled"), replacementKey = template.key;
  const created = await f.send("plan-marker-statuses", "POST", { ...template, key: "fixture_status", label: "Fixture", labelEn: "Fixture", legacyAliases: [], order: 900 }, { "idempotency-key": "fixture-status-create", "if-match": current.headers.get("etag")! });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  current = await f.send("plan-statuses", "GET", undefined, {}, "/roles/Fixture/");
  assert.ok(current.body.data.statuses.some((status: { key: string }) => status.key === "fixture_status"));
  const updated = await f.send("plan-statuses/fixture_status", "PATCH", { label: "Renamed Fixture" }, { "idempotency-key": "fixture-status-update", "if-match": current.headers.get("etag")! });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const retired = await f.send("plan-marker-statuses/fixture_status", "DELETE", { replacementKey }, { "idempotency-key": "fixture-status-delete", "if-match": updated.headers.get("etag")! }, "/roles/Fixture/");
  assert.equal(retired.status, 200, JSON.stringify(retired.body)); assert.deepEqual(retired.body.data.migratedPlanIds, []);
  assert.deepEqual(f.events.map(event => event.data.action), ["created", "updated", "retired"]);
});

test("native memory creation, touching, read-only reads and overview keep their original owner", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.send("memory/recent", "POST", { id: "memory-fixture", title: "Fixture Memory", focus: "Controlled", content: "Fixture content", keywords: ["fixture"] }, { "idempotency-key": "fixture-memory-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.body.data.id;
  const first = await f.send("memory/recent/" + id, "GET", undefined, { "idempotency-key": "fixture-memory-view" });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.ok(first.body.data.viewedAt);
  const replay = await f.send("memory/recent/" + id, "GET", undefined, { "idempotency-key": "fixture-memory-view" }, "/roles/Fixture/");
  assert.equal(replay.headers.get("idempotency-key"), first.headers.get("idempotency-key"));
  const updated = await f.send("memory/recent/" + id, "PATCH", { title: "Changed Memory" }, { "idempotency-key": "fixture-memory-update", "x-rabiroute-expected-revision": first.headers.get("etag")! });
  assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(f.reschedules, 2);
  f.setReadOnly(true); const plain = await f.send("memory/recent/" + id); assert.equal(plain.status, 200); assert.equal(plain.body.data.title, "Changed Memory"); assert.equal(plain.headers.has("idempotency-key"), false);
  for (const suffix of ["memory", "memory?counts=1", "memory?limit=1&kind=recent", "memory/recent", "memory/consolidated", "memory/consolidation-runs"]) assert.equal((await f.send(suffix)).status, 200, suffix);
  assert.equal((await f.send("memory?limit=1&kind=invalid")).status, 400);
  assert.equal((await f.send("memory/consolidated/missing")).status, 404);
  assert.equal((await f.send("memory/consolidation-runs/missing")).status, 404);
  f.setReadOnly(false);
  const requested = await f.send("memory/consolidation-requests", "POST", { force: true, includeOlderThanHours: 0, triggerOlderThanHours: 0 }, { "idempotency-key": "fixture-consolidation-request" });
  assert.equal(requested.status, 201, JSON.stringify(requested.body)); const runId = requested.body.data.run.id;
  const run = await f.send("memory/consolidation-runs/" + runId, "GET", undefined, {}, "/roles/Fixture/"); assert.equal(run.status, 200); assert.equal(run.body.data.status, "requested");
  const result = await f.send("memory/consolidation-runs/" + runId + "/result", "POST", [{ id: "consolidated-fixture", title: "Consolidated Fixture", focus: "Controlled", content: "Controlled consolidated content", keywords: ["fixture"] }], { "idempotency-key": "fixture-consolidation-result", "if-match": run.headers.get("etag")! }, "/roles/Fixture/");
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.data.run.status, "completed");
  const consolidated = await f.send("memory/consolidated/consolidated-fixture"); assert.equal(consolidated.status, 200); assert.equal(consolidated.body.data.title, "Consolidated Fixture");
});

for (const change of ["directory", "application", "identity", "disable-enable"] as const) {
  test(`capture rejects ${change} changes after actor await before native writes`, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, () => ({ planHistoryContext: async (_request, _body, command) => { entered.resolve(); await release.promise; return command; } }));
    const pending = f.send("plans", "POST", { id: "plan-fenced", title: "Fenced" }, { "idempotency-key": "fixture-fenced-create" }); await Promise.race([entered.promise, pending.then(() => { throw new Error("Request settled before reaching the controlled owner."); })]);
    if (change === "directory") { const other = path.join(f.root, "Other"); fs.mkdirSync(other); f.changeDirectory(other); }
    if (change === "application") f.changeApplication({} as RoleStorageApplication);
    if (change === "identity") f.identity.managerInstanceId = "replacement-manager";
    if (change === "disable-enable") { f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); }
    release.resolve(); const result = await pending;
    assert.equal(result.status, change === "disable-enable" ? 403 : 409, JSON.stringify(result.body));
    assert.equal(await f.application.queries.plan("Fixture", "plan-fenced").catch(() => null), null);
  });
}

test("new admissions follow the current owner rather than retaining a retired application", async t => {
  const f = await fixture(t); const replacement = new RoleStorageApplication({ rolesRoot: f.root, ...f.identity, readPool: f.reads, catalogReadPool: f.reads }); t.after(() => replacement.stop()); f.changeApplication(replacement);
  const created = await f.send("plans", "POST", { id: "plan-current", title: "Current owner", focus: "Controlled", status: "分析中", currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }], keywords: ["fixture"] }, { "idempotency-key": "fixture-current" });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.ok(await replacement.queries.plan("Fixture", "plan-current"));
});

test("a revoked source suppresses native failure details while retaining trusted uncertainty", async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t), command = f.application.commands.createPlan.bind(f.application.commands);
  f.application.commands.createPlan = async () => { entered.resolve(); await release.promise; throw new RoleStorageApplicationError("private native fixture diagnostic", "indeterminate", 503, "fixture-uncertain-operation", "unknown", "timeout"); };
  t.after(() => { f.application.commands.createPlan = command; });
  const pending = f.send("plans", "POST", { id: "plan-uncertain", title: "Controlled" }, { "idempotency-key": "fixture-uncertain-operation" }); await Promise.race([entered.promise, pending.then(() => { throw new Error("Request settled before reaching the controlled owner."); })]);
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); release.resolve(); const response = await pending;
  assert.equal(response.status, 403); assert.equal(response.body.mutationOutcome, "unknown"); assert.equal(response.body.uncertain, true);
  assert.equal(response.body.errorCode, "API_REQUEST_AUTHORITY_REVOKED"); assert.doesNotMatch(JSON.stringify(response.body), /private native|fixture-uncertain-operation/);
});

test("completed writes retain committed metadata when original owner changes before disclosure", async t => {
  const f = await fixture(t), original = f.application.commands.createRecentMemory.bind(f.application.commands);
  f.application.commands.createRecentMemory = async (...args) => { const receipt = await original(...args); f.identity.managerInstanceId = "replacement-after-commit"; return receipt; };
  const response = await f.send("memory/recent", "POST", { id: "memory-committed", title: "Committed Fixture", focus: "Controlled", content: "Private committed fixture", keywords: ["fixture"] }, { "idempotency-key": "fixture-memory-committed" });
  assert.equal(response.status, 409); assert.equal(response.body.commitState, "committed"); assert.equal(response.body.idempotencyKey, "fixture-memory-committed"); assert.equal(response.body.data, undefined);
  f.identity.managerInstanceId = "fixture-manager"; assert.equal((await f.application.queries.memory("Fixture", "memory-committed"))!.memory.content, "Private committed fixture");
});

test("HTTP timeout returns while retirement still joins the actual original counts worker", { timeout: 10_000 }, async t => {
  class Child extends EventEmitter implements ManagerReadWorkerChild {
    readonly pid = 58_282; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; connected = true;
    override on(event: string, listener: (...args: any[]) => void): this { super.on(event, listener); if (event === "message") queueMicrotask(() => this.emit("message", { type: "ready" })); return this; }
    send(_message: unknown, callback?: (error: Error | null) => void): boolean { callback?.(null); return true; } kill(): boolean { return true; } disconnect() { this.connected = false; } unref() {} close() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit("close", 0, null); }
  }
  const child = new Child(), pool = new ManagerReadWorkerPool({ timeoutMs: 100, terminationTimeoutMs: 5, forceTerminationTimeoutMs: 5, workerFactory: () => child, setWorkerPriority: () => {} });
  t.after(async () => { child.close(); await pool.stop(); });
  const f = await fixture(t, context => ({ pools: { ...context.pools!, knowledge: pool } }));
  const response = await f.send("counts"); assert.equal(response.status, 500); await f.registration.dispose();
  let stopped = false; const stopping = f.owner.stop().then(() => { stopped = true; }); await turn(); assert.equal(stopped, false);
  child.close(); await stopping; assert.equal(stopped, true);
});

test("missing original plan offers scoped name search and recent paging without changing404", async t => {
 const f=await fixture(t);const missing=await f.send("plans/plan-does-not-exist");
 assert.equal(missing.status,404);assert.equal(missing.body.code,-1);assert.equal(missing.body.message,"Plan not found: plan-does-not-exist");
 assert.match(missing.body.nextAction,/api\/roles\/Fixture\/plans\?limit=20&query=/);assert.match(missing.body.nextAction,/sort=updated/);assert.match(missing.body.nextAction,/nextCursor/);assert.match(missing.body.nextAction,/不自动/);
 const unrelated=await f.send("memory/consolidated/missing");assert.equal(unrelated.status,404);assert.equal(unrelated.body.nextAction,undefined);
});


test("default persona reads finish while the real background catalog lane remains occupied", { timeout: 30_000 }, async t => {
  const f = await fixture(t, () => ({ pools: undefined }));
  const workerPath = path.join(f.root, "held-background-reader.cjs");
  fs.writeFileSync(workerPath, `process.on("message", request => { if (request.release) process.exit(0); else process.send({ held: request.task.type }); }); process.send({ type: "ready" });`);
  const entered = deferred();
  const child = fork(workerPath, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.on("message", (message: any) => { if (message.held === "gateway_diagnostics_snapshot") entered.resolve(); });
  // Only the background native process is controlled. Both singleton queues, default
  // owner wiring, HTTP contracts and foreground storage workers remain real.
  t.mock.method(managerCatalogWorkerPool as unknown as { workerFactory: () => ManagerReadWorkerChild }, "workerFactory", () => child);
  const blocked = managerCatalogWorkerPool.run({ type: "gateway_diagnostics_snapshot", input: { runtimes: [], personaPresentations: [] } }).catch(error => error);
  t.after(async () => { await managerCatalogWorkerPool.stop(); await blocked; await managerKnowledgePageWorkerPool.stop(); });
  await entered.promise;
  assert.equal(managerCatalogWorkerPool.status().active, 1);
  const created = await f.send("plans", "POST", { id: "plan-foreground", title: "Foreground", focus: "Fixture", keywords: ["fixture"], status: "分析中", currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }] }, { "idempotency-key": "foreground-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const responses = await Promise.all([f.send("plans"), f.send("plans/plan-foreground/history"), f.send("memory/consolidation-runs")]);
  for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(responses[0]!.body.data.some((plan: { id: string }) => plan.id === "plan-foreground"));
  assert.ok(responses[1]!.body.data.records.length > 0);
  assert.equal(managerCatalogWorkerPool.status().active, 1, "foreground completion must not release or complete background diagnostics");
  assert.equal(managerCatalogWorkerPool.status().queued, 0, "foreground requests never enter the background queue");
});
