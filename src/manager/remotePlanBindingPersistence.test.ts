import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "./personaStorageOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

const sharedSessionId = "same-original-business-session";
const workspace = "F:/Fixture/ExistingProject";
const endpointA = { instanceId: "fixture-computer-a", agentId: "fixture-codex-a" };
const endpointB = { instanceId: "fixture-computer-b", agentId: "fixture-codex-b" };
const binding = (instanceBinding?: unknown) => ({
  agentType: "codex", sessionId: sharedSessionId, sessionTitle: "Original business owner", workspace,
  completionHook: { enabled: false }, ...(instanceBinding === undefined ? {} : { instanceBinding })
});
const payload = (id: string, instanceBinding?: unknown) => ({
  id, title: "Original bound plan", focus: "Preserve the exact original owner", status: "分析中",
  currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect the original source" }, { id: "verify", title: "Verify the same owner" }],
  attachments: [{ name: "original-scope.txt", mimeType: "text/plain", contentBase64: Buffer.from("Preserve this original scoped attachment.").toString("base64") }],
  keywords: ["fixture", "original-owner"], taskBinding: binding(instanceBinding)
});

async function openApi(root: string, generation: string) {
  const roleDir = path.join(root, "Fixture");
  fs.mkdirSync(roleDir, { recursive: true });
  ensurePersonaPlanWorkflow(roleDir);
  const identity = { applicationGenerationId: generation, managerInstanceId: generation + "-manager" };
  const reads = new ManagerReadWorkerPool({ maxConcurrency: 2, timeoutMs: 30_000 });
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, currentIdentity: () => identity, readPool: reads, catalogReadPool: reads });
  const context: PersonaStorageOperationsContext = {
    application: () => application, roleDirectory: () => roleDir, identity: () => identity, readOnly: () => false,
    planHistoryContext: async (_request, _body, command) => ({ ...command, actor: { kind: "unknown" } }),
    scheduleFeedbackPostCommit: () => {}, reportFeedbackScheduleError: () => {}, publish: () => {},
    rescheduleMemory: () => {}, noteMemoryRunCompleted: () => {}, pools: { knowledge: reads, catalog: reads, read: reads }
  };
  const owner = new PersonaStorageOwner(context), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("remote-plan-binding-persistence-fixture", createPersonaStorageOperations(owner));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "fixture-authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, generation + "-caller");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  let closed = false;
  return {
    application, reads,
    async send(suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, prefix = "/api/roles/Fixture/") {
      const response = await fetch(baseUrl + prefix + suffix, {
        method, headers: { authorization: "Bearer " + credential.token, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const bytes = await response.text();
      return { status: response.status, headers: response.headers, body: bytes ? JSON.parse(bytes) : undefined };
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await registration.dispose();
      await owner.stop();
      await application.stop();
      await reads.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-plan-binding-"));
  const apis: Awaited<ReturnType<typeof openApi>>[] = [];
  t.after(async () => {
    for (const api of apis) await api.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = async (generation: string) => { const api = await openApi(root, generation); apis.push(api); return api; };
  return { root, open, api: await open("binding-first-generation") };
}

test("remote and local bindings survive native HTTP create, point/list/history reads and unrelated PATCH through both aliases", { timeout: 90_000 }, async t => {
  const { api } = await fixture(t);
  const remote = await api.send("plans", "POST", payload("remote-plan", endpointA), { "idempotency-key": "create-remote-original" });
  assert.equal(remote.status, 201, JSON.stringify(remote.body));
  assert.deepEqual(remote.body.data.taskBinding.instanceBinding, endpointA);
  const local = await api.send("plans", "POST", payload("local-plan"), { "idempotency-key": "create-local-original" }, "/roles/Fixture/");
  assert.equal(local.status, 201, JSON.stringify(local.body));
  assert.equal(local.body.data.taskBinding.instanceBinding, undefined);
  const before = await api.send("plans/remote-plan");
  assert.deepEqual(before.body.data.taskBinding.instanceBinding, endpointA);
  const changed = await api.send("plans/remote-plan", "PATCH", { title: "Changed only title" }, {
    "idempotency-key": "remote-title-only", "if-match": before.headers.get("etag")!
  }, "/roles/Fixture/");
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.data.taskBinding, before.body.data.taskBinding);
  for (const key of ["steps", "attachments", "keywords", "focus", "currentStepId"]) assert.deepEqual(changed.body.data[key], before.body.data[key], key);
  const plans = await api.send("plans");
  const items = Array.isArray(plans.body.data) ? plans.body.data : plans.body.data.items;
  assert.deepEqual(items.find((item: { id: string }) => item.id === "remote-plan").taskBinding.instanceBinding, endpointA);
  assert.equal(items.find((item: { id: string }) => item.id === "local-plan").taskBinding.instanceBinding, undefined);
  const history = await api.send("plans/remote-plan/history", "GET", undefined, {}, "/roles/Fixture/");
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.ok(history.body.data.records.length >= 2);
  for (const record of history.body.data.records) assert.deepEqual(record.after.taskBinding.instanceBinding, endpointA);
});

test("the complete remote endpoint survives stopping storage workers and reopening the original on-disk HTTP owner", { timeout: 90_000 }, async t => {
  const { api, open } = await fixture(t);
  const remote = { ...endpointA, ownerDeviceId: "fixture-peer-owner" };
  const created = await api.send("plans", "POST", payload("restart-plan", remote), { "idempotency-key": "create-restart-plan" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.taskBinding.instanceBinding, remote);
  const expected = created.body.data.taskBinding;
  const oldWorkers = api.reads.status().workerPids;
  await api.close();
  const next = await open("binding-second-generation");
  const reopened = await next.send("plans/restart-plan", "GET", undefined, {}, "/roles/Fixture/");
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.deepEqual(reopened.body.data.taskBinding, expected);
  const newWorkers = next.reads.status().workerPids;
  assert.ok(oldWorkers.length > 0 && newWorkers.length > 0);
  assert.ok(newWorkers.every(pid => !oldWorkers.includes(pid)), "reopened reads must execute in newly owned workers");
});

test("remote binding mutations retain ETag and idempotency conflicts without mixing equal session IDs on different instances", { timeout: 90_000 }, async t => {
  const { api } = await fixture(t);
  const created = await api.send("plans", "POST", payload("conflict-plan", endpointA), { "idempotency-key": "create-conflict-plan" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const before = await api.send("plans/conflict-plan");
  const headers = { "idempotency-key": "move-exact-original-endpoint", "if-match": before.headers.get("etag")! };
  const body = { taskBinding: binding(endpointB) };
  const moved = await api.send("plans/conflict-plan", "PATCH", body, headers);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.data.taskBinding.sessionId, sharedSessionId);
  assert.deepEqual(moved.body.data.taskBinding.instanceBinding, endpointB);
  const replay = await api.send("plans/conflict-plan", "PATCH", body, headers, "/roles/Fixture/");
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.data.taskBinding.instanceBinding, endpointB);
  const conflict = await api.send("plans/conflict-plan", "PATCH", { taskBinding: binding(endpointA) }, headers);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  const stale = await api.send("plans/conflict-plan", "PATCH", { taskBinding: binding(endpointA) }, { ...headers, "idempotency-key": "stale-original-revision" });
  assert.equal(stale.status, 412, JSON.stringify(stale.body));
  assert.equal(stale.body.commitState, "not_started");
  const after = await api.send("plans/conflict-plan");
  assert.deepEqual(after.body.data.taskBinding.instanceBinding, endpointB);
  for (const key of ["steps", "attachments", "keywords", "title", "focus", "currentStepId"]) assert.deepEqual(after.body.data[key], before.body.data[key], key);
  const history = await api.send("plans/conflict-plan/history");
  assert.equal(history.body.data.count, 2, "duplicate/conflicting/stale writes must not append history");
});

test("invalid explicit remote endpoint cannot silently normalize to a local binding or overwrite an existing exact endpoint", { timeout: 90_000 }, async t => {
  const { api } = await fixture(t);
  const created = await api.send("plans", "POST", payload("validation-plan", endpointA), { "idempotency-key": "create-validation-plan" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const before = await api.send("plans/validation-plan");
  const invalid = [{}, { instanceId: "fixture-computer-a" }, { instanceId: "", agentId: "fixture-agent" }, { instanceId: "fixture-computer-a", agentId: 12 }, { instanceId: ` ${endpointA.instanceId} `, agentId: endpointA.agentId }];
  for (let n = 0; n < invalid.length; n++) {
    const rejected = await api.send("plans/validation-plan", "PATCH", { taskBinding: binding(invalid[n]) }, { "idempotency-key": "invalid-endpoint-" + n, "if-match": before.headers.get("etag")! });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.commitState, "not_started");
  }
  const after = await api.send("plans/validation-plan");
  assert.deepEqual(after.body.data.taskBinding, before.body.data.taskBinding);
  assert.equal(after.headers.get("etag"), before.headers.get("etag"));
});

test("an explicitly restored local binding removes remote coordinates while preserving the original task and completion settings", { timeout: 90_000 }, async t => {
  const { api } = await fixture(t);
  const created = await api.send("plans", "POST", payload("local-restore-plan", endpointA), { "idempotency-key": "create-local-restore-plan" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const changed = await api.send("plans/local-restore-plan", "PATCH", { taskBinding: binding() }, { "idempotency-key": "restore-explicit-local", "if-match": created.headers.get("etag")! });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.data.taskBinding.instanceBinding, undefined);
  assert.equal(changed.body.data.taskBinding.sessionId, sharedSessionId);
  assert.equal(changed.body.data.taskBinding.workspace, workspace);
  assert.deepEqual(changed.body.data.taskBinding.completionHook, { enabled: false });
});
