import { createHash } from "node:crypto";
import { durableDeliveryReceiptPath, durableDeliveryRequestDigest } from "../../../../manager/durableDeliveryIdempotency.js";
import { readPlanStoragePackage } from "../../../../planStorageRepository.js";
import { createPlan } from "../../../../roleKnowledge.js";
import { planDirectory } from "../../../../planStorageLayout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Socket } from "node:net";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "./personaStorageOperations.js";
import { RoleStorageApplication } from "../../../../manager/roleStorageApplication.js";
import { ManagerReadWorkerError, ManagerReadWorkerPool, managerCatalogWorkerPool, managerKnowledgePageWorkerPool, type ManagerReadWorkerChild } from "../../../../manager/managerReadWorkerPool.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "../../../../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../../../../manager/lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import { registerLanAgentBodyGuard } from "../../../../manager/lanAgentBodyAuthority.js";
import { ensurePersonaPlanWorkflow, readPersonaPlanWorkflow, readPersonaPlanWorkflowAsync } from "../../../../personaPlanWorkflow.js";
import type { ApiOperationInput, ApiOperationResult } from "../../../../manager/apiOperationContract.js";
import { RoleStorageApplicationError } from "../../../../manager/roleStorageApplication.js";

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
    registerLanAgentBodyGuard(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await owner.stop(); await application.stop(); await reads.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  async function send(suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, prefix = "/api/roles/Fixture/", signal?: AbortSignal) {
    const response = await fetch(baseUrl + prefix + suffix, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }
  return { root, roleDir, application, context, owner, definitions, registration, reads, send, events, scheduled, actorInputs, authority, credential,
    get reschedules() { return reschedules; }, setReadOnly: (value: boolean) => { readOnly = value; }, changeApplication: (value: RoleStorageApplication) => { currentApplication = value; }, changeDirectory: (value: string) => { currentDirectory = value; }, identity };
}

test('memory overview HTTP reports a local bad row while preserving healthy memories and original bytes',async t=>{
 const f=await fixture(t),directory=path.join(f.roleDir,'memory/recent');fs.mkdirSync(directory,{recursive:true});
 const healthy={id:'healthy-overview',title:'Healthy overview',content:'Synthetic memory',keywords:['healthy']};
 fs.writeFileSync(path.join(directory,'good.json'),JSON.stringify(healthy));const bad=path.join(directory,'bad.json');fs.writeFileSync(bad,JSON.stringify({...healthy,id:'bad-overview',title:{toString:null}}));const before=fs.readFileSync(bad);
 const response=await f.send('memory');assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.partial,true);assert.equal(response.body.data.recent[0].id,'healthy-overview');assert.equal(response.body.diagnostics[0].code,'MEMORY_CATALOG_ENTRY_UNREADABLE');assert.equal(response.body.diagnostics[0].file,'memory/recent/bad.json');assert.deepEqual(fs.readFileSync(bad),before);
 const page=await f.send('memory?limit=20');assert.equal(page.status,200);assert.equal(page.body.data.items[0].id,'healthy-overview');
});

test('native page parameters identify safe fields and current discovery without a mutation', async t => {
  const f = await fixture(t);
  for (const [suffix, field] of [['plans?limit=1&view=wrong', 'query.view'], ['plans?limit=1&sort=wrong', 'query.sort'], ['memory?limit=1&kind=wrong', 'query.kind']]) {
    const result = await f.send(suffix); assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.errorCode, 'PERSONA_STORAGE_PARAMETER_INVALID'); assert.equal(result.body.field, field);
    assert.match(result.body.repair, /GET \/api\/agent\/help\?operationId=manager.personas.storage/);
    assert.doesNotMatch(result.body.repair, /GET \/api\/roles\/Fixture\/plans\/query/);
  }
  assert.equal((await f.send('plans')).body.data.length, 0);
});

