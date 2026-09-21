import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { handleAgentThreadRequest } from "./agentThreads.js";
import {
  agentThreadCapableAgentTypes,
  isAgentThreadCapableAdapter
} from "./shared/agentAdapterCapabilities.js";
import {
  listWorkbuddyThreads,
  readWorkbuddyThread,
  sendWorkbuddyThreadMessage
} from "./workbuddyThreads.js";

const PASSWORD = randomBytes(32).toString("hex");

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
    const request = { action: "list", agentAdapter: "workbuddy", limit: 1 } as const;
    const options = { allowedWorkspaces: ["C:\\work\\one"] };
    const first = await handleAgentThreadRequest(request, options);
    assert.equal(first.statusCode, 200);
    assert.deepEqual((first.data.threads as Array<{ id: string }>).map(thread => thread.id), ["allowed-new"]);
    assert.equal(first.data.nextOffset, 1);
    const second = await handleAgentThreadRequest({ ...request, offset: 1 }, options);
    assert.deepEqual((second.data.threads as Array<{ id: string }>).map(thread => thread.id), ["allowed-old"]);
    assert.equal(second.data.nextOffset, null);
    await assert.rejects(handleAgentThreadRequest({ action: "create", agentAdapter: "workbuddy", title: "not-created" }, options), /created inside the WorkBuddy app/);
    await assert.rejects(handleAgentThreadRequest({ action: "rename", agentAdapter: "workbuddy", threadId: "allowed-old", title: "not-renamed" }, options), /titles are owned by the WorkBuddy app/);
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
    { status: 202, body: { data: { runId: "run-1", status: "accepted" } } },
    { status: 200, body: { data: { runId: "run-1", active: false } } }
  ];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = responses[Math.min(index, responses.length - 1)];
    index += 1;
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
        transport: "http"
      });
    });
    assert.equal(calls[0]?.url, "http://127.0.0.1:5762/api/v1/runs");
    const delivery = calls[0]?.body as { payload?: { text?: string } } | undefined;
    assert.equal(delivery?.payload?.text, "请处理这条缺陷");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
    else process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = originalPassword;
  }
});
