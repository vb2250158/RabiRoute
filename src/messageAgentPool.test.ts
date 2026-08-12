import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { MessageAgentPool, requestMessageAgentManager } from "./messageAgentPool.js";
import type { PendingMessageGroup } from "./messageGrouping.js";

function group(groupId: string, patch: Partial<PendingMessageGroup> = {}): PendingMessageGroup {
  return {
    groupId,
    key: groupId,
    baseKey: "napcat|group:100|sender:200",
    endpoint: "napcat",
    conversationKey: "napcat:group:100",
    sender: "200",
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
    maxDeadlineAt: 3,
    status: "pending",
    attempts: 0,
    items: [{ identity: `${groupId}-m1`, receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { rawMessage: "hi" }, extraValues: {} } }],
    ...patch
  };
}

function options(statePath: string) {
  return {
    statePath,
    managerBaseUrl: "http://127.0.0.1:8790",
    sourceThreadName: "星海主任务",
    sourceThreadId: "019f0000-0000-7000-8000-999999999999",
    workspace: process.cwd(),
    roleId: "XinghaiBuilder",
    roleDisplayName: "星海建造师 策划 程序",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium" as const
  };
}

test("Message Agent Manager requests use a one-shot connection and close it after the response", async (t) => {
  let requestConnection = "";
  let socketClosed = false;
  let resolveSocketClosed = (): void => undefined;
  const socketClosedPromise = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = http.createServer((request, response) => {
    requestConnection = String(request.headers.connection || "");
    request.socket.once("close", () => {
      socketClosed = true;
      resolveSocketClosed();
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, thread: { id: "thread-1" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await requestMessageAgentManager(`http://127.0.0.1:${address.port}`, { action: "read" }, 5_000);
  await socketClosedPromise;

  assert.equal(result.thread?.id, "thread-1");
  assert.equal(requestConnection.toLowerCase(), "close");
  assert.equal(socketClosed, true);
});

test("a one-shot delivery child can exit immediately after its Manager request", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, thread: { id: "thread-1" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "messageAgentPool.ts")).href;
  const script = [
    `const { requestMessageAgentManager } = await import(${JSON.stringify(moduleUrl)});`,
    `await requestMessageAgentManager(${JSON.stringify(`http://127.0.0.1:${address.port}`)}, { action: "read" }, 1000);`,
    `process.exit(0);`
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING/);
});

test("Message Agent pool creates a Desktop task and sends the first group with Luna initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    now: () => new Date("2026-08-04T06:00:00.000Z"),
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: "019f0000-0000-7000-8000-000000000010", title: payload.title, cwd: process.cwd() } };
      return {};
    }
  });

  const imagePath = path.join(root, "message.png");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  const worker = await pool.deliver(group("g1"), "[消息组 g1]\n你好", { imagePaths: [imagePath] });
  const resolveCall = calls.find((call) => call.action === "resolve");
  const sendCall = calls.find((call) => call.action === "send");
  assert.equal(worker.threadName, "星海建造师 策划 程序 协助处理消息");
  assert.equal(resolveCall?.lookupMode, "state_db");
  assert.equal(sendCall?.model, "gpt-5.6-luna");
  assert.equal(sendCall?.reasoningEffort, "medium");
  assert.deepEqual(sendCall?.imagePaths, [imagePath]);
  assert.match(String(sendCall?.prompt), /你是专职消息处理 Agent/);
  assert.match(String(sendCall?.prompt), /\[消息组 g1\]/);
  assert.match(String(sendCall?.prompt), /\[当前消息处理归属\]/);
  assert.match(String(sendCall?.prompt), new RegExp(`threadId=${worker.threadId}`));
  assert.match(String(sendCall?.prompt), /把计划 ID、进展或判断结果送回本消息处理任务/);
  assert.match(String(sendCall?.prompt), /sourceThreadId=对方自己的完整任务 ID/);
  assert.match(String(sendCall?.prompt), /sourceAgentType=plan_secretary 或 plan_agent 或 primary_persona/);
  assert.match(String(sendCall?.prompt), new RegExp(`sourceThreadId=${worker.threadId}`));
  assert.match(String(sendCall?.prompt), /sourceAgentType=message_processing/);
  assert.match(String(sendCall?.prompt), /当前消息处理任务的 Codex 最终输出只供内部查看/);
  assert.match(String(sendCall?.prompt), /原群成员、私聊对象和主人格都不会自动看到/);
  assert.match(String(sendCall?.prompt), /不得把“请用户确认”或待审批问题只写在当前任务的最终输出里/);
  assert.match(String(sendCall?.prompt), new RegExp(`threadId=${options(path.join(root, "unused.json")).sourceThreadId}`));
  assert.match(String(sendCall?.prompt), /投递给主人格并取得 Manager 接受回执/);
  assert.match(String(sendCall?.prompt), /处理结果：无需对外回复/);
  assert.match(String(sendCall?.prompt), /是否需要计划操作与是否需要回复必须分开判断/);
  assert.match(String(sendCall?.prompt), /普通群聊不要求逐条发言/);
  assert.match(String(sendCall?.prompt), /先完成调查，再回复查到的事实/);
  assert.match(String(sendCall?.prompt), /实际查看附件内容/);
  assert.match(String(sendCall?.prompt), /params\.replyImageDescriptions/);
  assert.match(String(sendCall?.prompt), /按原图顺序逐张写明图片内容/);
  assert.match(String(sendCall?.prompt), /“我这边改 ok”.*“ok”.*保持安静/);
  assert.match(String(sendCall?.prompt), /群内可见回复默认只写一到两句/);
});

