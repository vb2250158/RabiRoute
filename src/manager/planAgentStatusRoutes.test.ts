import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import type { PlanAgentStatusService } from "./planAgentStatus.js";
import { handlePlanAgentStatusApi } from "./planAgentStatusRoutes.js";

class MockResponse extends Writable {
  statusCode = 0;
  readonly chunks: Buffer[] = [];

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  json(): Record<string, unknown> {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as Record<string, unknown>;
  }
}

function plan(id: string): PlanItem {
  return {
    id,
    title: id,
    focus: id,
    status: "执行中",
    archiveStatus: "未归档",
    attachments: [],
    steps: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    keywords: []
  };
}

test("plan Agent status route batches only requested plan ids", async () => {
  const inspected: string[][] = [];
  const service: PlanAgentStatusService = {
    inspectPlans: async (plans) => {
      inspected.push(plans.map((item) => item.id));
      return plans.map((item) => ({
        planId: item.id,
        checkedAt: "2026-08-07T00:00:00.000Z",
        taskAgent: {
          role: "task",
          configured: false,
          agentType: "codex",
          threadId: "",
          threadTitle: "",
          workspace: "",
          working: false,
          agentStatus: "unknown",
          sessionStatus: "unbound",
          canOpen: false,
          checkedAt: "2026-08-07T00:00:00.000Z"
        }
      }));
    },
    openPlanAgent: async () => { throw new Error("not used"); }
  };
  const response = new MockResponse();
  const finished = once(response, "finish");
  const handled = handlePlanAgentStatusApi(
    { method: "GET" } as http.IncomingMessage,
    new URL("http://127.0.0.1/api/roles/Rabi/plan-agents/status?planId=plan-2&planId=missing"),
    response as unknown as http.ServerResponse,
    {
      roleDir: () => "role-dir",
      listPlans: () => [plan("plan-1"), plan("plan-2")],
      service
    }
  );
  assert.equal(handled, true);
  await finished;

  assert.equal(response.statusCode, 200);
  assert.deepEqual(inspected, [["plan-2"]]);
  const body = response.json() as { data?: { missingPlanIds?: string[] } };
  assert.deepEqual(body.data?.missingPlanIds, ["missing"]);
});
