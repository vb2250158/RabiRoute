import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexDesktopBridge,
  codexDesktopDeepLinkForTest,
  listCodexDesktopThreadsFromRowsForTest
} from "./codexDesktopBridge.js";

type IpcRequest = {
  type?: string;
  requestId?: string;
  method?: string;
};

function testPipePath(name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.sock`);
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function createMockDesktopRouter(
  handler: (request: IpcRequest, methods: string[]) => Record<string, unknown>
): Promise<{ pipePath: string; methods: string[]; close: () => Promise<void> }> {
  const pipePath = testPipePath("rabiroute-codex-desktop");
  const methods: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (pending.length < 4 + length) return;
        const request = JSON.parse(pending.subarray(4, 4 + length).toString("utf8")) as IpcRequest;
        pending = pending.subarray(4 + length);
        if (request.method) methods.push(request.method);
        socket.write(encodeFrame(handler(request, methods)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  return {
    pipePath,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

test("Desktop thread discovery uses exact id while displaying title and latest time", () => {
  const result = listCodexDesktopThreadsFromRowsForTest([
    {
      id: "thread-old",
      title: "夜雨会话",
      cwd: "C:\\Work\\RabiRoute",
      rollout_path: "old.jsonl",
      updated_at_ms: 1_000,
      updated_at: 1,
      archived: 0
    },
    {
      id: "thread-new",
      title: "夜雨会话",
      cwd: "C:\\Work\\RabiRoute",
      rollout_path: "new.jsonl",
      first_user_message: "第一条消息",
      updated_at_ms: 2_000,
      updated_at: 2,
      archived: 0
    },
    {
      id: "thread-other",
      title: "其它项目",
      cwd: "D:\\Other",
      rollout_path: "other.jsonl",
      updated_at_ms: 3_000,
      updated_at: 3,
      archived: 0
    }
  ], { query: "夜雨", allowedWorkspaces: ["C:\\Work\\RabiRoute"], limit: 20 });

  assert.deepEqual(result.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt })), [
    { id: "thread-new", title: "夜雨会话", updatedAt: "1970-01-01T00:00:02.000Z" },
    { id: "thread-old", title: "夜雨会话", updatedAt: "1970-01-01T00:00:01.000Z" }
  ]);
  assert.equal(result[0]?.firstUserMessage, "第一条消息");
  assert.equal(result[1]?.firstUserMessage, "");
});

test("Desktop exact task metadata preserves archived state without listing archived tasks", () => {
  const rows = [{
    id: "019f0000-0000-7000-8000-000000000045",
    title: "已归档的固定任务",
    cwd: "C:\\Work\\RabiRoute",
    rollout_path: "archived.jsonl",
    updated_at_ms: 3_000,
    archived: 1
  }];

  assert.deepEqual(listCodexDesktopThreadsFromRowsForTest(rows, { limit: 10 }), []);
  const exact = listCodexDesktopThreadsFromRowsForTest(rows, { limit: 1, includeArchived: true })[0];
  assert.equal(exact.id, rows[0].id);
  assert.equal(exact.archived, true);
});

test("Desktop thread discovery supports pages beyond the first 100 tasks", () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: `thread-${index}`,
    title: `任务 ${index}`,
    cwd: "C:\\Work\\RabiRoute",
    rollout_path: `${index}.jsonl`,
    updated_at_ms: index + 1,
    archived: 0
  }));
  const page = listCodexDesktopThreadsFromRowsForTest(rows, { limit: 100, offset: 100 });

  assert.equal(page.length, 100);
  assert.equal(page[0]?.id, "thread-104");
  assert.equal(page[99]?.id, "thread-5");
});

test("Desktop bridge steers an active task instead of starting a concurrent turn", async () => {
  const router = await createMockDesktopRouter((request) => request.method === "initialize"
    ? { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } }
    : { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000050",
      prompt: "active task message",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "steered");
    assert.deepEqual(router.methods, ["initialize", "thread-follower-steer-turn"]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge starts a new turn when the task is idle", async () => {
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      return { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const bridge = new CodexDesktopBridge({ pipePaths: [router.pipePath] });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000051",
      prompt: "idle task message",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });

    assert.equal(result.action, "started");
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge loads an unowned task and delivers through the Desktop owner", async () => {
  let deliveryAttempt = 0;
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      deliveryAttempt += 1;
      return deliveryAttempt === 1
        ? { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" }
        : { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const opened: string[] = [];
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async (threadId) => { opened.push(threadId); }
  });

  try {
    const result = await bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000001",
      prompt: "RabiRoute Desktop IPC test",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.deepEqual(opened, ["019f0000-0000-7000-8000-000000000001"]);
    assert.equal(result.action, "started");
    assert.equal(result.openedThread, true);
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge retries a freshly created task until its rollout owner is ready", async () => {
  let deliveryAttempt = 0;
  const threadId = "019f0000-0000-7000-8000-000000000004";
  const router = await createMockDesktopRouter((request) => {
    if (request.method === "initialize") {
      return { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } };
    }
    if (request.method === "thread-follower-steer-turn") {
      deliveryAttempt += 1;
      return deliveryAttempt === 1
        ? { type: "response", requestId: request.requestId, resultType: "error", error: `no rollout found for thread id ${threadId}` }
        : { type: "response", requestId: request.requestId, resultType: "error", error: "no active turn to steer" };
    }
    return { type: "response", requestId: request.requestId, resultType: "success", method: request.method, result: {} };
  });
  const opened: string[] = [];
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async (openedThreadId) => { opened.push(openedThreadId); }
  });

  try {
    const result = await bridge.deliver({
      threadId,
      prompt: "fresh Desktop task",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    });
    assert.deepEqual(opened, [threadId]);
    assert.equal(result.action, "started");
    assert.equal(result.openedThread, true);
    assert.deepEqual(router.methods, [
      "initialize",
      "thread-follower-steer-turn",
      "thread-follower-steer-turn",
      "thread-follower-start-turn"
    ]);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop bridge fails closed when no Desktop owner loads the task", async () => {
  const router = await createMockDesktopRouter((request) => request.method === "initialize"
    ? { type: "response", requestId: request.requestId, resultType: "success", method: "initialize", result: { clientId: "rabi" } }
    : { type: "response", requestId: request.requestId, resultType: "error", error: "no-client-found" });
  let openCount = 0;
  const bridge = new CodexDesktopBridge({
    pipePaths: [router.pipePath],
    loadRetryAttempts: 2,
    loadRetryDelayMs: 1,
    openThread: async () => { openCount += 1; }
  });

  try {
    await assert.rejects(bridge.deliver({
      threadId: "019f0000-0000-7000-8000-000000000002",
      prompt: "must stay in Desktop",
      cwd: process.cwd(),
      sandbox: "workspace-write"
    }), /Desktop.*加载|no-client-found/i);
    assert.equal(openCount, 1);
    assert.equal(router.methods.filter((method) => method === "thread-follower-steer-turn").length, 2);
  } finally {
    bridge.close();
    await router.close();
  }
});

test("Desktop task deep link keeps the opaque thread id intact", () => {
  assert.equal(
    codexDesktopDeepLinkForTest("019f0000-0000-7000-8000-000000000003"),
    "codex://threads/019f0000-0000-7000-8000-000000000003"
  );
});