test("direct replies default to a visible acknowledgement even when no plan changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-explicit-reply-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000011", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await pool.deliver(group("direct-reply", {
    items: [{
      identity: "direct-reply-m1",
      receivedAt: 1,
      incomplete: false,
      payload: { routeKind: "direct_reply", record: { rawMessage: "我先搭效果，你之后再关联。" }, extraValues: {} }
    }]
  }), "[消息组 direct-reply]\n我先搭效果，你之后再关联。");

  const prompt = String(calls.find((call) => call.action === "send")?.prompt || "");
  assert.match(prompt, /当前消息明确面向本角色，默认必须让对方看到回应/);
  assert.match(prompt, /不得用“无需新建计划”“无需实施”“只是澄清”直接推出“无需回复”/);
  assert.match(prompt, /纯结束语\/重复消息\/机器人自身消息\/他人已完整回答且无新增价值/);
});

test("Message Agent initialization resolves the current Primary Persona title by complete task id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-primary-title-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({
    ...options(path.join(root, "agents.json")),
    sourceThreadName: "“星海建造师 策划 程序” 这个会话宕机了？"
  }, {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read" && payload.threadId === options(path.join(root, "unused.json")).sourceThreadId) {
        return { thread: { id: payload.threadId, title: "星海建造师 策划 程序", cwd: process.cwd(), status: { type: "idle" }, active: false } };
      }
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000012", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await pool.deliver(group("current-primary-title"), "检查名称");

  const prompt = String(calls.find((call) => call.action === "send")?.prompt || "");
  assert.match(prompt, /主人格任务：星海建造师 策划 程序/);
  assert.match(prompt, /当前主人格任务：星海建造师 策划 程序/);
  assert.doesNotMatch(prompt, /这个会话宕机了/);
});

test("Message Agent pool refuses to initialize inside the Primary Persona task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-role-crossover-"));
  const primaryThreadId = options(path.join(root, "agents.json")).sourceThreadId;
  let sendCount = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { id: primaryThreadId, title: "星海建造师 策划 程序", cwd: process.cwd(), status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") return { thread: { id: primaryThreadId, title: payload.title, cwd: process.cwd() } };
      if (payload.action === "send") sendCount += 1;
      return {};
    }
  });

  await assert.rejects(pool.deliver(group("role-crossover"), "不得进入主人格"), /refusing role crossover/);
  assert.equal(sendCount, 0);
  assert.equal(pool.snapshot().workers.length, 0);
});