test('non-Codex binding repair keeps the explicit original adapter and complete peer binding', async t => {
  const f = await fixture(t); let writes = 0;
  f.application.commands.createPlan = async () => { writes++; throw new RoleStorageApplicationError('Plan taskBinding.sessionId is required.', 'invalid_request', 400); };
  for (const agentType of ['workbuddy', 'antigravity']) {
    const original = { agentType, sessionId: '', instanceBinding: { instanceId: 'original-instance', agentId: 'original-agent', ownerDeviceId: 'original-peer' } };
    const response = await f.send('plans', 'POST', { id: 'original-plan', title: 'Original plan', taskBinding: original }, { 'idempotency-key': 'original-' + agentType });
    assert.equal(response.status, 400); assert.equal(response.body.field, 'body.taskBinding');
    assert.match(response.body.repair, /explicit agentAdapter equal to the original taskBinding.agentType or secretaryBinding.agentType/);
    assert.match(response.body.repair, /instanceId, agentId and ownerDeviceId/); assert.ok(response.body.repair.includes(agentType));
    assert.match(response.body.repair, /Do not omit agentAdapter or infer it from an opaque session ID/);
    assert.deepEqual(original.instanceBinding, { instanceId: 'original-instance', agentId: 'original-agent', ownerDeviceId: 'original-peer' });
  }
  assert.equal(writes, 2); assert.equal((await f.send('plans')).body.data.length, 0);
});

test("60 exact contracts retain both role prefixes, ignored counts IDs and derived manual IDs", async t => {
  const f = await fixture(t);
  assert.equal(f.definitions.length, 60);
  assert.equal(new Set(f.definitions.map(value => value.contract.operationId)).size, 60);
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
    const url = contract.pathTemplate.replace(":roleId", "Fixture").replace(/:(planId|requestId|statusKey|memoryId|runId|ignoredItemId)/g, "fixture-id");
    const jsonBody = contract.operationId.startsWith("manager.personas.storage.plans.mutations.reconcile")
      ? { patch: {}, expectedRevision: "fixture-original-revision" }
      : {};
    const response = await f.send(url, contract.method, contract.request.body.kind === "json" ? jsonBody : undefined, {}, "");
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
  assert.equal(stale.body.field, 'headers.if-match'); assert.equal(stale.body.errorCode, 'revision_conflict');
  assert.match(stale.body.repair, /GET \/api\/roles\/Fixture\/plans\/plan-fixture/); assert.match(stale.body.repair, /plan-statuses/);
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
  const immutable = await f.send('plan-statuses/fixture_status', 'PATCH', { key: 'substituted-key' }, { 'idempotency-key': 'fixture-status-immutable', 'if-match': current.headers.get('etag')! });
  assert.equal(immutable.status, 400); assert.equal(immutable.body.field, 'body.key'); assert.match(immutable.body.repair, /plan-statuses/);
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
  const stale = await f.send('memory/recent/' + id, 'PATCH', { title: 'Stale fixture' }, { 'idempotency-key': 'fixture-memory-stale', 'if-match': first.headers.get('etag')! });
  assert.equal(stale.status, 412); assert.equal(stale.body.field, 'headers.if-match');
  assert.ok(stale.body.repair.includes('/memory/recent/' + id)); assert.match(stale.body.repair, /updates viewedAt/);
  f.setReadOnly(true); const plain = await f.send("memory/recent/" + id); assert.equal(plain.status, 200); assert.equal(plain.body.data.title, "Changed Memory"); assert.equal(plain.headers.has("idempotency-key"), false);
  for (const suffix of ["memory", "memory?counts=1", "memory?limit=1&kind=recent", "memory/recent", "memory/consolidated", "memory/consolidation-runs"]) assert.equal((await f.send(suffix)).status, 200, suffix);
  assert.equal((await f.send("memory?limit=1&kind=invalid")).status, 400);
  assert.equal((await f.send("memory/consolidated/missing")).status, 404);
  assert.equal((await f.send("memory/consolidation-runs/missing")).status, 404);
  f.setReadOnly(false);
  const requested = await f.send("memory/consolidation-requests", "POST", { force: true, includeOlderThanHours: 0, triggerOlderThanHours: 0 }, { "idempotency-key": "fixture-consolidation-request" });
  assert.equal(requested.status, 201, JSON.stringify(requested.body)); const runId = requested.body.data.run.id;
  const run = await f.send("memory/consolidation-runs/" + runId, "GET", undefined, {}, "/roles/Fixture/"); assert.equal(run.status, 200); assert.equal(run.body.data.status, "requested");
  const runStale = await f.send('memory/consolidation-runs/' + runId + '/result', 'POST', [], { 'idempotency-key': 'fixture-result-stale', 'if-match': '"' + 'a'.repeat(64) + '"' });
  assert.equal(runStale.status, 412); assert.ok(runStale.body.repair.includes('GET /api/roles/Fixture/memory/consolidation-runs/' + runId));
  const result = await f.send("memory/consolidation-runs/" + runId + "/result", "POST", [{ id: "consolidated-fixture", title: "Consolidated Fixture", focus: "Controlled", content: "Controlled consolidated content", keywords: ["fixture"] }], { "idempotency-key": "fixture-consolidation-result", "if-match": run.headers.get("etag")! }, "/roles/Fixture/");
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.data.run.status, "completed");
  const consolidated = await f.send("memory/consolidated/consolidated-fixture"); assert.equal(consolidated.status, 200); assert.equal(consolidated.body.data.title, "Consolidated Fixture");
});

