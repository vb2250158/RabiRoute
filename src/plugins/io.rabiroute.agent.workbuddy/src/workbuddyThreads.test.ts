import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { normalizeWorkbuddyWorkspace, workbuddyProjectId } from "./workbuddySessionStore.js";
import { readWorkbuddyHistory, workbuddyRecordConfirmsDelivery } from "./workbuddyHistory.js";
import { requestWorkbuddyDesktopCreation, serveWorkbuddyDesktopRelay } from "./workbuddyDesktopRelay.js";
import { legacyWorkbuddyDesktopLayout, type WorkbuddyDesktopLayout } from "./workbuddyDesktopLayout.js";
import { createManager } from "./agentAdapters/workbuddyManagerProvider.js";
import type { AgentManagerImplementationOptions } from "../../../manager/agentManagerHostPorts.js";
import { handleAgentThreadRequest } from "../../../agentThreads.js";
import type { AgentManagerOperationInvoker } from "../../../agentAdapters/managerInvocation.js";
import {
  agentAdapterManifest,
  agentThreadCapableAgentTypes,
  isAgentThreadCapableAdapter
} from "../../../shared/agentAdapterCapabilities.js";
import {
  listWorkbuddyThreads,
  readWorkbuddyThread,
  sendWorkbuddyThreadMessage
} from "./workbuddyThreads.js";

const PASSWORD = randomBytes(32).toString("hex");

test("unbound WorkBuddy history uses exact tasks, bounded cursors and complete native records", async t => {
  const root = createHome([{ id: "11111111-1111-4111-8111-111111111111", cwd: "C:/work/one", title: "原任务" }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "projects", "c-work-one");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "11111111-1111-4111-8111-111111111111.jsonl");
  const deliveryId = "workbuddy-local-intent-1";
  const envelope = `## 消息源\n- 投递 ID：${deliveryId}\n\n## 消息内容\n中文问题`;
  const user = { type: "message", role: "user", sessionId: "11111111-1111-4111-8111-111111111111", content: [{ type: "input_text", text: envelope }] };
  const answer = { type: "message", role: "assistant", sessionId: "11111111-1111-4111-8111-111111111111", content: [{ type: "output_text", text: envelope }] };
  const rows = [JSON.stringify(user), "broken row", JSON.stringify(answer)];
  fs.writeFileSync(file, rows.join("\r\n") + "\r\n" + '{"type":');
  await withHome(root, async () => {
    const first = await readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { limit: 2 });
    assert.deepEqual(first.entries, [{ sequence: 1, record: user }]);
    assert.equal(first.warnings[0]?.errorCode, "WORKBUDDY_HISTORY_ROW_INVALID");
    assert.ok(first.nextCursor);
    const manager = createManager({ host: { packageRoot: root } } as AgentManagerImplementationOptions, {
      type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest: agentAdapterManifest("workbuddy"),
      sessionBinding: { sessionId: "workbuddySessionId", sessionName: "workbuddySessionName", workspace: "workbuddyCwd", defaultName: "WorkBuddy" }
    }, new AbortController().signal);
    const options = {
      allowedWorkspaces: [],
      invokeAgentOperation: async <T>(type: string, operation: string, payload: unknown, invocation?: import("@rabiroute/plugin-sdk").AgentAdapterInvocation) => {
        assert.equal(type, "workbuddy");
        return await manager.operations[operation]!(payload, invocation) as T;
      }
    };
    const request = { action: "read", agentAdapter: "workbuddy", threadId: user.sessionId, deliveryId } as const;
    const response = await handleAgentThreadRequest({ ...request, history: { limit: 2 } }, options);
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.data.history as typeof first).entries, first.entries);
    assert.deepEqual(response.data.delivery, {
      deliveryId, state: "accepted", source: "workbuddy-native-transcript", retryable: false, sequence: 1
    });
    const receipt = { deliveryId, generation: "gen", target: { provider: "workbuddy", sessionId: user.sessionId },
      promptHash: "prompt", executionOptionsHash: "execution", executionOptions: { cwd: "C:/work/one" } };
    const recover = manager.operations["endpoint.recover"]!;
    const readReceipt = (input: typeof receipt) => recover({}, { nativeArgs: [input, () => undefined] });
    const recovered = await readReceipt(receipt) as { deliveryId: string; action: string; transport: string };
    assert.equal(recovered.deliveryId, deliveryId);
    assert.equal(recovered.action, "started");
    assert.equal(recovered.transport, "workbuddy_native_history");
    assert.equal(await readReceipt({ ...receipt, executionOptions: { ...receipt.executionOptions, workbuddyDeliveryMode: "steer" } } as typeof receipt), undefined);
    const quoted = await handleAgentThreadRequest({ ...request, history: { cursor: first.nextCursor!, limit: 2 } }, options);
    assert.deepEqual(quoted.data.delivery, {
      deliveryId, state: "not_observed", source: "workbuddy-native-transcript", retryable: false, nextCursor: null
    });
    const summary = await handleAgentThreadRequest(request, options);
    assert.equal((summary.data.thread as { id: string }).id, user.sessionId);
    assert.deepEqual(summary.data.delivery, response.data.delivery);
    const budget = await readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { maxBytes: Buffer.byteLength(rows[0]! + "\r\n") });
    assert.ok(budget.nextCursor);
    assert.equal(budget.coverage.pendingTail, false);
    const second = await readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { cursor: first.nextCursor!, limit: 2 });
    assert.deepEqual(second.entries, [{ sequence: 3, record: answer }]);
    assert.equal(second.coverage.pendingTail, true);
    assert.equal(second.nextCursor, null);
    fs.appendFileSync(file, '"message","role":"user","content":[]}\n');
    const appended = await readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { cursor: second.resumeCursor });
    assert.equal(appended.entries.length, 1);
    assert.equal(appended.coverage.pendingTail, false);
    assert.equal(appended.nextCursor, null);
    await assert.rejects(readWorkbuddyHistory("missing"), /was not found/);
    await assert.rejects(readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { cursor: "bad" }), /游标/);
    await assert.rejects(readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { limit: 0 }), /分页参数/);
    await assert.rejects(readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { maxBytes: 5 }), /预算/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { signal: aborted.signal }), /abort/i);
    fs.writeFileSync(file, "{}\n");
    await assert.rejects(readWorkbuddyHistory("11111111-1111-4111-8111-111111111111", { cursor: first.nextCursor! }), /来源已变化/);
    const oldRow = JSON.stringify({ type: "message", role: "assistant", content: "x".repeat(1024) });
    fs.writeFileSync(file, (oldRow + "\n").repeat(2200) + JSON.stringify(user) + "\n" + JSON.stringify(user));
    const afterLongHistory = await readReceipt(receipt) as { deliveryId: string; transport: string };
    assert.equal(afterLongHistory.deliveryId, deliveryId);
    assert.equal(afterLongHistory.transport, "workbuddy_native_history");
  });
});

