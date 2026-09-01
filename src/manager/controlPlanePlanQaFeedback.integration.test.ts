import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPlanFeedback } from "../planFeedback.js";
import { createPlan, listPlans } from "../roleKnowledge.js";
import { handlePersonaPluginApi } from "./controlPlaneRoutes.js";

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

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for plan feedback post-commit state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the feedback route ignores Agent guidance summaries but consumes explicit user QA verdicts", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-control-plane-qa-feedback-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-route-qa-verdict",
    title: "验证 QA 回传入口",
    focus: "QA 回传",
    status: "进行中",
    currentStepId: "verify-route",
    steps: [{ id: "verify-route", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000008",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-qa-verdict/feedback`;
  const postFeedback = async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, notifyAgent: false })
    });
    const result = await response.json() as Record<string, any>;
    assert.equal(response.status, 202, JSON.stringify(result));
    return result;
  };

  const ignored = await postFeedback({
    feedbackId: "route-agent-guidance",
    kind: "guidance_response",
    text: "定向测试 matched=10 passed=10 failed=0。",
    author: "agent",
    source: "agent"
  });
  assert.equal(ignored.data.qaHandling, undefined);
  assert.equal(listPlans(roleDir)[0].status, "进行中");

  const passed = await postFeedback({
    feedbackId: "route-user-qa-pass",
    stepId: "verify-route",
    text: "QA 明确通过，本轮未再复现。",
    author: "user",
    source: "webgui"
  });
  assert.equal(passed.data.postCommit.status, "pending");
  await waitUntil(() => {
    const record = listPlanFeedback(roleDir, "plan-route-qa-verdict")
      .find((item) => item.id === "route-user-qa-pass") as any;
    return record?.postCommit?.status === "completed";
  });
  const consumed = listPlanFeedback(roleDir, "plan-route-qa-verdict")
    .find((item) => item.id === "route-user-qa-pass");
  assert.equal(consumed?.qaHandling?.outcome, "passed");
  assert.equal(listPlans(roleDir)[0].status, "已完成");
});

test("the feedback route commits concurrent attachment retries as one durable record", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-control-plane-feedback-transaction-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-route-feedback-transaction",
    title: "验证反馈原子事务",
    focus: "反馈原子事务",
    status: "进行中",
    currentStepId: "verify-transaction",
    steps: [{ id: "verify-transaction", title: "事务验收", status: "进行中" }],
    keywords: ["反馈", "事务"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-feedback-transaction/feedback`;
  const body = {
    feedbackId: "route-feedback-transaction",
    kind: "guidance",
    text: "请保留这份事务证据。",
    author: "user",
    source: "webgui",
    notifyAgent: false,
    attachments: [{
      kind: "file",
      name: "transaction-proof.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("one durable attachment", "utf8").toString("base64")
    }]
  };
  const post = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json() as Record<string, any>;
    assert.equal(response.status, 202, JSON.stringify(result));
    return result.data as Record<string, any>;
  };

  const nonCanonical = await fetch(
    `http://127.0.0.1:${port}/api/roles/Rabi/plans/%20plan-route-feedback-transaction/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  const nonCanonicalResult = await nonCanonical.json() as Record<string, any>;
  assert.equal(nonCanonical.status, 400);
  assert.match(String(nonCanonicalResult.message || ""), /trimmed and Unicode NFC-normalized/);

  const [first, retry] = await Promise.all([post(), post()]);
  assert.equal(first.id, body.feedbackId);
  assert.equal(retry.id, body.feedbackId);
  const records = listPlanFeedback(roleDir, "plan-route-feedback-transaction");
  assert.equal(records.length, 1);
  assert.equal(records[0].attachments.length, 1);
  assert.equal(
    fs.readFileSync(records[0].attachments[0].path, "utf8"),
    "one durable attachment"
  );
});

test("the feedback route returns 202 after durable commit even when QA post-commit fails", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-control-plane-feedback-post-commit-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-route-feedback-post-commit",
    title: "验证反馈提交边界",
    focus: "反馈持久化后再执行 QA 副作用",
    status: "进行中",
    currentStepId: "verify-post-commit",
    steps: [{ id: "verify-post-commit", title: "QA 验收", status: "进行中" }],
    keywords: ["反馈", "QA"]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await fetch(
    `http://127.0.0.1:${port}/api/roles/Rabi/plans/plan-route-feedback-post-commit/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        feedbackId: "route-feedback-post-commit",
        stepId: "verify-post-commit",
        text: "问题仍存在。复现步骤：重新执行操作。修复前结果不正确，修复后实际结果仍不正确。",
        author: "user",
        source: "webgui",
        notifyAgent: false
      })
    }
  );
  const result = await response.json() as Record<string, any>;
  assert.equal(response.status, 202, JSON.stringify(result));
  assert.equal(result.data.id, "route-feedback-post-commit");

  await waitUntil(() => {
    const record = listPlanFeedback(roleDir, "plan-route-feedback-post-commit")[0] as any;
    return record?.postCommit?.status === "failed";
  });
  const records = listPlanFeedback(roleDir, "plan-route-feedback-post-commit");
  assert.equal(records.length, 1);
  assert.equal((records[0] as any).postCommit.status, "failed");
  assert.equal(records[0].qaHandling?.status, "dispatch_failed");
});