for (const change of ["directory", "application", "identity", "credential-revocation"] as const) {
  test(`capture rejects ${change} changes after actor await before native writes`, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, () => ({ planHistoryContext: async (_request, _body, command) => { entered.resolve(); await release.promise; return command; } }));
    const pending = f.send("plans", "POST", { id: "plan-fenced", title: "Fenced", keywords: ["fixture"] }, { "idempotency-key": "fixture-fenced-create" }); await Promise.race([entered.promise, pending.then(() => { throw new Error("Request settled before reaching the controlled owner."); })]);
    if (change === "directory") { const other = path.join(f.root, "Other"); fs.mkdirSync(other); f.changeDirectory(other); }
    if (change === "application") f.changeApplication({} as RoleStorageApplication);
    if (change === "identity") f.identity.managerInstanceId = "replacement-manager";
    if (change === "credential-revocation") { f.authority.revokeNode(f.credential.nodeId); }
    release.resolve(); const result = await pending;
    assert.equal(result.status, change === "credential-revocation" ? 403 : 409, JSON.stringify(result.body));
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
  f.authority.revokeNode(f.credential.nodeId); release.resolve(); const response = await pending;
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


test("repeated storage admission checks use memory while native storage retains file ownership", async t => {
  const f = await fixture(t), socket = new Socket(), request = new http.IncomingMessage(socket);
  t.after(() => { socket.destroy(); });
  request.method = "GET"; request.url = "/api/roles/Fixture/counts";
  request.headers = { authorization: "Bearer " + f.credential.token };
  assert.equal(evaluateLanAgentRequest(request, f.authority, true).kind, "agent");
  markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
  const input: ApiOperationInput = { request, response: new http.ServerResponse(request), url: new URL("http://fixture" + request.url), path: { roleId: "Fixture" }, query: {}, body: undefined };
  const spec = { id: "counts.read", method: "GET", suffix: "counts", action: "counts", failure: "worker" } as const;
  let nativeRealpaths = 0;
  const original = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof original>) => { nativeRealpaths++; return Reflect.apply(original, fs.realpathSync, args); });
  for (let index = 0; index < 500; index++) {
    const admitted = f.owner.capture(input, spec);
    admitted.assertCurrent(); admitted.assertCurrent();
    assert.equal(admitted.roleDir, f.roleDir); assert.equal(admitted.application, f.application);
  }
  assert.equal(nativeRealpaths, 0, "HTTP admission never resolves a physical path");
});

test("native storage file errors retain the original local HTTP mapping", async t => {
  const f = await fixture(t);
  t.mock.method(f.context.pools!.knowledge, "queryRoleFileCounts", async () => { throw Object.assign(new Error("Synthetic native EACCES"), { code: "EACCES" }); });
  const result = await f.send("counts");
  assert.equal(result.status, 500); assert.equal(result.body.message, "Synthetic native EACCES");
});