test("the provider recovers steer only from the exact native injection record", async t => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const cwd = "C:/work/one";
  const root = createHome([{ id: threadId, cwd, title: "Task" }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "projects", workbuddyProjectId(cwd));
  const manifest = JSON.parse(fs.readFileSync(new URL("../agent-adapter.json", import.meta.url), "utf8")).manifest;
  const delivery = {
    deliveryId: "original-guide", generation: "original-generation",
    target: { provider: "workbuddy", sessionId: threadId },
    promptHash: "original-prompt-hash", executionOptionsHash: "original-options-hash",
    executionOptions: { workbuddyDeliveryMode: "steer" }
  };
  const user = {
    type: "message", role: "user", sessionId: threadId,
    content: "## 消息源\n- 投递 ID：original-guide\n\n## 消息内容\n原引导",
    providerData: { startsNewUserRequest: true, rootRequestId: "turn-A", conversationRequestId: "turn-A" }
  };
  const file = path.join(directory, threadId + ".jsonl");
  await withHome(root, async () => {
    const manager = createManager({ host: { packageRoot: root } } as AgentManagerImplementationOptions, {
      type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest, sessionBinding: {}
    }, new AbortController().signal);
    const probe = () => manager.operations["endpoint.recover"]!({}, { nativeArgs: [delivery, () => undefined] });
    assert.equal(await probe(), undefined);
    fs.mkdirSync(directory, { recursive: true });
    assert.equal(await probe(), undefined);
    fs.writeFileSync(file, JSON.stringify(user) + "\n");
    assert.equal(await probe(), undefined);
    fs.appendFileSync(file, JSON.stringify({
      ...user, providerData: { ...user.providerData, startsNewUserRequest: false }
    }) + "\n");
    assert.deepEqual(await probe(), {
      deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      accepted: true, transport: "workbuddy_native_history", action: "steered"
    });
  });
});

