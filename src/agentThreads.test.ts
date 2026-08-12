import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentThreadRequestFailureData,
  handleAgentThreadRequest,
  listAgentThreadsFromIndexForTest,
  validateAgentThreadHandoffPromptForTest,
  type AgentThreadDriver
} from "./agentThreads.js";
import { listCodexDesktopThreadsFromRowsForTest } from "./codexDesktopBridge.js";
import { proactiveCommunicationPolicyLines } from "./shared/agentCommunicationPolicy.js";
import { AgentRequestStore, type AgentRequestPersistence } from "./agentRequests/store.js";

class MemoryAgentRequestPersistence implements AgentRequestPersistence {
  value: unknown;
  read(): unknown { return this.value; }
  write(state: unknown): void { this.value = structuredClone(state); }
}

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

test("Agent task resolver binds an existing Desktop task by saved id and workspace", async () => {
  const calls: string[] = [];
  const driver: AgentThreadDriver = {
    list: async () => { calls.push("list"); return []; },
    read: async (threadId) => ({
      id: threadId,
      title: "[RabiRoute 事件] Desktop 自动写入的首条消息",
      cwd: process.cwd(),
      updatedAt: "2026-07-15T00:00:00Z"
    }),
    create: async () => { calls.push("create"); throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: "019f0000-0000-7000-8000-000000000010",
    title: "RabiLink",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "id");
  assert.deepEqual(calls, []);
});

test("Agent task resolver keeps a valid saved id even when the display title exceeds the create limit", async () => {
  const threadId = "019f0000-0000-7000-8000-000000000045";
  const longDisplayTitle = "很长的 Desktop 展示标题".repeat(30);
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => { throw new Error("must not list"); },
    read: async () => ({
      id: threadId,
      title: longDisplayTitle,
      cwd: process.cwd(),
      updatedAt: "2026-07-22T00:00:00Z"
    }),
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId,
    title: longDisplayTitle,
    cwd: process.cwd(),
    createIfMissing: true
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "id");
  assert.equal((result.data.thread as { id: string }).id, threadId);
  assert.equal(createCount, 0);
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

test("Agent task resolver truncates an overlong new task title before create", async () => {
  const requestedTitle = `${"新任务😀".repeat(60)}结尾`;
  let createdTitle = "";
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createdTitle = params.title;
      return {
        id: "019f0000-0000-7000-8000-000000000046",
        title: params.title,
        updatedAt: "2026-07-22T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title: requestedTitle,
    cwd: process.cwd(),
    createIfMissing: true
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 201);
  assert.ok(createdTitle.length <= 240);
  assert.equal(createdTitle.endsWith("\ud800"), false);
  assert.equal(createdTitle.endsWith("\udbff"), false);
  assert.equal((result.data.thread as { title: string }).title, createdTitle);
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

test("Agent task resolver binds the most recently updated same-name task", async () => {
  const driver: AgentThreadDriver = {
    list: async () => [
      { id: "019f0000-0000-7000-8000-000000000014", title: "同名", updatedAt: "2026-07-15T00:00:00Z" },
      { id: "019f0000-0000-7000-8000-000000000013", title: "同名", updatedAt: "2026-07-15T01:00:00Z" }
    ],
    read: async () => ({}),
    create: async () => { throw new Error("must not create"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({ action: "resolve", title: "同名" }, {
    allowedWorkspaces: [process.cwd()],
    defaultWorkspace: process.cwd()
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, "019f0000-0000-7000-8000-000000000013");
});

test("Agent task resolver ignores archived duplicates during name lookup and binds the latest unarchived task", async () => {
  const title = "MonsterGirl / 伊莉娅 策划美术";
  const cwd = process.cwd();
  const archivedId = "019f0000-0000-7000-8000-000000000041";
  const olderId = "019f0000-0000-7000-8000-000000000042";
  const latestId = "019f0000-0000-7000-8000-000000000043";
  const rows = [
    { id: archivedId, title, cwd, archived: 1, updated_at_ms: 3_000 },
    { id: olderId, title, cwd, archived: 0, updated_at_ms: 1_000 },
    { id: latestId, title, cwd, archived: 0, updated_at_ms: 2_000 }
  ];
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ query, limit, offset, allowedWorkspaces }) => listCodexDesktopThreadsFromRowsForTest(rows, {
      query,
      limit,
      offset,
      allowedWorkspaces
    }),
    read: async (threadId) => listCodexDesktopThreadsFromRowsForTest(
      rows.filter((row) => row.id === threadId),
      { limit: 1 }
    )[0] ?? null,
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    title,
    cwd,
    createIfMissing: true
  }, {
    allowedWorkspaces: [cwd],
    defaultWorkspace: cwd
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, latestId);
  assert.equal(createCount, 0);
});

test("Agent task resolver never creates a replacement for an archived saved binding", async () => {
  const archived = {
    id: "019f0000-0000-7000-8000-000000000044",
    title: "已归档的固定任务",
    cwd: process.cwd(),
    updatedAt: "2026-07-18T04:00:00Z",
    archived: true
  };
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async () => archived,
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: archived.id,
    title: archived.title,
    cwd: archived.cwd,
    createIfMissing: true
  }, {
    allowedWorkspaces: [archived.cwd],
    defaultWorkspace: archived.cwd
  }, driver);

  assert.equal(result.statusCode, 409);
  assert.equal(result.data.resolution, "archived");
  assert.equal((result.data.thread as { id: string }).id, archived.id);
  assert.equal(createCount, 0);
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
      "开始工作前先读取当前任务的完整相关历史和已有结论，不得只看标题、摘要或最后一条消息。",
      ...proactiveCommunicationPolicyLines("internal"),
      "除非当前用户明确授权，禁止新建额外工作副本、稀疏检出、复制工程或旁路目录；工作区中的 AGENTS.md 如有更严格限制，以其为准。",
      "只有改动已经进入用户实际运行或验收的目标工作区，并完成适用的资源关联、构建或编译及运行验证，才能称为“已修复”或“可验收”；临时目录、其他分支、服务器提交或测试工程结果不能替代用户入口。",
      "PangHu 任务没有创建旁路工作副本的例外：只使用正式 Main、Release 和 Art；旧任务或历史记录中的隔离、稀疏、clean working copy 安排已经撤销。",
      "多步任务开始后要让当前任务中的人看得出你准备做什么；取得阶段结果、遇到风险或进入等待时主动更新，不要等别人追问。"
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
  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string };
  assert.equal(sent.threadId, threadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.match(sent.prompt, /^\[协作要求\]/);
  assert.match(sent.prompt, /PangHu 任务没有创建旁路工作副本的例外/);
  assert.match(sent.prompt, /\[投递内容\]\n补充新证据$/);
});

test("Agent thread send forwards validated workspace image paths to Desktop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-image-"));
  const imagePath = path.join(root, "message.png");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  let delivered: Parameters<AgentThreadDriver["send"]>[0] | undefined;
  const driver: AgentThreadDriver = {
    read: async () => ({ id: "thread-1", title: "消息处理", cwd: root }),
    create: async () => { throw new Error("not used"); },
    send: async (params) => { delivered = params; }
  };

  await handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000091",
    prompt: "查看图片",
    cwd: root,
    imagePaths: [imagePath]
  }, { allowedWorkspaces: [root] }, driver);

  assert.deepEqual(delivered?.imagePaths, [imagePath]);
  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000091",
    prompt: "查看图片",
    cwd: root,
    imagePaths: [path.join(os.tmpdir(), "outside.png")]
  }, { allowedWorkspaces: [root] }, driver), /inside the target workspace/);
});

