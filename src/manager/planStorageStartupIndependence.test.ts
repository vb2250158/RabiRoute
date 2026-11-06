import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createPlan, getPlan, updatePlan } from "../roleKnowledge.js";
import { legacyActivePlanFile } from "../planStorageLegacyLayout.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createPlanAgentStatusOwner } from "../plugins/io.rabiroute.manager.persona/src/manager/planAgentStatusRoutes.js";

// Exercise the actual dispatcher rejection statements, when present in a before
// graph, ahead of real target owners. This does not boot a full Manager fixture.
async function dispatcherStartupCheck() {
  const source = fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("controlPlaneRoutes.ts", source, ts.ScriptTarget.Latest, true);
  let statements = "";
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "planStorageRejection")) {
      assert.ok(ts.isBlock(node.parent));
      const siblings = node.parent.statements;
      const index = siblings.indexOf(node);
      assert.ok(ts.isIfStatement(siblings[index + 1]!));
      statements = source.slice(node.getStart(tree), siblings[index + 1]!.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!statements) return () => {};
  return new Function("request", "requestUrl", "response", "planStorageStartupLifecycle", "jsonResponse", "planStorageStartupUnavailable", statements)
    .bind(null) as (...args: unknown[]) => void;
}

test("unrelated damaged legacy and stale role progress do not block healthy update, original Agent open or a new role", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-startup-independent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles"), roleDir = path.join(rolesRoot, "SameRole");
  fs.mkdirSync(roleDir, {recursive: true});
  const input = (id: string) => ({id, title: "Original plan", focus: "Original scope", status: "分析中", currentStepId: "check", steps: [{id: "check", title: "Check"}], keywords: ["fixture"],
    taskBinding: {agentType: "codex" as const, sessionId: "original-session", sessionTitle: "Original", workspace: root, completionHook: {enabled: false}}
  });
  createPlan(roleDir, input("healthy-plan"));
  const broken = legacyActivePlanFile(roleDir, "damaged-plan"), raw = Buffer.from("{damaged legacy");
  fs.mkdirSync(path.dirname(broken), { recursive: true }); fs.writeFileSync(broken, raw);
  const progress = {state: "partial", attempt: 1, incidents: 1, lastTransitionAt: "2026-11-06T00:00:00Z", summary: {
    roles: 1, migrated: 0, reconciled: 0, failures: ["SameRole:bad legacy"], skipped: false, readyRoleIds: ["OlderReadyRole"]
  }};
  const opened: string[] = [];
  const owner = createPlanAgentStatusOwner({roleDir: roleId => path.join(rolesRoot, roleId), getPlan,
    service: {inspectPlans: async () => [], openPlanAgent: async (plan, role) => {
      assert.equal(plan.taskBinding?.sessionId, "original-session");
      opened.push(plan.id); return {planId: plan.id, role, opened: true, agentType: "codex", threadId: plan.taskBinding!.sessionId, threadTitle: "Original", workspace: root};
    }}
  });
  const startupCheck = await dispatcherStartupCheck();
  const gate = /planStorageRejection/.test(fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8"))
    ? (await import(new URL("./planStorageStartupHttpGate.js", import.meta.url).href)).planStorageStartupUnavailable : undefined;
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {"content-type": "application/json"}); response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, "http://fixture.invalid");
    startupCheck(request, url, response, {snapshot: () => progress}, json, gate);
    if (response.writableEnded) return;
    markAuthenticatedConnectionRequest(request);
    if (request.method === "PATCH" && url.pathname === "/api/roles/SameRole/plans/healthy-plan")
      return json(response, 200, updatePlan(roleDir, "healthy-plan", {title: "Updated healthy plan"}));
    if (request.method === "POST" && url.pathname === "/api/roles/SameRole/plan-agents/healthy-plan/open")
      return json(response, 202, await owner.prepare(request, "SameRole").open("healthy-plan", {role: "task"}));
    if (request.method === "POST" && url.pathname === "/api/roles/NewRole/plans") {
      const directory = path.join(rolesRoot, "NewRole"); fs.mkdirSync(directory, {recursive: true});
      return json(response, 201, createPlan(directory, input("fresh-plan")));
    }
    json(response, 404, {});
  })().catch(error => json(response, 500, {message: String(error)})); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const updated = await fetch(base + "/api/roles/SameRole/plans/healthy-plan", {method: "PATCH"});
  assert.equal(updated.status, 200, await updated.text());
  assert.equal(getPlan(roleDir, "healthy-plan")?.title, "Updated healthy plan");
  const navigation = await fetch(base + "/api/roles/SameRole/plan-agents/healthy-plan/open", {method: "POST"});
  assert.equal(navigation.status, 202); assert.equal((await navigation.json()).threadId, "original-session");
  const created = await fetch(base + "/api/roles/NewRole/plans", {method: "POST"});
  assert.equal(created.status, 201); assert.equal(getPlan(path.join(rolesRoot, "NewRole"), "fresh-plan")?.id, "fresh-plan");
  assert.deepEqual(opened, ["healthy-plan"]); assert.deepEqual(fs.readFileSync(broken), raw);
});
