import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentThreadRequest } from "../agentThreads.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "../plugins/io.rabiroute.manager.persona/src/manager/personaStorageOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { captureTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { resolvePlanHistoryRequestActor } from "./planHistoryRequestActor.js";

const sourceNode = "source-computer";
const sourceSession = "original-remote-native";
const workspace = "F:/Fixture/OriginalProject";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-history-source-"));
  const roleDir = path.join(root, "Fixture");
  fs.mkdirSync(roleDir);
  ensurePersonaPlanWorkflow(roleDir);
  const identity = { applicationGenerationId: "history-fixture", managerInstanceId: "history-manager" };
  const reads = new ManagerReadWorkerPool({ maxConcurrency: 2, timeoutMs: 30_000 });
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, currentIdentity: () => identity, readPool: reads, catalogReadPool: reads });
  const queries: AgentThreadRequest[] = [];
  const context: PersonaStorageOperationsContext = {
    application: () => application, roleDirectory: () => roleDir, identity: () => identity, readOnly: () => false,
    planHistoryContext: async (request, body, command) => ({ ...command, actor: await resolvePlanHistoryRequestActor(request, body.messageSource, {
      verifiedUserEntry: true,
      readThread: async query => {
        queries.push(query);
        if (query.instanceBinding) assert.deepEqual(query.instanceBinding, { instanceId: sourceNode, agentId: "codex" });
        return { id: query.threadId!, title: "Original owner title", cwd: workspace };
      }
    }) }),
    scheduleFeedbackPostCommit: () => {}, reportFeedbackScheduleError: () => {}, publish: () => {},
    rescheduleMemory: () => {}, noteMemoryRunCompleted: () => {}, pools: { knowledge: reads, catalog: reads, read: reads }
  };
  const owner = new PersonaStorageOwner(context), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("history-source-fixture", createPersonaStorageOperations(owner));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "fixture-authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, sourceNode);
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind === "denied") { response.writeHead(access.status).end(); return; }
    if (access.kind === "agent") captureTrustedLanAgentSource(request, "history-fixture-policy");
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/roles/Fixture/`;
  t.after(async () => {
    server.closeAllConnections();
    await registration.dispose();
    await owner.stop();
    await application.stop();
    await reads.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    queries,
    async send(suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, remote = true) {
      const response = await fetch(base + suffix, { method, headers: { "content-type": "application/json",
        ...(remote ? { authorization: "Bearer " + credential.token, "x-rabiroute-agent-type": "codex", "x-rabiroute-session-id": sourceSession } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
  };
}

function payload(id: string) {
  return { id, title: "Original remote plan", focus: "Preserve history source", status: "分析中", currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect" }], keywords: ["fixture"],
    taskBinding: { agentType: "codex", sessionId: "business-task-on-different-node", workspace,
      instanceBinding: { instanceId: "business-target", agentId: "business-agent" } },
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: sourceSession, sessionName: "Untrusted display title", workspace,
      instanceBinding: { instanceId: "forged-body-node", agentId: "forged-body-agent" } } };
}

test("real remote HTTP CRUD records the authenticated source owner and ignores body/current-plan coordinates", { timeout: 90_000 }, async t => {
  const app = await fixture(t);
  const body = { ...payload("remote-source-plan"), instanceBinding: { instanceId: "forged-root-node", agentId: "forged-root-agent" } };
  const created = await app.send("plans", "POST", body, { "idempotency-key": "history-original-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(app.queries, [{ action: "read", agentAdapter: "codex", threadId: sourceSession, cwd: workspace,
    instanceBinding: { instanceId: sourceNode, agentId: "codex" } }]);
  const changed = await app.send("plans/remote-source-plan", "PATCH", { nextAction: "Review the original owner", messageSource: body.messageSource }, {
    "idempotency-key": "history-original-update", "if-match": created.headers.get("etag")!
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.data.taskBinding, created.body.data.taskBinding, "actor lookup must not rewrite the business binding");
  const history = await app.send("plans/remote-source-plan/history");
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.data.records.length, 2);
  for (const record of history.body.data.records) {
    assert.equal(record.actor.sessionId, sourceSession);
    assert.equal(record.actor.displayName, "Original owner title");
    assert.deepEqual(record.actor.instanceBinding, { instanceId: sourceNode, agentId: "codex" });
    assert.equal(record.after.taskBinding.instanceBinding.instanceId, "business-target");
  }
  assert.equal(app.queries.length, 2);
});

test("local HTTP actor compatibility and verified-user attribution do not inherit a remote business binding", { timeout: 90_000 }, async t => {
  const app = await fixture(t);
  const local = payload("local-source-plan");
  const created = await app.send("plans", "POST", local, { "idempotency-key": "history-local-create" }, false);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(app.queries[0].instanceBinding, undefined);
  const localHistory = await app.send("plans/local-source-plan/history", "GET", undefined, {}, false);
  assert.equal(localHistory.status, 200);
  assert.equal(localHistory.body.data.records[0].actor.instanceBinding, undefined);
  assert.equal(localHistory.body.data.records[0].actor.sessionId, sourceSession);
  const userPlan = { ...payload("local-user-plan"), messageSource: { type: "user" } };
  const localUser = await app.send("plans", "POST", userPlan, { "idempotency-key": "history-local-user" }, false);
  assert.equal(localUser.status, 201, JSON.stringify(localUser.body));
  const remoteUser = await app.send("plans", "POST", { ...userPlan, id: "remote-user-claim" }, { "idempotency-key": "history-remote-user" });
  assert.equal(remoteUser.status, 201, JSON.stringify(remoteUser.body));
  const userHistory = await app.send("plans/local-user-plan/history", "GET", undefined, {}, false);
  const remoteHistory = await app.send("plans/remote-user-claim/history");
  assert.equal(userHistory.body.data.records[0].actor.kind, "user");
  assert.equal(remoteHistory.body.data.records[0].actor.kind, "unknown");
  assert.equal(app.queries.length, 1, "user attribution must not query or borrow the business owner");
});