test("system-owned task resolution requests the bounded Desktop state index", async () => {
  const listCalls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => { listCalls.push(params); return []; },
    read: async () => { throw new Error("not used"); },
    create: async (params) => ({
      id: "019f0000-0000-7000-8000-000000000099",
      title: params.title,
      updatedAt: "2026-08-04T00:00:00Z",
      source: "test",
      initialTurnStatus: "not-requested"
    }),
    send: async () => undefined
  };

  await handleAgentThreadRequest({
    action: "resolve",
    title: "星海主任务 协助处理消息1",
    cwd: process.cwd(),
    lookupMode: "state_db"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.deepEqual(listCalls, [{
    query: "星海主任务 协助处理消息1",
    limit: 10_000,
    offset: 0,
    allowedWorkspaces: [path.resolve(process.cwd())],
    stateDbOnly: true
  }]);
});

test("Agent thread send forwards the Message Agent model independently", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async (params) => {
      calls.push(params);
      return {
        threadId,
        action: "steered",
        openedThread: false,
        transport: "desktop-ipc"
      };
    }
  };
  const threadId = "019f0000-0000-7000-8000-000000000005";

  await handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "处理这个消息组",
    cwd: process.cwd(),
    model: "gpt-5.6-luna",
    reasoningEffort: "medium"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string; model: string; reasoningEffort: string };
  assert.equal(sent.threadId, threadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.equal(sent.model, "gpt-5.6-luna");
  assert.equal(sent.reasoningEffort, "medium");
  assert.match(sent.prompt, /^\[协作要求\]/);
  assert.match(sent.prompt, /PangHu 任务没有创建旁路工作副本的例外/);
  assert.match(sent.prompt, /\[投递内容\]\n处理这个消息组$/);
});