test("heartbeat Message Agent performs the omission scan itself and does not forward the scheduled task to the Primary Persona", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-heartbeat-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000011", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await pool.deliver(group("heartbeat-group", {
    baseKey: "heartbeat|main",
    endpoint: "heartbeat",
    conversationKey: "heartbeat:gateway:XinghaiBuilder-main:heartbeat:heartbeat",
    sender: "RabiRoute 定时触发",
    items: [{
      identity: "heartbeat-message",
      receivedAt: 1,
      incomplete: false,
      payload: {
        routeKind: "heartbeat",
        record: { rawMessage: "检查工作群遗漏与计划登记" },
        extraValues: {}
      }
    }]
  }), "[heartbeat 巡检]");

  const prompt = String(calls.find((call) => call.action === "send")?.prompt || "");
  assert.match(prompt, /heartbeat 巡检由当前消息处理 Agent 自己执行/);
  assert.match(prompt, /增量读取群消息并与计划摘要、问题映射和发送回执对比/);
  assert.match(prompt, /上线\/公测日期、版本范围、批准\/否决、负责人变更、取消\/延期或发布版本/);
  assert.match(prompt, /criticalFactDisposition/);
  assert.match(prompt, /不得把 heartbeat 任务本身投给主人格/);
  assert.match(prompt, /把自上次群汇报后出现的真实工作进展整理成可直接发送的简短正文/);
  assert.match(prompt, /只有形成需要主人格用户决定的具体问题、跨计划冲突或已经准备好的群进展\/提醒正文/);
  assert.match(prompt, /没有遗漏、没有真实新进展且只完成内部控制面更新时保持安静/);
});