test("native queued content confirms only exact same-turn WorkBuddy guidance", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const deliveryId = "agent-" + "a".repeat(64);
  const prompt = '## 消息源\n- 类型：用户\n\n## 消息内容\n原引导\n\n[回传参数]\n'
    + JSON.stringify({ deliveryId, responsePolicy: "none" });
  const providerData = {
    startsNewUserRequest: false, rootRequestId: "original-turn", conversationRequestId: "original-turn",
    clientMeta: { "codebuddy.ai": { queueOrigin: "steer", contentBlocks: [{ type: "text", text: prompt }] } }
  };
  const record = { type: "message", role: "user", sessionId: threadId, content: "Native context prefix\n" + prompt, providerData };
  assert.equal(workbuddyRecordConfirmsDelivery(record, threadId, deliveryId), true);
  assert.equal(workbuddyRecordConfirmsDelivery(record, threadId, deliveryId, true), true);
  assert.equal(workbuddyRecordConfirmsDelivery(record, "other-task", deliveryId, true), false);
  assert.equal(workbuddyRecordConfirmsDelivery(record, threadId, "agent-" + "b".repeat(64), true), false);
  assert.equal(workbuddyRecordConfirmsDelivery({ ...record, providerData: { ...providerData, startsNewUserRequest: true } },
    threadId, deliveryId, true), false);
  assert.equal(workbuddyRecordConfirmsDelivery({ ...record, providerData: {
    ...providerData, clientMeta: { "codebuddy.ai": { ...providerData.clientMeta["codebuddy.ai"], queueOrigin: "queued" } }
  } }, threadId, deliveryId), false);
});

test("recovers an exact delivery from WorkBuddy's single wrapped native user query", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const deliveryId = "agent-" + "a".repeat(64);
  const differentId = "agent-" + "b".repeat(64);
  const envelope = (id: string, body = "验收原消息") => `## 消息源\n- 类型：用户\n\n## 消息内容\n${body}\n\n[回传参数]\n`
    + JSON.stringify({ deliveryId: id, responsePolicy: "none" }, null, 2);
  const context = '<system-reminder data-role="user-context">\n<workspace>\nproject\n</workspace>\n</system-reminder>\n';
  const additional = '<system-reminder data-role="additional-data">\n<current_time>\nfixture\n</current_time>\n</system-reminder>\n';
  const wrap = (query: string) => context + additional + `<user_query>${query}</user_query>`;
  const recordFor = (text: string) => ({ type: "message", role: "user", sessionId: threadId,
    content: [{ type: "input_text", text }], providerData: { startsNewUserRequest: true, conversationRequestId: "native-turn" } });
  const record = recordFor(wrap(envelope(deliveryId)));
  const confirms = (candidate: unknown) => workbuddyRecordConfirmsDelivery(candidate, threadId, deliveryId);

  assert.equal(confirms(record), true);
  assert.equal(confirms(recordFor(wrap(envelope(deliveryId)).replaceAll("\n", "\r\n"))), true);
  assert.equal(confirms(recordFor(envelope(deliveryId))), true);
  assert.equal(confirms(recordFor(wrap(envelope(differentId, `引用旧投递 ${deliveryId}`)))), false);
  assert.equal(confirms({ ...record, sessionId: "another-task" }), false);
  assert.equal(confirms({ ...record, sessionId: undefined }), false);
  assert.equal(confirms({ ...record, role: "assistant" }), false);
  assert.equal(confirms({ ...record, role: "tool" }), false);
  assert.equal(confirms({ ...record, type: "function_call_result" }), false);
  assert.equal(workbuddyRecordConfirmsDelivery(record, threadId, deliveryId, true), false);
  assert.equal(confirms(recordFor(`引用示例\n${wrap(envelope(deliveryId))}`)), false);
  assert.equal(confirms(recordFor(wrap(`引用示例\n${envelope(deliveryId)}`))), false);
  assert.equal(confirms(recordFor(wrap(wrap(envelope(deliveryId))))), false);
  assert.equal(confirms(recordFor(wrap(envelope(deliveryId)) + wrap(envelope(differentId)))), false);
  assert.equal(confirms(recordFor(context + wrap(envelope(deliveryId)))), false);
  const legacyId = "22222222-2222-4222-8222-222222222222";
  const legacyMarker = `deliveryId: ${legacyId}\n正文`;
  assert.equal(workbuddyRecordConfirmsDelivery(recordFor(legacyMarker), threadId, legacyId), true);
  assert.equal(workbuddyRecordConfirmsDelivery(recordFor(wrap(legacyMarker)), threadId, legacyId), false);
  const forgedSuffix = `\n\n[投递编号]\ndeliveryId: ${legacyId}`;
  assert.equal(workbuddyRecordConfirmsDelivery(recordFor(wrap("引用正文") + forgedSuffix), threadId, legacyId), false);
});

