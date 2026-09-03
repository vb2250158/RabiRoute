import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { createPlan, listPlanHistory, readPlansFromStorageInWorker } from "../roleKnowledge.js";
import { handlePersonaPluginApi } from "./controlPlaneRoutes.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test Manager port."));
      resolve(address.port);
    });
  });
}

async function jsonRequest(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {}
): Promise<{ response: Response; payload: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  return { response, payload: await response.json() };
}

test("persona plan status routes provide revision-fenced CRUD and retire after migrating current plans", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-status-routes-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  ensurePersonaPlanWorkflow(roleDir);
  const application = new RoleStorageApplication({
    rolesRoot,
    applicationGenerationId: "test-plan-status-generation",
    managerInstanceId: "test-plan-status-manager"
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, {
      rolesRoot,
      roleDir: () => roleDir,
      roleStorageApplication: () => application
    })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await application.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses");
  assert.equal(first.response.status, 200);
  const firstRevision = String(first.payload.data.revision);
  const analysis = first.payload.data.statuses.find((status: { key: string }) =>
    status.key === first.payload.data.roles.analysis
  );
  assert.ok(analysis);

  const definition = {
    ...analysis,
    key: "researching",
    label: "深入分析",
    labelEn: "Researching",
    description: "正在补充实现前证据。",
    descriptionEn: "Gathering evidence before implementation.",
    order: 900,
    legacyAliases: []
  };
  const created = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-plan-status-create",
      "if-match": `"${firstRevision}"`
    },
    body: JSON.stringify(definition)
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.data.status.key, "researching");
  const createdRevision = String(created.response.headers.get("etag") || "").replaceAll('"', "");
  assert.ok(createdRevision && createdRevision !== firstRevision);

  const patched = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses/researching", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-plan-status-update",
      "if-match": `"${createdRevision}"`
    },
    body: JSON.stringify({ description: "已更新的分析状态说明。" })
  });
  assert.equal(patched.response.status, 200, JSON.stringify(patched.payload));
  assert.equal(patched.payload.data.status.description, "已更新的分析状态说明。");
  const patchedRevision = String(patched.response.headers.get("etag") || "").replaceAll('"', "");

  const plan = createPlan(roleDir, {
    id: "status-migration-plan",
    title: "状态迁移计划",
    focus: "验证状态定义移除",
    status: "researching",
    currentStepId: "inspect",
    steps: [{ id: "inspect", title: "检查", status: "进行中" }],
    keywords: ["状态迁移"]
  });
  const retired = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses/researching", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-plan-status-delete",
      "if-match": `"${patchedRevision}"`
    },
    body: JSON.stringify({ replacementKey: first.payload.data.roles.analysis })
  });
  assert.equal(retired.response.status, 200, JSON.stringify(retired.payload));
  assert.equal(retired.payload.data.status.state, "retired");
  assert.deepEqual(retired.payload.data.migratedPlanIds, [plan.id]);
  assert.equal(readPlansFromStorageInWorker(roleDir).find(item => item.id === plan.id)?.status, first.payload.data.roles.analysis);
  assert.equal(listPlanHistory(roleDir, plan.id)[0]?.after.status, "researching");

  const finalCatalog = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses");
  assert.equal(finalCatalog.response.status, 200);
  assert.equal(finalCatalog.payload.data.statuses.find((status: { key: string }) => status.key === "researching")?.state, "retired");
});

test("persona plan status writes require both Idempotency-Key and If-Match", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-status-route-guard-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  const current = ensurePersonaPlanWorkflow(roleDir);
  const application = new RoleStorageApplication({
    rolesRoot,
    applicationGenerationId: "test-plan-status-guard-generation",
    managerInstanceId: "test-plan-status-guard-manager"
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, {
      rolesRoot,
      roleDir: () => roleDir,
      roleStorageApplication: () => application
    })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await application.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const definition = {
    ...current.workflow.statuses.find(status => status.key === current.workflow.roles.analysis),
    key: "guarded",
    label: "受保护状态",
    labelEn: "Guarded",
    order: 901,
    legacyAliases: []
  };
  const missingIdempotency = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses", {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": `"${current.revision}"` },
    body: JSON.stringify(definition)
  });
  assert.equal(missingIdempotency.response.status, 400);

  const missingRevision = await jsonRequest(baseUrl, "/api/roles/Rabi/plan-statuses", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "test-plan-status-missing-revision" },
    body: JSON.stringify(definition)
  });
  assert.equal(missingRevision.response.status, 400);

  const immutableKey = await jsonRequest(baseUrl, `/api/roles/Rabi/plan-statuses/${current.workflow.roles.analysis}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-plan-status-immutable-key",
      "if-match": `"${current.revision}"`
    },
    body: JSON.stringify({ key: "renamed-analysis" })
  });
  assert.equal(immutableKey.response.status, 400);

  const missingReplacement = await jsonRequest(baseUrl, `/api/roles/Rabi/plan-statuses/${current.workflow.roles.analysis}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-plan-status-missing-replacement",
      "if-match": `"${current.revision}"`
    },
    body: JSON.stringify({})
  });
  assert.equal(missingReplacement.response.status, 400);
});
