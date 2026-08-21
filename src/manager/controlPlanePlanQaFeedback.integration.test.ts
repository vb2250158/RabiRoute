import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  assert.equal(passed.data.qaHandling.outcome, "passed");
  assert.equal(listPlans(roleDir)[0].status, "已完成");
});