test("repeated heartbeat ticks always reuse the existing heartbeat worker even while it is active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-heartbeat-reuse-"));
  let created = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return {
          thread: {
            id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`,
            title: payload.title,
            cwd: process.cwd()
          }
        };
      }
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });
  const heartbeat = (groupId: string) => group(groupId, {
    baseKey: "heartbeat|main",
    endpoint: "heartbeat",
    conversationKey: "heartbeat:gateway:XinghaiBuilder-main:heartbeat:heartbeat",
    sender: "RabiRoute 定时触发"
  });

  const first = await pool.deliver(heartbeat("heartbeat-one"), "first tick");
  const second = await pool.deliver(heartbeat("heartbeat-two"), "second tick");

  assert.equal(created, 1);
  assert.equal(second.threadId, first.threadId);
  assert.deepEqual(sent, [first.threadId, first.threadId]);
});

test("Message Agent pool reuses an idle familiar worker but creates another when it is busy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-affinity-"));
  const statePath = path.join(root, "agents.json");
  let created = 0;
  let active = false;
  const sends: string[] = [];
  const prompts: string[] = [];
  const resolvedTitles: string[] = [];
  const renameCalls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        resolvedTitles.push(String(payload.title));
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "rename") {
        renameCalls.push(payload);
        return { thread: { id: payload.threadId, title: payload.title, cwd: payload.cwd } };
      }
      if (payload.action === "read") return { thread: { active } };
      if (payload.action === "send") {
        sends.push(String(payload.threadId));
        prompts.push(String(payload.prompt));
      }
      return {};
    }
  });

  const first = await pool.deliver(group("g1"), "first");
  const second = await pool.deliver(group("g2"), "second");
  assert.equal(second.threadId, first.threadId);
  active = true;
  const third = await pool.deliver(group("g3"), "third");
  assert.notEqual(third.threadId, first.threadId);
  assert.equal(created, 2);
  assert.deepEqual(resolvedTitles, [
    "星海建造师 策划 程序 协助处理消息",
    "星海建造师 策划 程序 协助处理消息2"
  ]);
  assert.deepEqual(renameCalls, [{
    action: "rename",
    threadId: first.threadId,
    title: "星海建造师 策划 程序 协助处理消息1",
    cwd: process.cwd()
  }]);
  assert.equal(pool.snapshot().workers[0]?.threadName, "星海建造师 策划 程序 协助处理消息1");
  assert.equal(sends.length, 3);
  assert.match(prompts[2], /\[接续判断\]/);
  assert.match(prompts[2], new RegExp(first.threadId));
  assert.match(prompts[2], /正在处理的内容：\nhi/);
  assert.match(prompts[2], /POST http:\/\/127\.0\.0\.1:8790\/api\/agent\/threads/);
  assert.match(prompts[2], new RegExp(`sourceThreadId=${third.threadId}`));
  assert.match(prompts[2], /sourceAgentType=message_processing/);
  assert.match(prompts[2], /不得复制 \[rabi:bind\]/);
  assert.doesNotMatch(prompts[2], /prompt=本消息组完整内容/);
});

test("Message Agent pool reuses an idle unfamiliar worker before creating another task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-idle-unfamiliar-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000021";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [{
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:01.000Z",
      affinities: [{
        groupId: "old-heartbeat",
        endpoint: "heartbeat",
        conversationKey: "heartbeat:main",
        sender: "timer",
        lastUsedAt: "2026-08-04T06:00:00.000Z"
      }]
    }]
  }), "utf8");
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { active: false } };
      if (payload.action === "send") return {};
      if (payload.action === "resolve") throw new Error("must reuse the idle worker");
      return {};
    }
  });

  const selected = await pool.deliver(group("new-chat", {
    endpoint: "napcat",
    conversationKey: "napcat:group:200",
    sender: "new-speaker"
  }), "new chat");

  assert.equal(selected.threadId, threadId);
  assert.equal(calls.some((call) => call.action === "resolve"), false);
});

test("Message Agent pool with a limit of one keeps task 1 and reuses it while active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-limit-one-"));
  const statePath = path.join(root, "agents.json");
  const firstThreadId = "019f0000-0000-7000-8000-000000000081";
  const secondThreadId = "019f0000-0000-7000-8000-000000000082";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-12T06:00:00.000Z",
    workers: [
      {
        threadId: firstThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息1",
        workspace: process.cwd(),
        index: 1,
        createdAt: "2026-08-04T06:00:00.000Z",
        initializedAt: "2026-08-04T06:00:01.000Z"
      },
      {
        threadId: secondThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息2",
        workspace: process.cwd(),
        index: 2,
        createdAt: "2026-08-04T06:05:00.000Z",
        initializedAt: "2026-08-04T06:05:01.000Z"
      }
    ]
  }), "utf8");
  let resolveCount = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool({ ...options(statePath), maxAgents: 1 }, {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "resolve") resolveCount += 1;
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  const first = await pool.deliver(group("limited-one"), "one");
  const second = await pool.deliver(group("limited-two", { conversationKey: "napcat:group:two" }), "two");

  assert.equal(first.threadId, firstThreadId);
  assert.equal(second.threadId, firstThreadId);
  assert.equal(first.threadName, "星海建造师 策划 程序 协助处理消息1");
  assert.equal(resolveCount, 0);
  assert.deepEqual(sent, [firstThreadId, firstThreadId]);
  assert.deepEqual(pool.snapshot().workers.map((worker) => worker.threadId), [firstThreadId]);
});

test("Message Agent pool creates a numbered task 1 when its configured limit is one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-limit-one-create-"));
  const resolvedTitles: string[] = [];
  const pool = new MessageAgentPool({ ...options(path.join(root, "agents.json")), maxAgents: 1 }, {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        resolvedTitles.push(String(payload.title));
        return { thread: { id: "019f0000-0000-7000-8000-000000000083", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await pool.deliver(group("limited-create"), "create");

  assert.deepEqual(resolvedTitles, ["星海建造师 策划 程序 协助处理消息1"]);
});

test("Message Agent prompt forces schedule decisions to be verified and recorded before closure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-critical-fact-"));
  const calls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      calls.push(payload);
      if (payload.action === "read") return { thread: { status: { type: "idle" }, active: false } };
      if (payload.action === "resolve") {
        return { thread: { id: "019f0000-0000-7000-8000-000000000031", title: payload.title, cwd: process.cwd() } };
      }
      return {};
    }
  });

  await pool.deliver(group("critical-schedule", {
    items: [{
      identity: "critical-schedule-message",
      receivedAt: 1,
      incomplete: false,
      payload: {
        routeKind: "group_message",
        record: { messageId: "msg-schedule-1", rawMessage: "示例项目暂以2030年10月15日为内部上线目标，尚未正式定档" },
        extraValues: {}
      }
    }]
  }), "critical schedule");

  const prompt = String(calls.find((call) => call.action === "send")?.prompt || "");
  assert.match(prompt, /项目事实判断由 Agent 负责/);
  assert.match(prompt, /RabiManager 不根据关键词猜测消息含义/);
  assert.match(prompt, /projectFactAssessment/);
  assert.match(prompt, /criticalFactDisposition/);
  assert.match(prompt, /回答排期、上线日期、版本范围、负责人或审批状态前/);
  assert.match(prompt, /公开公告和旧会议材料只能作为补充/);
});

test("Message Agent pool loads an existing notLoaded task instead of creating another one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-not-loaded-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000023";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [{
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息",
      workspace: process.cwd(),
      index: 1,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:01.000Z"
    }]
  }), "utf8");
  let createCount = 0;
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "notLoaded" }, active: false } };
      if (payload.action === "resolve") createCount += 1;
      return {};
    }
  });

  const selected = await pool.deliver(group("resume-existing"), "resume");

  assert.equal(selected.threadId, threadId);
  assert.equal(createCount, 0);
});

test("Message Agent pool keeps the message pending when Codex Desktop is unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-offline-"));
  let createCount = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "unavailable" }, active: false } };
      if (payload.action === "resolve") createCount += 1;
      return {};
    }
  });

  await assert.rejects(
    pool.deliver(group("desktop-offline"), "wait"),
    /消息组已保留等待恢复/
  );
  assert.equal(createCount, 0);
  assert.equal(pool.snapshot().workers.length, 0);
});

test("Message Agent pool merges duplicate persisted rows for the same Desktop task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-dedupe-"));
  const statePath = path.join(root, "agents.json");
  const threadId = "019f0000-0000-7000-8000-000000000022";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: ["one", "two"].map((groupId, offset) => ({
      threadId,
      threadName: "星海建造师 策划 程序 协助处理消息1",
      workspace: process.cwd(),
      index: 1,
      createdAt: `2026-08-04T06:00:0${offset}.000Z`,
      initializedAt: "2026-08-04T06:00:02.000Z",
      affinities: [{
        groupId,
        endpoint: "napcat",
        conversationKey: `napcat:group:${offset}`,
        sender: `sender-${offset}`,
        lastUsedAt: `2026-08-04T06:00:0${offset}.000Z`
      }]
    }))
  }), "utf8");

  const pool = new MessageAgentPool(options(statePath));
  const snapshot = pool.snapshot();
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.workers[0]?.threadId, threadId);
  assert.deepEqual(pool.affinitySnapshot().workers[0]?.affinities.map((item) => item.groupId).sort(), ["one", "two"]);
  const persistedAgents = JSON.parse(fs.readFileSync(statePath, "utf8")) as { schemaVersion: number; workers: Array<Record<string, unknown>> };
  assert.equal(persistedAgents.schemaVersion, 2);
  assert.equal("affinities" in persistedAgents.workers[0]!, false);
  const persistedAffinity = JSON.parse(fs.readFileSync(path.join(root, "routing-affinity.json"), "utf8")) as {
    workers: Array<{ threadId: string; affinities: Array<{ groupId: string }> }>;
  };
  assert.deepEqual(persistedAffinity.workers[0]?.affinities.map((item) => item.groupId).sort(), ["one", "two"]);
});

test("concurrent Message Agent allocation never records duplicate rows for one task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-concurrent-"));
  const statePath = path.join(root, "agents.json");
  let resolveCount = 0;
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        const current = ++resolveCount;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          thread: {
            id: `019f0000-0000-7000-8000-${String(current).padStart(12, "0")}`,
            title: payload.title,
            cwd: process.cwd()
          }
        };
      }
      if (payload.action === "read") return { thread: { active: true } };
      return {};
    }
  });

  await Promise.all([
    pool.deliver(group("parallel-one", { conversationKey: "napcat:group:one" }), "one"),
    pool.deliver(group("parallel-two", { conversationKey: "napcat:group:two" }), "two")
  ]);

  const workers = pool.snapshot().workers;
  assert.equal(workers.length, 2);
  assert.equal(new Set(workers.map((worker) => worker.threadId)).size, 2);
  assert.deepEqual(workers.map((worker) => worker.index), [1, 2]);
});

test("Message Agent pool renames existing workers to stable persona-owned titles without changing task ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-rename-"));
  const statePath = path.join(root, "agents.json");
  const rolePath = path.join(root, "persona.md");
  fs.writeFileSync(rolePath, "# 星海建造师 策划 程序\n\n人格正文。\n", "utf8");
  const workspace = process.cwd();
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-04T06:00:00.000Z",
    workers: [1, 2].map((index) => ({
      threadId: `019f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      threadName: `“星海建造师 策划 程序” 这个会话宕机了？ 消息处理 ${index}`,
      workspace,
      index,
      createdAt: "2026-08-04T06:00:00.000Z",
      initializedAt: "2026-08-04T06:00:00.000Z",
      affinities: index === 1 ? [{
        groupId: "known",
        endpoint: "napcat",
        conversationKey: "napcat:group:100",
        sender: "200",
        lastUsedAt: "2026-08-04T06:00:00.000Z"
      }] : []
    }))
  }), "utf8");
  const renameCalls: Array<Record<string, any>> = [];
  const pool = new MessageAgentPool({
    ...options(statePath),
    sourceThreadName: "“星海建造师 策划 程序” 这个会话宕机了？",
    roleDisplayName: undefined,
    rolePath
  }, {
    request: async (payload) => {
      if (payload.action === "rename") renameCalls.push(payload);
      if (payload.action === "read") return { thread: { active: false } };
      return {};
    }
  });

  await pool.deliver(group("known"), "继续处理");

  assert.deepEqual(renameCalls.map((call) => ({
    threadId: call.threadId,
    title: call.title,
    cwd: call.cwd
  })), [
    {
      threadId: "019f0000-0000-7000-8000-000000000001",
      title: "星海建造师 策划 程序 协助处理消息1",
      cwd: workspace
    },
    {
      threadId: "019f0000-0000-7000-8000-000000000002",
      title: "星海建造师 策划 程序 协助处理消息2",
      cwd: workspace
    }
  ]);
  assert.deepEqual(pool.snapshot().workers.map((worker) => ({
    threadId: worker.threadId,
    threadName: worker.threadName
  })), [
    {
      threadId: "019f0000-0000-7000-8000-000000000001",
      threadName: "星海建造师 策划 程序 协助处理消息1"
    },
    {
      threadId: "019f0000-0000-7000-8000-000000000002",
      threadName: "星海建造师 策划 程序 协助处理消息2"
    }
  ]);
});