test("plan availability HTTP: partial diagnostics survive paged and legacy array contracts without hiding healthy neighbors", async t => {
  const f = await fixture(t);
  for (const id of ["damaged", "healthy-a", "healthy-b"]) createPlan(f.roleDir, {
    id, title: id, status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One", status: "进行中" }], keywords: ["fixture"]
  });
  fs.cpSync(planDirectory(f.roleDir, "damaged", "active"), planDirectory(f.roleDir, "damaged", "archive"), { recursive: true });
  const unknown = path.join(f.roleDir, "plans/quarantine/plan-storage-package-transactions/unattributed/fixture");
  fs.mkdirSync(unknown, { recursive: true }); fs.writeFileSync(path.join(unknown, "manifest.json"), "{broken");
  const legacy = await f.send("plans"); assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.ok(Array.isArray(legacy.body.data)); assert.equal(legacy.body.partial, true);
  assert.deepEqual(legacy.body.data.map((plan: { id: string }) => plan.id).sort(), ["healthy-a", "healthy-b"]);
  assert.ok(legacy.body.diagnostics.some((item: { code: string }) => item.code === "duplicate_plan_identity"));
  assert.ok(legacy.body.diagnostics.some((item: { code: string }) => item.code === "package_recovery_unknown"));
  const first = await f.send("plans?limit=1&sort=updated"); assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.partial, true); assert.equal(first.body.data.total, 2); assert.equal(first.body.data.items.length, 1);
  assert.ok(first.body.data.nextCursor); assert.ok(first.body.data.diagnostics.length >= 2);
  const second = await f.send("plans?limit=1&sort=updated&cursor=" + encodeURIComponent(first.body.data.nextCursor));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.items.length, 1); assert.notEqual(second.body.data.items[0].id, first.body.data.items[0].id);
  assert.equal(second.body.data.nextCursor, ""); assert.equal(fs.readFileSync(path.join(unknown, "manifest.json"), "utf8"), "{broken");
});


test("plan detail reads use the workflow worker while main-process async filesystem work is blocked", { timeout: 30_000 }, async t => {
  const f = await fixture(t), plan = createPlan(f.roleDir, {
    title: "Workflow reader fixture", keywords: ["fixture"], status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One" }]
  }), revision = "inventory-sha256:original-plan-revision";
  t.mock.method(f.application.queries, "plan", async (_role: string, id: string) => id === plan.id ? { plan, revision, approval: { count: 0 } } : null);
  const originalWorkflow = f.application.queries.planWorkflow.bind(f.application.queries), workflowCalls: Array<{ roleId: string; signal?: AbortSignal }> = [];
  t.mock.method(f.application.queries, "planWorkflow", (roleId: string, options: NonNullable<Parameters<typeof originalWorkflow>[1]> = {}) => {
    workflowCalls.push({ roleId, signal: options.signal }); return originalWorkflow(roleId, options);
  });
  const gate = deferred(), entered = deferred(), target = path.resolve(f.roleDir, "personaConfig.json"), original = fs.promises.readFile;
  const blocked = t.mock.method(fs.promises, "readFile", (async (...args: Parameters<typeof original>) => {
    if (typeof args[0] === "string" && path.resolve(args[0]) === target) { entered.resolve(); await gate.promise; }
    return original(...args);
  }) as typeof original);
  const pending = f.send("plans/" + plan.id);
  try {
    const first = await Promise.race([pending.then(response => ({ response })), entered.promise.then(() => ({ blocked: true }))]);
    assert.ok("response" in first, "A ready plan must not wait on an extra main-process workflow filesystem read.");
    assert.equal(first.response.status, 200); assert.equal(first.response.body.data.id, plan.id);
    assert.equal(first.response.headers.get("etag"), '"' + revision + '"');
    assert.equal(workflowCalls.length, 1); assert.equal(workflowCalls[0]!.roleId, "Fixture"); assert.ok(workflowCalls[0]!.signal instanceof AbortSignal);
    const view = first.response.headers.get("x-plan-view-revision"); assert.ok(view);
    const unchanged = await f.send("plans/" + plan.id, "GET", undefined, { "if-plan-view-revision": view }, "/roles/Fixture/");
    assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get("etag"), first.response.headers.get("etag"));
    assert.equal(unchanged.headers.get("x-plan-view-revision"), view);
    assert.equal((await f.send("plans/missing-plan")).status, 404);
  } finally { gate.resolve(); await pending; blocked.mock.restore(); }
});

