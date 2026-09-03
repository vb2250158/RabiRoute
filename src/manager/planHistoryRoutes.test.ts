import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, updatePlan } from "../roleKnowledge.js";
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

test("plan history endpoint keeps completed-plan revisions readable", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-history-route-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const plan = createPlan(roleDir, {
    id: "history-endpoint",
    title: "保留历史",
    focus: "读取计划历史",
    status: "执行中",
    currentStepId: "review",
    steps: [{ id: "review", title: "复核", status: "进行中" }],
    keywords: ["历史"]
  });
  updatePlan(roleDir, plan.id, {
    status: "完成",
    currentStepId: "",
    steps: [{ id: "review", title: "复核", status: "已完成" }]
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (handlePersonaPluginApi(request, requestUrl, response, { roleDir: () => roleDir })) return;
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await fetch(`http://127.0.0.1:${port}/api/roles/Role/plans/${plan.id}/history`);
  const payload = await response.json() as { code: number; data?: { count: number; records: Array<{ kind: string; after: { status: string } }> } };
  assert.equal(response.status, 200);
  assert.equal(payload.code, 0);
  assert.equal(payload.data?.count, 2);
  assert.deepEqual(payload.data?.records.map((record) => record.kind), ["created", "updated"]);
  assert.equal(payload.data?.records[1]?.after.status, "完成");
});
