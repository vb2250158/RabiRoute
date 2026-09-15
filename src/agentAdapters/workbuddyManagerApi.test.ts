import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanWorkbuddyAgentAdapter } from "./workbuddyManagerApi.js";
import type { AgentManagerApiContext } from "./managerApi.js";

type Fixture = {
  rootDir: string;
  sessionsDir: string;
  databasePath: string;
};

function createFixture(options: {
  tasks: Array<Record<string, unknown>>;
  descriptors?: Array<Record<string, unknown>>;
}): Fixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-workbuddy-scan-"));
  const sessionsDir = path.join(rootDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  (options.descriptors ?? []).forEach((descriptor, index) => {
    fs.writeFileSync(path.join(sessionsDir, `${index + 1}.json`), JSON.stringify(descriptor));
  });
  const databasePath = path.join(rootDir, "workbuddy.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, custom_title TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER,
      deleted_at INTEGER, is_playground INTEGER, is_background_automation INTEGER,
      mode TEXT, model TEXT
    )
  `);
  const insert = database.prepare(`
    INSERT INTO sessions (
      id, cwd, title, custom_title, status, created_at, updated_at,
      last_activity_at, deleted_at, is_playground, is_background_automation, mode, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'craft', 'm')
  `);
  for (const task of options.tasks) {
    insert.run(
      String(task.id), String(task.cwd), String(task.title ?? ""),
      task.custom_title == null ? null : String(task.custom_title),
      String(task.status ?? "pending"),
      Number(task.created_at ?? 1_000), Number(task.updated_at ?? 1_000),
      Number(task.last_activity_at ?? task.updated_at ?? 1_000),
      Number(task.deleted_at ?? 0)
    );
  }
  database.close();
  return { rootDir, sessionsDir, databasePath };
}

function contextFor(fixture: Fixture): AgentManagerApiContext {
  return {
    rootDir: fixture.rootDir,
    workbuddySessionsDir: fixture.sessionsDir,
    workbuddyDatabasePath: fixture.databasePath
  };
}

test("WorkBuddy scan lists desktop tasks with names, workspaces and live endpoints", async () => {
  const fixture = createFixture({
    tasks: [
      { id: "task-a", cwd: "C:\\Data\\ProjectA", custom_title: "用户命名任务", updated_at: 5_000 },
      { id: "task-b", cwd: "C:\\Data\\ProjectB", title: "自动标题任务", updated_at: 4_000 },
      { id: "task-c", cwd: "C:\\Data\\ProjectA", custom_title: "已归档", deleted_at: 9_000, updated_at: 3_000 }
    ],
    descriptors: [
      {
        // A real, currently live pid: the scan checks process liveness, so a
        // fabricated pid would be reported as a dead owner.
        pid: process.pid, sessionId: "task-a", cwd: "C:\\Data\\ProjectA", kind: "interactive",
        endpoint: "http://127.0.0.1:6762", lastHeartbeat: Date.now()
      },
      {
        pid: process.pid, sessionId: "prewarm-pool", kind: "prewarm", lastHeartbeat: Date.now(),
        meta: { socketPath: "\\\\.\\pipe\\codebuddy-prewarm-pool", status: "idle" }
      }
    ]
  });

  const scan = await scanWorkbuddyAgentAdapter(contextFor(fixture));
  const agent = scan.agents.workbuddy;

  assert.equal(agent.type, "workbuddy");
  assert.equal(agent.maturity, "experimental");
  assert.equal(agent.installed, true);
  assert.deepEqual(agent.transport, { protocol: "http", mode: "session-gateway" });
  assert.deepEqual(agent.host, { name: "WorkBuddy Desktop", required: true });
  assert.equal(agent.auth?.required, true);
  // The scan reports auth as *configured*, which is a statement about the local
  // credential file, not about a live login. It must never over-claim.
  const credentialConfigured = agent.auth?.loggedIn === true;
  if (!credentialConfigured) assert.equal(agent.auth?.loggedIn, undefined);

  const byId = new Map((agent.sessions ?? []).map(session => [session.id, session]));
  assert.equal(agent.sessions?.length, 2, "archived tasks are not listed");
  assert.deepEqual(byId.get("task-a"), {
    id: "task-a",
    name: "用户命名任务",
    projectPath: "C:\\Data\\ProjectA",
    projectId: "c-Data-ProjectA",
    updatedAt: new Date(5_000).toISOString(),
    userNamed: true,
    status: "pending",
    live: true
  });
  assert.equal(byId.get("task-b")?.name, "自动标题任务");
  assert.equal(byId.get("task-b")?.userNamed, false);

  assert.deepEqual(agent.sessionPage, {
    offset: 0, limit: 200, returned: 2, hasMore: false
  });
  assert.deepEqual(scan.cwdOptions.sort(), ["C:\\Data\\ProjectA", "C:\\Data\\ProjectB"]);

  const endpoints = agent.endpoints ?? [];
  assert.equal(endpoints.length, 1, "only the live interactive gateway is an endpoint");
  assert.equal(endpoints[0].url, "http://127.0.0.1:6762");
  assert.equal(endpoints[0].healthy, true);

  const warnings = agent.warnings ?? [];
  assert.ok(warnings.some(warning => warning.includes("未发布本地网关地址")), "missing endpoint is reported");
  // Delivery is implemented, so the scan must not keep claiming otherwise; it
  // must still state the one remaining manual step (the credential).
  assert.ok(
    !warnings.some(warning => warning.includes("投递尚未实现")),
    "the scan must not report delivery as unimplemented now that it ships"
  );
});

test("WorkBuddy scan pages and filters sessions without pretending to be on demand", async () => {
  const fixture = createFixture({
    tasks: [
      { id: "t1", cwd: "C:\\Data\\One", custom_title: "任务一", updated_at: 3_000 },
      { id: "t2", cwd: "C:\\Data\\One", custom_title: "任务二", updated_at: 2_000 },
      { id: "t3", cwd: "C:\\Data\\Two", custom_title: "任务三", updated_at: 1_000 }
    ]
  });
  const ctx = contextFor(fixture);

  const first = await scanWorkbuddyAgentAdapter(ctx, { workbuddyLimit: 1 });
  assert.equal(first.agents.workbuddy.sessions?.length, 1);
  assert.deepEqual(first.agents.workbuddy.sessionPage, {
    offset: 0, limit: 1, returned: 1, hasMore: true, nextOffset: 1
  });

  const second = await scanWorkbuddyAgentAdapter(ctx, { workbuddyLimit: 1, workbuddyOffset: 1 });
  assert.equal(second.agents.workbuddy.sessions?.[0]?.id, "t2");

  const scoped = await scanWorkbuddyAgentAdapter(ctx, { workbuddyWorkspace: "c:\\data\\two" });
  assert.deepEqual(scoped.agents.workbuddy.sessions?.map(session => session.id), ["t3"]);

  const searched = await scanWorkbuddyAgentAdapter(ctx, { workbuddyQuery: "任务二" });
  assert.deepEqual(searched.agents.workbuddy.sessions?.map(session => session.id), ["t2"]);
});

test("WorkBuddy scan degrades to an actionable empty result on a clean machine", async () => {
  const fixture = createFixture({ tasks: [] });
  const scan = await scanWorkbuddyAgentAdapter(contextFor(fixture));
  const agent = scan.agents.workbuddy;
  assert.equal(agent.installed, false);
  assert.deepEqual(agent.sessions, []);
  assert.deepEqual(agent.endpoints, []);
  assert.ok((agent.warnings ?? []).some(warning => warning.includes("未发现 WorkBuddy 任务")));
});