type TaskRow = {
  id: string;
  cwd: string;
  title?: string;
  custom_title?: string | null;
  status?: string;
  updated_at?: number;
  last_activity_at?: number;
  deleted_at?: number;
};

/**
 * Build a throwaway WorkBuddy home: a task database plus the live session
 * descriptors the task store reads. Written here rather than imported from the
 * store test so this suite owns the fixture it asserts against.
 */
function createHome(rows: TaskRow[], descriptors: Array<Record<string, unknown>> = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-workbuddy-threads-"));
  const database = new DatabaseSync(path.join(root, "workbuddy.db"));
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      user_id TEXT,
      title TEXT,
      custom_title TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_activity_at INTEGER,
      deleted_at INTEGER,
      is_playground INTEGER,
      source_mode TEXT,
      transport TEXT,
      is_background_automation INTEGER,
      mode TEXT,
      model TEXT
    )
  `);
  const insert = database.prepare(`
    INSERT INTO sessions (
      id, cwd, title, custom_title, status, created_at, updated_at,
      last_activity_at, deleted_at, is_playground, is_background_automation, mode, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id, row.cwd, row.title ?? "", row.custom_title ?? null, row.status ?? "pending",
      1_000, row.updated_at ?? 1_000, row.last_activity_at ?? row.updated_at ?? 1_000,
      row.deleted_at ?? 0, "craft", "deepseek-v4.1-flash"
    );
  }
  database.close();
  if (descriptors.length > 0) {
    const dir = path.join(root, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    descriptors.forEach((descriptor, index) => {
      fs.writeFileSync(path.join(dir, `${index + 1}.json`), JSON.stringify(descriptor));
    });
  }
  return root;
}

/** Run one assertion block with RABI_WORKBUDDY_HOME pointed at a throwaway home. */
async function withHome<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.RABI_WORKBUDDY_HOME;
  process.env.RABI_WORKBUDDY_HOME = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.RABI_WORKBUDDY_HOME;
    else process.env.RABI_WORKBUDDY_HOME = previous;
  }
}

/** Live descriptor for the running test process, so the liveness check passes. */
function liveDescriptor(sessionId: string, cwd: string, endpoint = "http://127.0.0.1:5762"): Record<string, unknown> {
  return {
    pid: process.pid,
    lastHeartbeat: Date.now(),
    sessionId,
    cwd,
    kind: "interactive",
    endpoint,
    mode: "local"
  };
}

test("workbuddy joins the thread bridge without claiming plan or consolidation features", () => {
  assert.equal(isAgentThreadCapableAdapter("workbuddy"), true);
  for (const adapter of ["codex", "dsh", "antigravity", "workbuddy"]) {
    assert.ok(
      (agentThreadCapableAgentTypes as readonly string[]).includes(adapter),
      `expected ${adapter} to be thread-capable`
    );
  }
  // An adapter that only hands the turn to a foreign runtime must not become a
  // Plan holder or a consolidation host by gaining thread support.
  assert.equal(isAgentThreadCapableAdapter("marvis"), false);
  assert.equal(isAgentThreadCapableAdapter("astrbot"), false);
  assert.equal(isAgentThreadCapableAdapter("copilotCli"), false);
});

test("listing WorkBuddy threads reads tasks and honors the workspace filter", async () => {
  const root = createHome([
    { id: "t1", cwd: "C:\\work\\one", custom_title: "任务一", updated_at: 5_000 },
    { id: "t2", cwd: "C:\\work\\two", title: "自动标题", updated_at: 3_000 },
    { id: "t3", cwd: "C:\\work\\one", title: "已删除", deleted_at: 9_000 }
  ]);

  await withHome(root, () => {
    const all = listWorkbuddyThreads({ query: "", limit: 50, offset: 0, allowedWorkspaces: [] });
    assert.deepEqual(all.map(thread => thread.id).sort(), ["t1", "t2"]);
    const scoped = listWorkbuddyThreads({ query: "", limit: 50, offset: 0, allowedWorkspaces: ["c:/work/two/"] });
    assert.deepEqual(scoped.map(thread => thread.id), ["t2"]);
    const named = listWorkbuddyThreads({ query: "任务", limit: 50, offset: 0, allowedWorkspaces: [] });
    assert.deepEqual(named.map(thread => thread.title), ["任务一"]);
  });
});