test("plan detail workflow owner failures are local and preserve the original plan bytes", async t => {
  const f = await fixture(t), plan = createPlan(f.roleDir, { title: "Workflow failure fixture", keywords: ["fixture"], status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One" }] });
  const file = path.join(planDirectory(f.roleDir, plan.id, "active"), "plan.json"), before = fs.readFileSync(file);
  t.mock.method(f.application.queries, "plan", async () => ({ plan, revision: "inventory-sha256:original", approval: { count: 0 } }));
  t.mock.method(f.application.queries, "planWorkflow", async () => { throw new RoleStorageApplicationError("Fixture workflow unavailable.", "busy", 503); });
  const response = await f.send("plans/" + plan.id); assert.equal(response.status, 503); assert.ok(fs.readFileSync(file).equals(before));
  assert.equal((await f.send("counts")).status, 200, "Workflow failure must not disable unrelated reads.");
});

test("plan detail retains its original generation guard after the workflow owner returns", async t => {
  const f = await fixture(t), plan = createPlan(f.roleDir, { title: "Workflow generation fixture", keywords: ["fixture"], status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One" }] });
  t.mock.method(f.application.queries, "plan", async () => ({ plan, revision: "inventory-sha256:original", approval: { count: 0 } }));
  t.mock.method(f.application.queries, "planWorkflow", async () => { const result = readPersonaPlanWorkflow(f.roleDir); f.identity.managerInstanceId = "replacement-manager"; return result; });
  try { assert.equal((await f.send("plans/" + plan.id)).status, 409); }
  finally { f.identity.managerInstanceId = "fixture-manager"; }
});

test("plan detail cancellation reaches its workflow worker and retirement joins its actual close", { timeout: 10_000 }, async t => {
  const entered = deferred(), killRequested = deferred();
  class Child extends EventEmitter implements ManagerReadWorkerChild {
    readonly pid = 58_283; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; connected = true;
    override on(event: string, listener: (...args: any[]) => void): this { super.on(event, listener); if (event === "message") queueMicrotask(() => this.emit("message", { type: "ready" })); return this; }
    send(message: any, callback?: (error: Error | null) => void): boolean { callback?.(null); if (message.task?.type === "role_plan_workflow") entered.resolve(); return true; }
    kill(): boolean { killRequested.resolve(); return true; } disconnect() { this.connected = false; } unref() {}
    close() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit("close", 0, null); }
  }
  const child = new Child(), pool = new ManagerReadWorkerPool({ timeoutMs: 5_000, terminationTimeoutMs: 5, forceTerminationTimeoutMs: 5, workerFactory: () => child, setWorkerPriority: () => {} });
  t.after(async () => { child.close(); await pool.stop(); });
  const f = await fixture(t);
  t.mock.method(f.application.queries, "plan", async () => null);
  t.mock.method(f.reads, "run", pool.run.bind(pool));
  const controller = new AbortController(), pending = f.send("plans/missing-plan", "GET", undefined, {}, "/api/roles/Fixture/", controller.signal).catch(error => error);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error("The request settled without entering the workflow worker."); })]);
    controller.abort(); await pending; await killRequested.promise;
    let stopped = false; const stopping = f.owner.stop().then(() => { stopped = true; }); await turn(); assert.equal(stopped, false);
    child.close(); await stopping; assert.equal(stopped, true);
  } finally { controller.abort(); child.close(); await pending; }
});