test("Agent-to-Agent send shows the verified source task, Agent type, and session id", async () => {
  const calls: unknown[] = [];
  const targetThreadId = "019f0000-0000-7000-8000-000000000002";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000003";
  const driver: AgentThreadDriver = {
    read: async (threadId) => {
      assert.equal(threadId, sourceThreadId);
      return {
        id: sourceThreadId,
        title: "星海建造师 策划 程序 协助处理计划4",
        cwd: process.cwd(),
        updatedAt: "2026-08-04T08:01:00.000Z"
      };
    },
    create: async () => { throw new Error("not used"); },
    send: async (params) => {
      calls.push(params);
      return {
        threadId: targetThreadId,
        action: "steered",
        openedThread: false,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "计划已经完成，请决定是否回复群消息。",
    cwd: process.cwd(),
    sourceThreadId,
    sourceAgentType: "plan_secretary",
    responsePolicy: "none"
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, "delivered");
  assert.deepEqual(result.data.delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "steered",
    transport: "desktop-ipc",
    openedThread: false
  });
  assert.deepEqual(result.data.source, {
    agentType: "plan_secretary",
    agentLabel: "计划秘书 Agent",
    threadId: sourceThreadId,
    threadName: "星海建造师 策划 程序 协助处理计划4",
    workspace: process.cwd()
  });
  assert.equal(calls.length, 1);
  const sent = calls[0] as { threadId: string; prompt: string; cwd: string; sandbox: string };
  assert.equal(sent.threadId, targetThreadId);
  assert.equal(sent.cwd, path.resolve(process.cwd()));
  assert.equal(sent.sandbox, "workspace-write");
  assert.match(sent.prompt, /\[Agent 任务投递来源\]/);
  assert.match(sent.prompt, /\[Agent 回复合同\]/);
  assert.match(sent.prompt, /是否要求回复：否/);
  assert.match(sent.prompt, /本次投递不要求回复/);
  assert.match(sent.prompt, /禁止新建额外工作副本、稀疏检出、复制工程或旁路目录/);
  assert.match(sent.prompt, /临时目录、其他分支、服务器提交或测试工程结果不能替代用户入口/);
  assert.match(sent.prompt, /PangHu 任务没有创建旁路工作副本的例外/);
  assert.match(sent.prompt, /\[投递内容\]\n计划已经完成，请决定是否回复群消息。$/);
});

test("message-processing handoff reports a structured requirement after the target owner accepts it", async () => {
  const targetThreadId = "019f0000-0000-7000-8000-000000000082";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000083";
  const handoffs: unknown[] = [];
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  let sent = false;
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "星海建造师 协助处理消息2",
      cwd: process.cwd(),
      updatedAt: "2026-08-05T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => {
      sent = true;
      return {
        threadId: targetThreadId,
        action: "started",
        openedThread: true,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "请核对 plan-1 的最新进展并把结果返回消息处理任务。",
    cwd: process.cwd(),
    sourceThreadId,
    sourceAgentType: "message_processing",
    responsePolicy: "required",
    responseInstruction: "核对完成后把结果和下一步返回消息处理任务",
    messageProcessing: {
      requirementId: "message-group-1:main",
      outcome: "handoff",
      targetAgentType: "plan_agent",
      planId: "plan-1",
      planTitle: "实现选择界面"
    }
  }, {
    allowedWorkspaces: [process.cwd()],
    agentRequests,
    onMessageProcessingHandoff: (event) => { handoffs.push(event); }
  }, driver);

  assert.equal(sent, true);
  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, "delivered");
  const communication = result.data.communication as Record<string, unknown>;
  assert.equal(communication.responsePolicy, "required");
  assert.equal(communication.requestStatus, "awaiting_response");
  assert.deepEqual(result.data.delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "started",
    transport: "desktop-ipc",
    openedThread: true
  });
  assert.deepEqual(result.data.handoff, {
    status: "recorded",
    requirementId: "message-group-1:main",
    targetAgentType: "plan_agent",
    targetThreadId
  });
  assert.deepEqual(handoffs, [{
    requirementId: "message-group-1:main",
    sourceThreadId,
    targetThreadId,
    targetAgentType: "plan_agent",
    planId: "plan-1",
    planTitle: "实现选择界面"
  }]);
});