test("Message Agent affinity has no short topic timeout and keeps a bounded preview for later continuation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-later-"));
  let created = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    now: () => new Date("2026-08-04T06:30:00.000Z"),
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: false } };
      return {};
    }
  });

  const earlier = group("earlier", {
    createdAt: Date.parse("2026-08-04T06:00:00.000Z"),
    items: [{ identity: "earlier-m1", receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { messageId: "m-old", rawMessage: "旧话题内容" }, extraValues: {} } }]
  });
  const first = await pool.deliver(earlier, "earlier");
  const later = await pool.deliver(group("later"), "later");

  assert.equal(later.threadId, first.threadId);
  assert.equal(created, 1);
  const affinity = pool.affinitySnapshot().workers[0]?.affinities.find((item) => item.groupId === "earlier");
  assert.equal(affinity?.preview, "旧话题内容");
  assert.deepEqual(affinity?.messageIds, ["m-old"]);
});

test("the exact same message group always supplements its original active worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-supplement-"));
  let created = 0;
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: true } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  await pool.deliver(group("same"), "first");
  await pool.deliver(group("same"), "supplement");
  assert.equal(created, 1);
  assert.equal(sent[0], sent[1]);
});

test("an explicit reply to an older source message returns to its original active Message Agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-explicit-reply-"));
  let created = 0;
  const pool = new MessageAgentPool(options(path.join(root, "agents.json")), {
    request: async (payload) => {
      if (payload.action === "resolve") {
        created += 1;
        return { thread: { id: `019f0000-0000-7000-8000-${String(created).padStart(12, "0")}`, title: payload.title, cwd: process.cwd() } };
      }
      if (payload.action === "read") return { thread: { active: true } };
      return {};
    }
  });

  const first = await pool.deliver(group("old", {
    items: [{ identity: "old-m1", receivedAt: 1, incomplete: false, payload: { routeKind: "group_message", record: { messageId: "source-old", rawMessage: "半小时前的消息" }, extraValues: {} } }]
  }), "old");
  const reply = await pool.deliver(group("new", {
    sender: "another-speaker",
    replyToMessageId: "source-old"
  }), "reply");

  assert.equal(reply.threadId, first.threadId);
  assert.equal(created, 1);
});