for (const damage of ["malformed-json", "invalid-workflow"] as const) {
  test(`plan detail retains original async workflow error for ${damage}`, async t => {
    const f = await fixture(t), plan = createPlan(f.roleDir, { title: "Permanent workflow error", keywords: ["fixture"], status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One" }] });
    const planFile = path.join(planDirectory(f.roleDir, plan.id, "active"), "plan.json"), before = fs.readFileSync(planFile), configFile = path.join(f.roleDir, "personaConfig.json");
    if (damage === "malformed-json") fs.writeFileSync(configFile, "{broken");
    else { const config = JSON.parse(fs.readFileSync(configFile, "utf8")); config.planWorkflow = { schemaVersion: 5, statuses: "invalid" }; fs.writeFileSync(configFile, JSON.stringify(config)); }
    const damagedConfig = fs.readFileSync(configFile); let originalError: unknown;
    try { await readPersonaPlanWorkflowAsync(f.roleDir); } catch (error) { originalError = error; }
    assert.ok(originalError instanceof Error, "The original async reader must report the controlled configuration failure.");
    const response = await f.send("plans/" + plan.id);
    assert.equal(response.status, 500); assert.equal(response.body.code, -1); assert.equal(response.body.message, originalError.message);
    assert.equal(response.body.state, undefined); assert.notEqual(response.body.retryable, true);
    assert.ok(fs.readFileSync(planFile).equals(before)); assert.ok(fs.readFileSync(configFile).equals(damagedConfig));
    const originalWorkflowRoute = await f.send("plan-statuses"); assert.equal(originalWorkflowRoute.status, 503); assert.equal(originalWorkflowRoute.body.state, "busy");
    assert.equal((await f.send("counts")).status, 200);
  });
}

test("plan detail preserves workflow transport failures without treating them as configuration errors", async t => {
  const f = await fixture(t), original = f.reads.run.bind(f.reads);
  t.mock.method(f.application.queries, "plan", async () => null);
  for (const code of ["busy", "timeout", "aborted", "worker_failed"] as const) {
    const mocked = t.mock.method(f.reads, "run", ((task: Parameters<typeof f.reads.run>[0], options: Parameters<typeof f.reads.run>[1]) => {
      if (task.type === "role_plan_workflow") return Promise.reject(new ManagerReadWorkerError("Controlled workflow transport failure.", code));
      return original(task, options);
    }) as typeof f.reads.run);
    try { const response = await f.send("plans/missing-plan"); assert.equal(response.status, code === "timeout" ? 504 : 503); assert.equal(response.body.state, "busy"); assert.doesNotMatch(response.body.message, /Controlled workflow transport/); }
    finally { mocked.mock.restore(); }
  }
});


test("workflow default routes retain missing and file-read failure boundaries without materializing config", async t => {
  const f = await fixture(t), plan = createPlan(f.roleDir, { title: "Workflow missing fixture", keywords: ["fixture"], status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One" }] });
  const config = path.join(f.roleDir, "personaConfig.json"), original = fs.readFileSync(config), planFile = path.join(planDirectory(f.roleDir, plan.id, "active"), "plan.json"), beforePlan = fs.readFileSync(planFile);
  fs.unlinkSync(config);
  try {
    assert.equal((await f.send("plan-statuses")).status, 404);
    const detail = await f.send("plans/" + plan.id); assert.equal(detail.status, 500); assert.equal(detail.body.message, "Persona plan workflow is not initialized.");
    assert.equal(fs.existsSync(config), false);
    fs.mkdirSync(config); let originalError: unknown;
    try { await readPersonaPlanWorkflowAsync(f.roleDir); } catch (error) { originalError = error; }
    assert.ok(originalError instanceof Error);
    assert.equal((await f.send("plan-statuses")).status, 503);
    const unreadable = await f.send("plans/" + plan.id); assert.equal(unreadable.status, 500); assert.equal(unreadable.body.message, originalError.message);
    assert.ok(fs.statSync(config).isDirectory()); assert.ok(fs.readFileSync(planFile).equals(beforePlan));
  } finally { if (fs.existsSync(config) && fs.statSync(config).isDirectory()) fs.rmdirSync(config); fs.writeFileSync(config, original); }
});

test("workflow post-commit projection failure retains the committed receipt and same-key recovery", { timeout: 90_000 }, async t => {
  const f = await fixture(t), config = path.join(f.roleDir, "personaConfig.json"), first = await f.send("plan-statuses");
  assert.equal(first.status, 200); const template = first.body.data.statuses.find((item: { state: string }) => item.state === "enabled");
  const input = { ...template, key: "projection_recovery_fixture", label: "Projection recovery", labelEn: "Projection recovery", legacyAliases: [], order: 910 };
  const headers = { "idempotency-key": "workflow-projection-recovery", "if-match": first.headers.get("etag")! };
  const original = f.reads.run.bind(f.reads); let committed: Buffer | undefined;
  const mocked = t.mock.method(f.reads, "run", ((task: Parameters<typeof f.reads.run>[0], options: Parameters<typeof f.reads.run>[1]) => {
    if (task.type === "role_plan_workflow" && !committed) { committed = fs.readFileSync(config); fs.writeFileSync(config, "{broken"); }
    return original(task, options);
  }) as typeof f.reads.run);
  try {
    const response = await f.send("plan-statuses", "POST", input, headers);
    assert.equal(response.status, 503, JSON.stringify(response.body)); assert.equal(response.body.commitState, "committed");
    assert.equal(response.body.idempotencyKey, headers["idempotency-key"]); assert.ok(committed);
    assert.equal(JSON.parse(committed.toString("utf8")).planWorkflow.statuses.filter((item: { key: string }) => item.key === input.key).length, 1);
  } finally { mocked.mock.restore(); if (committed) fs.writeFileSync(config, committed); }
  const replay = await f.send("plan-statuses", "POST", input, headers); assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.headers.get("idempotency-key"), headers["idempotency-key"]); assert.ok(committed && fs.readFileSync(config).equals(committed));
});

function receiptOnlyFixture(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const planId = "receipt-only-plan";
  createPlan(f.roleDir, {
    id: planId, title: "Receipt-only fixture", focus: "Original frozen request", status: "分析中",
    currentStepId: "verify", steps: [{ id: "verify", title: "Verify" }], keywords: ["receipt"]
  });
  const expectedRevision = `inventory-sha256:${readPlanStoragePackage(f.roleDir, planId, "active").inventoryHash}`;
  const patch = { focus: "Original intended change" };
  const actor = { kind: "unknown" as const };
  const receiptPath = durableDeliveryReceiptPath(path.join(f.roleDir, "runtime"), "storage-mutation-idempotency", requestId);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: 1, deliveryId: requestId,
    requestDigest: durableDeliveryRequestDigest({ roleId: "Fixture", planId, task: { type: "plan_update", patch }, actor }),
    state: "sending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    executionId: "fixture-old-execution", ownerHost: os.hostname(), ownerPid: 2147483647,
    leaseExpiresAt: "2026-01-01T00:00:01.000Z", audit: { expectedRevision }
  }));
  const orphan = path.join(f.roleDir, "plans/quarantine/plan-storage-lifecycle-transactions", planId, "fixture-staging", ".payload.fixture.candidate", "original.md");
  fs.mkdirSync(path.dirname(orphan), { recursive: true }); fs.writeFileSync(orphan, "Preserve interrupted staging bytes.");
  const beforePackage = readPlanStoragePackage(f.roleDir, planId, "active");
  return { planId, requestId, patch, actor, expectedRevision, receiptPath, orphan,
    originalPackage: beforePackage.files.map(file => [file.path, file.sha256]),
    orphanSha: createHash("sha256").update(fs.readFileSync(orphan)).digest("hex") };
}