test("message-processing handoff returns a partial failure without hiding the accepted target delivery", async () => {
  const targetThreadId = "019f0000-0000-7000-8000-000000000084";
  const sourceThreadId = "019f0000-0000-7000-8000-000000000085";
  let sendCount = 0;
  const agentRequests = new AgentRequestStore(new MemoryAgentRequestPersistence());
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "消息处理任务",
      cwd: process.cwd(),
      updatedAt: "2026-08-05T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => {
      sendCount += 1;
      return {
        threadId: targetThreadId,
        action: "started",
        openedThread: true,
        transport: "desktop-ipc"
      };
    }
  };

  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: targetThreadId,
    prompt: "请处理并返回。",
    cwd: process.cwd(),
    sourceThreadId,
    sourceAgentType: "message_processing",
    responsePolicy: "required",
    responseInstruction: "处理完成后把结果和下一步返回消息处理任务",
    messageProcessing: {
      requirementId: "message-group-2:main",
      outcome: "handoff",
      targetAgentType: "plan_secretary"
    }
  }, {
    allowedWorkspaces: [process.cwd()],
    agentRequests,
    onMessageProcessingHandoff: () => { throw new Error("board write failed"); }
  }, driver);

  assert.equal(sendCount, 1);
  assert.equal(result.statusCode, 202);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.status, "delivered_tracking_failed");
  assert.deepEqual(result.data.delivery, {
    status: "delivered",
    targetThreadId,
    acceptedBy: "codex_desktop_owner",
    action: "started",
    transport: "desktop-ipc",
    openedThread: true
  });
  assert.deepEqual(result.data.handoff, {
    status: "tracking_failed",
    requirementId: "message-group-2:main",
    targetAgentType: "plan_secretary",
    targetThreadId,
    error: {
      stage: "message_processing_tracking",
      message: "Agent handoff was accepted, but the message-processing board update failed: board write failed",
      retryable: true
    }
  });
});

test("Agent thread create reuses the same title and workspace instead of creating a duplicate", async () => {
  const existing = {
    id: "019f0000-0000-7000-8000-000000000071",
    title: "[PangHu][Bug] 摆放系统 - 建筑或物件位置重叠",
    updatedAt: "2026-08-11T12:36:03.891Z",
    cwd: process.cwd(),
    archived: false
  };
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ stateDbOnly }) => {
      assert.equal(stateDbOnly, true);
      return [existing];
    },
    read: async () => existing,
    create: async () => {
      createCount += 1;
      throw new Error("must not create");
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "create",
    title: existing.title,
    prompt: "只读调查。",
    cwd: existing.cwd
  }, {
    allowedWorkspaces: [existing.cwd]
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(result.data.resolution, "name");
  assert.equal((result.data.thread as { id: string }).id, existing.id);
  assert.equal(createCount, 0);
});

test("Agent thread create shares one in-flight creation across caller retries", async () => {
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async ({ stateDbOnly }) => {
      assert.equal(stateDbOnly, true);
      return [];
    },
    read: async () => { throw new Error("not used"); },
    create: async (params) => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        id: "019f0000-0000-7000-8000-000000000072",
        title: params.title,
        updatedAt: "2026-08-11T12:36:03.891Z",
        source: "test",
        initialTurnStatus: "started"
      };
    },
    send: async () => undefined
  };
  const request = {
    action: "create" as const,
    title: "[PangHu][Bug] 摆放系统 - 建筑或物件位置重叠",
    prompt: "只读调查。",
    cwd: process.cwd()
  };
  const options = { allowedWorkspaces: [process.cwd()] };

  const results = await Promise.all([
    handleAgentThreadRequest(request, options, driver),
    handleAgentThreadRequest(request, options, driver)
  ]);

  assert.equal(createCount, 1);
  assert.equal(results[0].statusCode, 201);
  assert.equal(results[1].statusCode, 201);
  assert.equal(
    (results[0].data.thread as { id: string }).id,
    (results[1].data.thread as { id: string }).id
  );
});

test("Agent thread list can use the fast local state index for timeout readback", async () => {
  const calls: unknown[] = [];
  const driver: AgentThreadDriver = {
    list: async (params) => {
      calls.push(params);
      return [];
    },
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "list",
    query: "摆放系统",
    lookupMode: "state_db",
    cwd: process.cwd()
  }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { stateDbOnly?: boolean }).stateDbOnly, true);
});

