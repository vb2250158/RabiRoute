import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  handleAgentThreadRequest,
  listAgentThreadsFromIndexForTest,
  type AgentThreadDriver
} from "./agentThreads.js";

test("Agent thread list deduplicates session index entries and filters by title", () => {
  const result = listAgentThreadsFromIndexForTest([
    JSON.stringify({ id: "thread-1", thread_name: "旧标题", updated_at: "2026-07-12T00:00:00Z" }),
    JSON.stringify({ id: "thread-1", thread_name: "[Example][Bug] 功能入口", updated_at: "2026-07-13T00:00:00Z" }),
    JSON.stringify({ id: "thread-2", thread_name: "其它任务", updated_at: "2026-07-13T01:00:00Z" })
  ].join("\n"), "功能入口", 20);

  assert.deepEqual(result, [{
    id: "thread-1",
    title: "[Example][Bug] 功能入口",
    updatedAt: "2026-07-13T00:00:00Z"
  }]);
});

test("Agent thread create uses a configured workspace and fixed investigation instructions", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async (params) => {
      calls.push(params);
      return {
        id: "019f0000-0000-7000-8000-000000000001",
        title: params.title,
        updatedAt: "2026-07-13T00:00:00Z",
        source: "codex app-server",
        initialTurnStatus: "started"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "create",
    title: " [Example][Bug] 功能入口 ",
    prompt: " 只读调查功能入口。 ",
    cwd: process.cwd(),
    sandbox: "danger-full-access"
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    title: "[Example][Bug] 功能入口",
    prompt: "只读调查功能入口。",
    cwd: path.resolve(process.cwd()),
    developerInstructions: [
      "这是由 RabiRoute 会话管理层创建的独立 Codex 任务。",
      "严格按初始任务和用户后续消息处理，并遵守工作区中的 AGENTS.md 与任务明确引用的 Skill。",
      "运行沙箱权限不等于业务修改授权；没有明确授权时，只做读取、调查、证据整理和方案输出。",
      "开始工作前先读取当前任务的完整相关历史和已有结论，不得只看标题、摘要或最后一条消息。"
    ].join("\n"),
    sandbox: "danger-full-access"
  });
});

test("Agent thread create rejects workspaces outside configured Codex projects", async () => {
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      throw new Error("driver must not be called");
    },
    send: async () => undefined
  };

  await assert.rejects(
    handleAgentThreadRequest({
      action: "create",
      title: "任务",
      prompt: "调查",
      cwd: path.dirname(process.cwd())
    }, {
      allowedWorkspaces: [process.cwd()]
    }, driver),
    /Workspace is not configured/
  );
});

test("Agent thread send starts a follow-up turn through the driver", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => {
      throw new Error("not used");
    },
    send: async (params) => {
      calls.push(params);
    }
  };
  const threadId = "019f0000-0000-7000-8000-000000000002";

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "补充新证据",
    cwd: process.cwd()
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 202);
  assert.deepEqual(calls, [{
    threadId,
    prompt: "补充新证据",
    cwd: path.resolve(process.cwd()),
    sandbox: "workspace-write"
  }]);
});

test("Agent thread send accepts danger-full-access for Windows sandbox recovery", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { calls.push(params); }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000003",
    prompt: "恢复调查",
    cwd: process.cwd(),
    sandbox: "danger-full-access"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal((calls[0] as { sandbox: string }).sandbox, "danger-full-access");
});
