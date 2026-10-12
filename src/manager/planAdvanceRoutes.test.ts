import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";
import { PlanAdvanceStore } from "./planAdvancePolicy.js";
import { handlePlanAdvanceApi } from "./planAdvanceRoutes.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Request blocked by storage")), 1000); })]); }
  finally { clearTimeout(timer); }
}

test("plan advance settings leave health responsive while workflow and policy storage wait", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-advance-http-"));
  const workflow = ensurePersonaPlanWorkflow(dir);
  const workflowWait = gate(), policyWait = gate(), workflowStarted = gate(), policyStarted = gate();
  const originalRead = fs.promises.readFile;
  t.mock.method(managerKnowledgePageWorkerPool, "run", async (task: { type: string; roleDir: string }) => {
    assert.equal(task.type, "role_plan_workflow"); assert.equal(task.roleDir, dir);
    workflowStarted.release(); await workflowWait.promise; return workflow;
  });
  t.mock.method(fs.promises, "readFile", async (...args: Parameters<typeof fs.promises.readFile>) => {
    if (String(args[0]) === path.join(dir, "plan-advance.json")) { policyStarted.release(); await policyWait.promise; }
    return originalRead(...args);
  });
  t.mock.method(PlanAdvanceStore.prototype, "read", () => { throw new Error("Synchronous request storage read"); });
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("ready"); return; }
    handlePlanAdvanceApi(request, new URL(request.url!, "http://localhost"), response, {
      roleDir: () => dir, send: async () => { throw new Error("Settings must not dispatch"); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const settings = fetch(`${base}/api/roles/YeYu/plan-advance/settings?workspace=${encodeURIComponent(dir)}`);
  try {
    await within(workflowStarted.promise);
    assert.equal(await (await within(fetch(base + "/health"))).text(), "ready");
    workflowWait.release(); await within(policyStarted.promise);
    assert.equal(await (await within(fetch(base + "/health"))).text(), "ready");
    policyWait.release(); const response = await within(settings);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.policy.enabled, false);
    assert.deepEqual(body.data.roles, workflow.workflow.roles);
  } finally {
    workflowWait.release(); policyWait.release(); await settings.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("asynchronous advance reads preserve policy revision and fail on unreadable storage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-advance-read-"));
  try {
    const store = new PlanAdvanceStore(dir);
    assert.deepEqual(store.policy(dir, await store.readAsync()), store.policy(dir));
    fs.writeFileSync(store.file, "invalid");
    await assert.rejects(store.readAsync(), SyntaxError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