test("receipt-only HTTP settles a failed original receipt without changing or publishing its plan", async t => {
  const f = await fixture(t), item = receiptOnlyFixture(f, "receipt-only-http-original");
  const body = { patch: item.patch, expectedRevision: item.expectedRevision, actor: item.actor };
  const url = `plans/${item.planId}/mutations/${item.requestId}/reconcile`;
  const first = await f.send(url, "POST", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.state, "completed");
  assert.equal(first.body.data.operationState, "failed");
  assert.equal(first.body.data.commitState, "not_committed");
  assert.equal(first.body.data.requestId, item.requestId);
  assert.equal(first.body.data.retryable, false);
  const terminal = fs.readFileSync(item.receiptPath);
  const second = await f.send(url, "POST", body, { "idempotency-key": item.requestId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.settlement, "not_attempted");
  assert.deepEqual(fs.readFileSync(item.receiptPath), terminal);
  const replay = await f.send(`plans/${item.planId}`, "PATCH", item.patch, { "if-match": `"${item.expectedRevision}"`, "idempotency-key": item.requestId });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.state, "aborted_before_commit");
  assert.equal(replay.body.commitState, "not_committed");
  assert.equal(replay.body.retryable, false);
  assert.equal(replay.body.retry, undefined);
  assert.deepEqual(readPlanStoragePackage(f.roleDir, item.planId, "active").files.map(file => [file.path, file.sha256]), item.originalPackage);
  assert.equal(createHash("sha256").update(fs.readFileSync(item.orphan)).digest("hex"), item.orphanSha);
  assert.equal(f.events.length, 0); assert.equal(f.scheduled.length, 0);
  assert.deepEqual(fs.readFileSync(item.receiptPath), terminal);
});