test("Agent thread failures expose the action, missing field, and retry guidance", () => {
  assert.deepEqual(agentThreadRequestFailureData(new Error("Missing prompt."), { action: "send" }), {
    action: "send",
    status: "failed",
    message: "Missing prompt.",
    error: {
      stage: "validation",
      field: "prompt",
      message: "Missing prompt.",
      retryable: false
    }
  });
  assert.deepEqual(agentThreadRequestFailureData(
    new Error("sourceAgentType requires sourceThreadId."),
    { action: "send" }
  ), {
    action: "send",
    status: "failed",
    message: "sourceAgentType requires sourceThreadId.",
    error: {
      stage: "source_verification",
      field: "sourceThreadId",
      message: "sourceAgentType requires sourceThreadId.",
      retryable: false
    }
  });
  assert.deepEqual(agentThreadRequestFailureData(
    new Error("responsePolicy is required for Agent-to-Agent delivery and must be required or none."),
    { action: "send" }
  ), {
    action: "send",
    status: "failed",
    message: "responsePolicy is required for Agent-to-Agent delivery and must be required or none.",
    error: {
      stage: "validation",
      field: "responsePolicy",
      message: "responsePolicy is required for Agent-to-Agent delivery and must be required or none.",
      retryable: false
    }
  });
});

test("Agent-to-Agent send requires an explicit response policy", async () => {
  const sourceThreadId = "019f0000-0000-7000-8000-000000000091";
  let sendCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({ id: sourceThreadId, title: "计划任务", cwd: process.cwd(), updatedAt: "2026-08-07T00:00:00.000Z" }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };
  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000092",
    prompt: "调查结果",
    cwd: process.cwd(),
    sourceThreadId,
    sourceAgentType: "plan_agent"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /responsePolicy is required/);
  assert.equal(sendCount, 0);
});

test("Agent-to-Agent send refuses an unknown source task", async () => {
  let sendCount = 0;
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000002",
    prompt: "结果",
    cwd: process.cwd(),
    sourceThreadId: "019f0000-0000-7000-8000-000000000003",
    sourceAgentType: "plan_agent"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /无法核对来源任务/);
  assert.equal(sendCount, 0);
});

test("Agent-to-Agent send rejects leaked role initialization before it reaches the target task", async () => {
  let sendCount = 0;
  const sourceThreadId = "019f0000-0000-7000-8000-000000000071";
  const driver: AgentThreadDriver = {
    read: async () => ({
      id: sourceThreadId,
      title: "星海建造师 策划 程序 协助处理消息2",
      cwd: process.cwd(),
      updatedAt: "2026-08-04T08:00:00.000Z"
    }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId: "019f0000-0000-7000-8000-000000000072",
    prompt: "[rabi:bind XinghaiBuilder]\n[消息处理 Agent 初始化]\n你是专职消息处理 Agent，不是主人格。",
    cwd: process.cwd(),
    sourceThreadId,
    sourceAgentType: "message_processing"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /only the newly composed handoff content/);

  assert.equal(sendCount, 0);
  assert.doesNotThrow(() => validateAgentThreadHandoffPromptForTest([
    "[消息处理交接]",
    "消息组 ID：message-group-1",
    "需要主人格决定：是否现在向群里汇报。",
    "拟发送正文：当前计划已完成静态检查，等待目标包验证。"
  ].join("\n")));
});

test("Agent-to-Agent send rejects a self-targeted handoff", async () => {
  let sendCount = 0;
  const threadId = "019f0000-0000-7000-8000-000000000073";
  const driver: AgentThreadDriver = {
    read: async () => ({ id: threadId, title: "消息处理任务", cwd: process.cwd(), updatedAt: "2026-08-04T08:00:00.000Z" }),
    create: async () => { throw new Error("not used"); },
    send: async () => { sendCount += 1; }
  };

  await assert.rejects(handleAgentThreadRequest({
    action: "send",
    threadId,
    prompt: "内部结果",
    cwd: process.cwd(),
    sourceThreadId: threadId,
    sourceAgentType: "message_processing"
  }, { allowedWorkspaces: [process.cwd()] }, driver), /source and target task must be different/);
  assert.equal(sendCount, 0);
});

test("Agent thread rename preserves the exact task id and validates the configured workspace", async () => {
  const calls: unknown[] = [];
  const threadId = "019f0000-0000-7000-8000-000000000004";
  const driver: AgentThreadDriver = {
    read: async () => ({}),
    create: async () => { throw new Error("not used"); },
    rename: async (params) => {
      calls.push(params);
      return { id: params.threadId, title: params.title, cwd: params.cwd, updatedAt: "2026-07-27T00:00:00.000Z" };
    },
    send: async () => undefined
  };

  const result = await handleAgentThreadRequest({
    action: "rename",
    threadId,
    title: "主任务 协助处理计划1",
    cwd: process.cwd()
  }, { allowedWorkspaces: [process.cwd()] }, driver);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, [{
    threadId,
    title: "主任务 协助处理计划1",
    cwd: path.resolve(process.cwd())
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
