import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MemoryConsolidationAgent,
  memoryConsolidationAgentStatePath
} from "./memoryConsolidationAgent.js";

test("dedicated memory consolidation reuses one Desktop task and defaults to GPT-5.6 Terra", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-"));
  const statePath = memoryConsolidationAgentStatePath(root);
  const calls: Array<Record<string, unknown>> = [];
  const worker = {
    id: "019f0000-0000-7000-8000-000000000020",
    title: "主人格 记忆整理",
    cwd: "C:/Project"
  };
  let created = false;
  const request = async (payload: Record<string, unknown>): Promise<Record<string, any>> => {
    calls.push(structuredClone(payload));
    if (payload.action === "resolve" && payload.createIfMissing === false && !created) {
      throw new Error("没有找到 Codex Desktop 任务");
    }
    if (payload.action === "read") {
      return { thread: { status: { type: "idle" } } };
    }
    if (payload.action === "resolve") {
      created = true;
      return { resolution: "created", thread: worker };
    }
    if (payload.action === "send") {
      return { status: "delivered", delivery: { status: "delivered" } };
    }
    throw new Error(`Unexpected action: ${String(payload.action)}`);
  };

  const agent = new MemoryConsolidationAgent({
    statePath,
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/Project",
    roleId: "Rabi",
    model: ""
  }, { request });

  const first = await agent.deliver("first consolidation request");
  assert.equal(first.threadId, worker.id);
  const firstSend = calls.find((call) => call.action === "send");
  assert.equal(firstSend?.threadId, worker.id);
  assert.equal(firstSend?.model, "gpt-5.6-terra");
  assert.deepEqual(firstSend?.deliverySource, {
    agentAdapter: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000001",
    sessionName: "主人格"
  });
  assert.match(String(firstSend?.prompt), /记忆整理 Agent 初始化/);
  assert.match(String(firstSend?.prompt), /first consolidation request/);
  assert.equal(fs.existsSync(statePath), true);

  calls.length = 0;
  await agent.deliver("second consolidation request");
  assert.equal(calls.some((call) => call.action === "resolve" && call.createIfMissing === true), false);
  const secondSend = calls.find((call) => call.action === "send");
  assert.doesNotMatch(String(secondSend?.prompt), /记忆整理 Agent 初始化/);
  assert.match(String(secondSend?.prompt), /second consolidation request/);
});

test("dedicated memory consolidation accepts a state-database task match without cwd metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-memory-agent-state-db-"));
  const calls: Array<Record<string, unknown>> = [];
  const agent = new MemoryConsolidationAgent({
    statePath: memoryConsolidationAgentStatePath(root),
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadId: "019f0000-0000-7000-8000-000000000001",
    sourceThreadName: "主人格",
    workspace: "C:/Project",
    roleId: "Rabi"
  }, {
    request: async (payload) => {
      calls.push(structuredClone(payload));
      if (payload.action === "resolve") {
        return {
          resolution: "name",
          thread: {
            id: "019f0000-0000-7000-8000-000000000020",
            title: "主人格 记忆整理"
          }
        };
      }
      if (payload.action === "send") return { status: "delivered" };
      throw new Error(`Unexpected action: ${String(payload.action)}`);
    }
  });

  const binding = await agent.deliver("consolidate");

  assert.equal(binding.workspace, "C:/Project");
  assert.equal(calls.find((call) => call.action === "send")?.cwd, "C:/Project");
});