test("receipt-only HTTP preserves the original digest and exposes its exact discovery contract", async t => {
  const f = await fixture(t), item = receiptOnlyFixture(f, "receipt-only-http-conflict");
  const before = fs.readFileSync(item.receiptPath);
  const response = await f.send(`plans/${item.planId}/mutations/${item.requestId}/reconcile`, "POST", {
    patch: { focus: "Different frozen intent" }, expectedRevision: item.expectedRevision, actor: item.actor
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.state, "conflict");
  assert.equal(response.body.data.operationState, "conflict");
  assert.deepEqual(fs.readFileSync(item.receiptPath), before);
  const definition = f.definitions.find(value => value.contract.operationId === "manager.personas.storage.plans.mutations.reconcile");
  assert.ok(definition);
  assert.equal(definition.contract.exposure, "public");
  const requestBody = definition.contract.request.body;
  assert.ok(requestBody.kind === "json");
  assert.ok(requestBody.schema && typeof requestBody.schema === "object");
  assert.deepEqual(requestBody.schema.required, ["patch"]);
  assert.match(definition.contract.description, /without executing the original write/);
});

test("receipt-only HTTP validates the recovery envelope without changing its original key", async t => {
  const f = await fixture(t), item = receiptOnlyFixture(f, "receipt-only-http-parameters");
  const before = fs.readFileSync(item.receiptPath), url = `plans/${item.planId}/mutations/${item.requestId}/reconcile`;
  const missing = await f.send(url, "POST", { expectedRevision: item.expectedRevision });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.field, "body.patch");
  const differentKey = await f.send(url, "POST", { patch: item.patch, expectedRevision: item.expectedRevision, actor: item.actor }, { "idempotency-key": "another-request" });
  assert.equal(differentKey.status, 400, JSON.stringify(differentKey.body));
  assert.equal(differentKey.body.retry, "same_original_request_only");
  assert.equal(differentKey.body.field, "headers.idempotency-key");
  assert.match(differentKey.body.help.path, /manager.personas.storage.plans.mutations.reconcile/);
  assert.equal(differentKey.body.retryable, false);
  assert.deepEqual(fs.readFileSync(item.receiptPath), before);
});


test("receipt-only HTTP presents original successful attachments with the existing public DTO", async t => {
  const f = await fixture(t), planId = "receipt-original-success";
  const created = await f.send("plans", "POST", {
    id: planId, title: "Original successful receipt", focus: "Create", status: "分析中", currentStepId: "verify",
    steps: [{ id: "verify", title: "Verify" }], keywords: ["receipt"],
    attachments: [{ name: "synthetic-proof.md", mimeType: "text/markdown", contentBase64: Buffer.from("Synthetic proof.").toString("base64") }]
  }, { "idempotency-key": "receipt-public-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const expectedRevision = created.headers.get("etag")!;
  const patch = { focus: "Original successful update" }, requestId = "receipt-public-update";
  const changed = await f.send(`plans/${planId}`, "PATCH", patch, { "if-match": expectedRevision, "idempotency-key": requestId });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const before = readPlanStoragePackage(f.roleDir, planId, "active").inventoryHash;
  const receiptPath = durableDeliveryReceiptPath(path.join(f.roleDir, "runtime"), "storage-mutation-idempotency", requestId);
  const originalReceipt = fs.readFileSync(receiptPath);
  assert.equal(typeof JSON.parse(originalReceipt.toString("utf8")).result.value.attachments[0].path, "string");
  const result = await f.send(`plans/${planId}/mutations/${requestId}/reconcile`, "POST", { patch, expectedRevision, actor: { kind: "unknown" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.operationState, "succeeded");
  assert.equal(result.body.data.commitState, "committed");
  assert.equal(result.body.data.value.id, planId);
  assert.equal(result.body.data.value.attachments.length, 1);
  assert.equal(Object.hasOwn(result.body.data.value.attachments[0], "path"), false);
  assert.equal(result.body.data.value.attachments[0].sha256, changed.body.data.attachments[0].sha256);
  assert.deepEqual(fs.readFileSync(receiptPath), originalReceipt);
  assert.equal(readPlanStoragePackage(f.roleDir, planId, "active").inventoryHash, before);
});


test("receipt-only HTTP derives the original version from its existing receipt audit", async t => {
  const f = await fixture(t), item = receiptOnlyFixture(f, "receipt-only-http-audit-anchor");
  const response = await f.send(`plans/${item.planId}/mutations/${item.requestId}/reconcile`, "POST", { patch: item.patch, actor: item.actor });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.state, "completed");
  assert.equal(response.body.data.operationState, "failed");
  assert.equal(response.body.data.commitState, "not_committed");
  assert.deepEqual(readPlanStoragePackage(f.roleDir, item.planId, "active").files.map(file => [file.path, file.sha256]), item.originalPackage);
});