test("a reply to an Agent-sent message boosts that exact Message Agent session in the ranking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-agent-reply-sender-"));
  const statePath = path.join(root, "agents.json");
  const familiarThreadId = "019f0000-0000-7000-8000-000000000071";
  const referencedThreadId = "019f0000-0000-7000-8000-000000000072";
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-08-11T08:00:00.000Z",
    workers: [
      {
        threadId: familiarThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息1",
        workspace: process.cwd(),
        index: 1,
        createdAt: "2026-08-11T07:00:00.000Z",
        initializedAt: "2026-08-11T07:00:01.000Z",
        affinities: [{
          groupId: "familiar-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:100",
          sender: "200",
          lastUsedAt: "2026-08-11T07:30:00.000Z"
        }]
      },
      {
        threadId: referencedThreadId,
        threadName: "星海建造师 策划 程序 协助处理消息2",
        workspace: process.cwd(),
        index: 2,
        createdAt: "2026-08-11T07:05:00.000Z",
        initializedAt: "2026-08-11T07:05:01.000Z",
        affinities: [{
          groupId: "other-old",
          endpoint: "napcat",
          conversationKey: "napcat:group:999",
          sender: "999",
          lastUsedAt: "2026-08-11T07:20:00.000Z"
        }]
      }
    ]
  }), "utf8");
  const sent: string[] = [];
  const pool = new MessageAgentPool(options(statePath), {
    request: async (payload) => {
      if (payload.action === "read") return { thread: { status: { type: "idle" } } };
      if (payload.action === "send") sent.push(String(payload.threadId));
      return {};
    }
  });

  const selected = await pool.deliver(group("reply-to-agent", {
    replyToMessageId: "qq-outbound-7788"
  }), "reply to Agent", {
    referencedSenders: [{
      deliveryId: "delivery-7788",
      agentType: "message_processing",
      sessionId: referencedThreadId
    }]
  });

  assert.equal(selected.threadId, referencedThreadId);
  assert.deepEqual(sent, [referencedThreadId]);
});
