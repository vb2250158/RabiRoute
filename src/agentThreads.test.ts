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

test("Agent task list delegates to the Desktop-backed driver within configured workspaces", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [{ id: "thread-1", title: "调查任务", updatedAt: "2026-07-15T00:00:00Z" }];
    },
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "list",
    query: "调查",
    limit: 5
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.deepEqual(calls, [{ query: "调查", limit: 6, offset: 0, allowedWorkspaces: [process.cwd()] }]);
  assert.deepEqual(result.data.threads, [
    { id: "thread-1", title: "调查任务", updatedAt: "2026-07-15T00:00:00Z" }
  ]);
});

test("Agent task list exposes every page instead of hiding tasks after a fixed cap", async () => {
  const driver: AgentThreadDriver = {
    list: async ({ offset, limit }) => Array.from({ length: limit }, (_, index) => ({
      id: `thread-${offset + index}`,
      title: `任务 ${offset + index}`,
      updatedAt: "2026-07-15T00:00:00Z"
    })),
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({ action: "list", limit: 100, offset: 100 }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal((result.data.threads as unknown[]).length, 100);
  assert.equal(result.data.nextOffset, 200);
});

test("Agent task resolver binds an exact Desktop task id before considering its name", async () => {
  const calls: string[] = [];
  const driver: AgentThreadDriver = {
    list: async () => { calls.push("list"); return []; },
    read: async (threadId) => ({
      id: threadId,
      title: "RabiLink",
      cwd: process.cwd(),
      updatedAt: "2026-07-15T00:00:00Z"
    }),
    create: async () => { calls.push("create"); throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: "019f0000-0000-7000-8000-000000000010",
    title: "ignored name",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "id");
  assert.deepEqual(calls, []);
});

test("Agent task resolver migrates a route name stored in the id field and finds by name", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [{
        id: "019f0000-0000-7000-8000-000000000011",
        title: "RabiLink",
        cwd: process.cwd(),
        updatedAt: "2026-07-15T00:00:00Z"
      }];
    },
    read: async () => { throw new Error("must not read an invalid id"); },
    create: async () => { throw new Error("must not create"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: "RabiLink",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.data.resolution, "name");
  assert.deepEqual(calls, [{
    query: "RabiLink",
    limit: 10_000,
    offset: 0,
    allowedWorkspaces: [path.resolve(process.cwd())]
  }]);
});

test("Agent task resolver creates only when no exact name exists", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      calls.push(params);
      return {
        id: "019f0000-0000-7000-8000-000000000012",
        title: params.title,
        updatedAt: "2026-07-15T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title: "新会话",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 201);
  assert.equal(result.data.resolution, "created");
  assert.equal(calls.length, 1);
});

test("Agent task resolver creates one task when repeated requests arrive before Desktop indexing catches up", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    // Reproduce the real boundary: thread/start has returned, but the Desktop
    // read model queried by list has not exposed the new task yet.
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        id: `019f0000-0000-7000-8000-${String(createCount).padStart(12, "0")}`,
        title: params.title,
        updatedAt: "2026-07-16T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };
  const request = {
    action: "resolve" as const,
    title: "Rabi",
    cwd: process.cwd(),
    createIfMissing: true
  };
  const options = { allowedWorkspaces: [process.cwd()] };

  const firstPair = await Promise.all([
    handleAgentThreadRequest(request, options, driver),
    handleAgentThreadRequest(request, options, driver)
  ]);
  const immediateRetry = await handleAgentThreadRequest(request, options, driver);

  assert.equal(createCount, 1);
  assert.equal((firstPair[0].data.thread as { id: string }).id, (firstPair[1].data.thread as { id: string }).id);
  assert.equal((firstPair[0].data.thread as { id: string }).id, (immediateRetry.data.thread as { id: string }).id);
});

test("Agent task resolver reports duplicate names instead of picking one", async () => {
  const driver: AgentThreadDriver = {
    list: async () => [
      { id: "019f0000-0000-7000-8000-000000000013", title: "同名", updatedAt: "2026-07-15T01:00:00Z" },
      { id: "019f0000-0000-7000-8000-000000000014", title: "同名", updatedAt: "2026-07-15T00:00:00Z" }
    ],
    read: async () => ({}),
    create: async () => { throw new Error("must not create"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({ action: "resolve", title: "同名" }, {
    allowedWorkspaces: [process.cwd()],
    defaultWorkspace: process.cwd()
  }, driver);

  assert.equal(result.statusCode, 409);
  assert.equal(result.data.resolution, "ambiguous");
  assert.equal((result.data.candidates as unknown[]).length, 2);
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
        source: "Codex Desktop task owner",
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