test("workspace filtering precedes bridge pagination across interleaved tasks", async (t) => {
  const root = createHome([
    { id: "outside-new", cwd: "C:\\work\\outside", title: "same", updated_at: 9_000 },
    { id: "one-new", cwd: "C:\\work\\one", title: "same", updated_at: 8_000 },
    { id: "outside-middle", cwd: "C:\\work\\outside", title: "same", updated_at: 7_000 },
    { id: "two-new", cwd: "C:\\work\\two", title: "same", updated_at: 6_000 },
    { id: "one-old", cwd: "C:\\work\\one", title: "same", updated_at: 5_000 },
    { id: "two-old", cwd: "C:\\work\\two", title: "same", updated_at: 4_000 }
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withHome(root, () => {
    const request = { query: "same", limit: 2, offset: 0, allowedWorkspaces: ["c:/work/one/", "C:\\WORK\\TWO"] };
    assert.deepEqual(listWorkbuddyThreads(request).map(thread => thread.id), ["one-new", "two-new"]);
    assert.deepEqual(listWorkbuddyThreads({ ...request, offset: 2 }).map(thread => thread.id), ["one-old", "two-old"]);
    assert.deepEqual(listWorkbuddyThreads({ ...request, offset: 4 }), []);
    assert.deepEqual(listWorkbuddyThreads({ ...request, allowedWorkspaces: ["C:\\work\\missing"] }), []);
    assert.deepEqual(listWorkbuddyThreads({ ...request, allowedWorkspaces: ["C:\\work\\one"], offset: 1 }).map(thread => thread.id), ["one-old"]);
  });
});

test("public thread bridge returns scoped WorkBuddy pages without a fallback driver", async (t) => {
  const root = createHome([
    { id: "outside", cwd: "C:\\work\\outside", title: "same", updated_at: 9_000 },
    { id: "allowed-new", cwd: "C:\\work\\one", title: "same", updated_at: 8_000 },
    { id: "outside-middle", cwd: "C:\\work\\outside", title: "same", updated_at: 7_000 },
    { id: "allowed-old", cwd: "C:\\work\\one", title: "same", updated_at: 6_000 }
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withHome(root, async () => {
    const { operations } = createManager({ host: { packageRoot: root } } as AgentManagerImplementationOptions, {
      type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest: agentAdapterManifest("workbuddy"), sessionBinding: {}
    }, new AbortController().signal);
    const invokeAgentOperation: AgentManagerOperationInvoker = async <T>(
      type: string, operation: string, payload: unknown,
      invocation?: import("@rabiroute/plugin-sdk").AgentAdapterInvocation
    ) => {
      assert.equal(type, "workbuddy", "The request must stay with its original WorkBuddy owner.");
      const handler = operations[operation];
      assert.ok(handler, `Unexpected native operation: ${operation}`);
      return await handler(payload, invocation) as T;
    };
    const request = { action: "list", agentAdapter: "workbuddy", limit: 1 } as const;
    const options = { invokeAgentOperation, allowedWorkspaces: ["C:\\work\\one"] };
    const first = await handleAgentThreadRequest(request, options);
    assert.equal(first.statusCode, 200);
    assert.deepEqual((first.data.threads as Array<{ id: string }>).map(thread => thread.id), ["allowed-new"]);
    assert.equal(first.data.nextOffset, 1);
    const second = await handleAgentThreadRequest({ ...request, offset: 1 }, options);
    assert.deepEqual((second.data.threads as Array<{ id: string }>).map(thread => thread.id), ["allowed-old"]);
    assert.equal(second.data.nextOffset, null);
    await assert.rejects(handleAgentThreadRequest({ action: "create", agentAdapter: "workbuddy", title: "not-created" }, options), /requires an explicit first message/);
    await assert.rejects(handleAgentThreadRequest({ action: "rename", agentAdapter: "workbuddy", threadId: "allowed-old", title: "not-renamed" }, options), /Rename the task in the workbuddy application/);
    await assert.rejects(handleAgentThreadRequest({ action: "resolve", agentAdapter: "workbuddy", title: "not-created" }, options), /complete workbuddy task ID/);
  });
});

test("WorkBuddy public create dispatches an exact workspace and stable intent through its local desktop relay", { skip: process.platform !== "win32" }, async t => {
  const root = createHome([]);
  const workspace = path.join(root, "one");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withHome(root, async () => {
    const calls: string[] = [];
    const stop = await serveWorkbuddyDesktopRelay(async input => {
      assert.equal(input.workspaceLabel, "one");
      assert.equal(input.workspace, workspace);
      assert.equal(input.title, "Requested title");
      calls.push(input.prompt);
      return { state: "created", intentId: input.intentId, sequence: 3, thread: { id: "native-id", title: "Actual title", cwd: input.workspace } };
    }, path.join(root, "rabiroute-desktop-relay.json"));
    try {
      const manager = createManager({ host: { readOnly: () => false, packageRoot: root } } as AgentManagerImplementationOptions, {
        type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest: agentAdapterManifest("workbuddy"),
        sessionBinding: { sessionId: "workbuddySessionId", sessionName: "workbuddySessionName", workspace: "workbuddyCwd", defaultName: "WorkBuddy" }
      }, new AbortController().signal);
      const options = {
        allowedWorkspaces: [workspace],
        invokeAgentOperation: async <T>(type: string, operation: string, payload: unknown, invocation?: import("@rabiroute/plugin-sdk").AgentAdapterInvocation) => {
          assert.equal(type, "workbuddy");
          assert.equal(operation, "threads.create");
          return await manager.operations[operation]!(payload, invocation) as T;
        }
      };
      const request = { action: "create", agentAdapter: "workbuddy", title: "Requested title", cwd: workspace,
        deliveryId: "ordinary-create-intent", prompt: "第一行\n第二行" } as const;
      const first = await handleAgentThreadRequest(request, options);
      const second = await handleAgentThreadRequest(request, options);
      assert.equal(first.statusCode, 201);
      assert.deepEqual(second.data, first.data);
      assert.deepEqual(first.data.thread, { id: "native-id", title: "Actual title", cwd: request.cwd });
      assert.equal(first.data.intentId, request.deliveryId);
      assert.equal(calls.length, 2);
      assert.equal(calls[0], calls[1]);
    } finally { await stop(); }
  });
});

test("the same WorkBuddy relay accepts revised layouts while a legacy descriptor only admits the default", { skip: process.platform !== "win32" }, async t => {
  const root = createHome([]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "rabiroute-desktop-relay.json");
  const original = { intentId: "original", title: "A title", workspace: root, workspaceLabel: "Project", prompt: "First prompt" };
  const revised = { ...legacyWorkbuddyDesktopLayout, sendButtonClass: "new-send-button" };
  const calls: Array<{ intentId: string; layout?: WorkbuddyDesktopLayout }> = [];
  const stop = await serveWorkbuddyDesktopRelay(async ({ intentId, layout }) => {
    calls.push({ intentId, layout });
    return { state: "pending", intentId };
  }, descriptor);
  try {
    await requestWorkbuddyDesktopCreation({ ...original, layout: legacyWorkbuddyDesktopLayout }, undefined, descriptor);
    await requestWorkbuddyDesktopCreation({ ...original, intentId: "revised", layout: revised }, undefined, descriptor);
    await assert.rejects(requestWorkbuddyDesktopCreation({ ...original, layout: { ...revised, sendButtonClass: "button.other" } }, undefined, descriptor), /布局无效/);
    assert.deepEqual(calls, [{ intentId: "original", layout: legacyWorkbuddyDesktopLayout }, { intentId: "revised", layout: revised }]);

    const { pipe, token } = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    fs.writeFileSync(descriptor, JSON.stringify({ pipe, token }));
    await assert.rejects(requestWorkbuddyDesktopCreation({ ...original, intentId: "legacy-revised", layout: revised }, undefined, descriptor), /不支持所选布局/);
    await requestWorkbuddyDesktopCreation({ ...original, intentId: "legacy-default", layout: legacyWorkbuddyDesktopLayout }, undefined, descriptor);
    assert.deepEqual(calls.at(-1), { intentId: "legacy-default", layout: undefined });
    assert.equal(calls.length, 3);
  } finally { await stop(); }
});

test("WorkBuddy reconciles an original creation while its desktop relay is offline", async t => {
  const root = createHome([]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "Project");
  const normalized = normalizeWorkbuddyWorkspace(workspace);
  const payload = { intentId: "original-desktop-create", workspace, title: "Requested title", prompt: "First prompt" };
  const id = "11111111-1111-4111-8111-111111111111";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const marker = `RABI_WB_CREATE_${hash(payload.intentId)}`;
  const journal = path.join(root, "rabiroute-desktop-intents");
  fs.mkdirSync(journal);
  fs.writeFileSync(path.join(journal, `${hash(payload.intentId)}.json`), JSON.stringify({
    workspace: normalized, marker, existingIds: [],
    digest: hash(JSON.stringify([normalized, "Project", payload.title, payload.prompt]))
  }));
  await withHome(root, async () => {
    const retiring = new AbortController();
    const manager = createManager({
      scannerEntry: path.join(root, "workers", "scan.mjs"), host: { readOnly: () => false, packageRoot: root }
    } as AgentManagerImplementationOptions, {
      type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest: agentAdapterManifest("workbuddy"), sessionBinding: {}
    }, retiring.signal);
    const create = manager.operations["threads.create"]!;
    assert.deepEqual(await create(payload), { state: "pending", intentId: payload.intentId });
    assert.deepEqual(await create({ ...payload, prompt: "Different" }), { state: "conflict", intentId: payload.intentId });
    const database = new DatabaseSync(path.join(root, "workbuddy.db"));
    database.prepare("INSERT INTO sessions (id, cwd, title, source_mode, transport) VALUES (?, ?, ?, 'craft', 'local')").run(id, workspace, "Native title");
    database.close();
    const projects = path.join(root, "projects", workbuddyProjectId(workspace));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), JSON.stringify({ type: "message", role: "user", content: `First prompt\n\n[WorkBuddy 创建编号] ${marker}` }) + "\n");
    const admitted = create(payload);
    retiring.abort();
    assert.deepEqual(await admitted, { state: "created", intentId: payload.intentId, sequence: 1, thread: { id, title: "Native title", cwd: workspace } });
    await assert.rejects(async () => create({ ...payload, intentId: "first-time-create" }), /桌面创建尚未连接|需要 Windows 登录会话/);
  });
});

test("reading one WorkBuddy thread exposes the live session and fails on an unknown id", async () => {
  const root = createHome(
    [{ id: "t1", cwd: "C:\\work\\one", custom_title: "任务一" }],
    [liveDescriptor("t1", "C:\\work\\one")]
  );

  await withHome(root, () => {
    const thread = readWorkbuddyThread("t1") as Record<string, unknown>;
    assert.equal(thread.id, "t1");
    assert.equal(thread.title, "任务一");
    assert.equal(thread.cwd, "C:\\work\\one");
    assert.equal(typeof thread.updatedAt, "string");
    assert.deepEqual(thread.live, { pid: process.pid, endpoint: "http://127.0.0.1:5762", stale: false });
    assert.throws(() => readWorkbuddyThread("missing"), /was not found/);
  });
});

test("delivery fails closed without a live session process or on a workspace mismatch", async () => {
  const root = createHome([{ id: "t1", cwd: "C:\\work\\one", custom_title: "任务一" }]);

  await withHome(root, async () => {
    await assert.rejects(
      () => sendWorkbuddyThreadMessage({ threadId: "t1", prompt: "hi", cwd: "C:\\work\\one" }),
      /没有存活的会话进程/
    );
    await assert.rejects(
      () => sendWorkbuddyThreadMessage({ threadId: "missing", prompt: "hi", cwd: "C:\\work\\one" }),
      /was not found/
    );
  });

  const live = createHome(
    [{ id: "t1", cwd: "C:\\work\\one", custom_title: "任务一" }],
    [liveDescriptor("t1", "C:\\work\\one")]
  );
  await withHome(live, async () => {
    await assert.rejects(
      () => sendWorkbuddyThreadMessage({ threadId: "t1", prompt: "hi", cwd: "C:\\work\\other" }),
      /runs in C:\\work\\one/
    );
  });
});

test("delivery posts to the live session gateway and reports the http receipt", async () => {
  const root = createHome(
    [{ id: "t1", cwd: "C:\\work\\one", custom_title: "任务一" }],
    [liveDescriptor("t1", "C:\\work\\one")]
  );
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  const calls: Array<{ url: string; body: unknown }> = [];
  const responses = [
    { status: 200, body: { data: { delivered: true } } },
    { status: 500, body: {} }
  ];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (index === 3) throw new TypeError("Fixture gateway is closed", { cause: { code: "ECONNREFUSED" } });
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    await withHome(root, async () => {
      const receipt = await sendWorkbuddyThreadMessage({ threadId: "t1", prompt: "请处理这条缺陷", cwd: "C:\\work\\one" });
      assert.deepEqual(receipt, {
        threadId: "t1",
        action: "started",
        openedThread: false,
        transport: "http",
        warning: "WorkBuddy 原任务已接收，可能仍在排队；未确认执行开始、回答完成或桌面即时显示。"
      });
      await assert.rejects(sendWorkbuddyThreadMessage({ threadId: "t1", prompt: "original body", cwd: "C:\\work\\one",
        continueUnloaded: async () => assert.fail("uncertain live HTTP delivery must not use the desktop") }), /投递结果待确认/);
      const closed = await sendWorkbuddyThreadMessage({ threadId: "t1", prompt: "one body", cwd: "C:\\work\\one",
        continueUnloaded: async task => { assert.equal(task.id, "t1"); } });
      assert.equal(closed.transport, "desktop-ipc");
    });
    assert.equal(calls[0]?.url, "http://127.0.0.1:5762/api/v1/sessions/t1/reply");
    const delivery = calls[0]?.body as { text?: string } | undefined;
    assert.equal(delivery?.text, "请处理这条缺陷");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
    else process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = originalPassword;
  }
});

test("unloaded continuation can use only the original ordinary desktop task", async t => {
  const cwd = "C:\\work\\one";
  const root = createHome([
    { id: "wanted", cwd, title: "same title" },
    { id: "another", cwd, title: "same title" },
    { id: "archived", cwd, title: "same title", deleted_at: 1 }
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dispatched: string[] = [];
  await withHome(root, async () => {
    const base = { cwd, prompt: "original body", continueUnloaded: async (task: { id: string }) => { dispatched.push(task.id); } };
    const receipt = await sendWorkbuddyThreadMessage({ ...base, threadId: "wanted" });
    assert.equal(receipt.threadId, "wanted");
    assert.equal(receipt.transport, "desktop-ipc");
    await assert.rejects(sendWorkbuddyThreadMessage({ ...base, threadId: "archived" }), /已归档/);
    await assert.rejects(sendWorkbuddyThreadMessage({ ...base, threadId: "wanted", cwd: "C:\\work\\other" }), /cannot accept/);
    assert.deepEqual(dispatched, ["wanted"]);
  });
});

test("a scheduled run without an owner explains how to follow up without launching a desktop", async t => {
  const root = createHome([]);
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const database = new DatabaseSync(path.join(root, "workbuddy.db"));
  database.prepare("INSERT INTO sessions (id, cwd, title, status, is_background_automation) VALUES (?, ?, ?, ?, 1)")
    .run("scheduled", cwd, "Scheduled test", "completed");
  database.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withHome(root, async () => {
    const send = () => sendWorkbuddyThreadMessage({ threadId: "scheduled", cwd, prompt: "Follow up",
      continueUnloaded: async () => assert.fail("a scheduled run must never start an ordinary desktop chat") });
    await assert.rejects(send, /定时任务.*普通 WorkBuddy 聊天/);
  });
});

test("the Manager continues an unloaded original chat through the typed desktop relay", { skip: process.platform !== "win32" }, async t => {
  const root = createHome([]);
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const database = new DatabaseSync(path.join(root, "workbuddy.db"));
  database.prepare("INSERT INTO sessions (id, cwd, title) VALUES (?, ?, ?)").run("ordinary", cwd, "Original desktop chat");
  database.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withHome(root, async () => {
    let submissions = 0;
    const stop = await serveWorkbuddyDesktopRelay(() => assert.fail("continuation must never create"), path.join(root, "rabiroute-desktop-relay.json"),
      async (input, _signal, mode) => {
        assert.equal(mode, "continue");
        assert.deepEqual(input, { threadId: "ordinary", workspace: cwd, deliveryId: "original-send", text: "Resumed message" });
        submissions++;
        return { state: "accepted", threadId: input.threadId, deliveryId: input.deliveryId };
      });
    try {
      const manager = createManager({ host: { packageRoot: root } } as AgentManagerImplementationOptions, {
        type: "workbuddy", capability: "agent.adapter.workbuddy@1", manifest: agentAdapterManifest("workbuddy"), sessionBinding: {}
      }, new AbortController().signal);
      let authority = 0;
      const deliver = () => manager.operations["endpoint.execute"]!({}, { nativeArgs: [
        { deliveryId: "original-send", prompt: "Resumed message", target: { provider: "workbuddy", sessionId: "ordinary" }, executionOptions: { cwd } },
        {}, () => { authority++; }
      ] });
      const receipt = await deliver() as { threadId: string; transport: string };
      assert.equal(receipt.threadId, "ordinary");
      assert.equal(receipt.transport, "desktop-ipc");
      assert.equal(submissions, 1);
      assert.ok(authority >= 3);
    } finally { await stop(); }
  });
});
