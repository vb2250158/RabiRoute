import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  listWorkbuddySessionDescriptors,
  listWorkbuddyTasks,
  listWorkbuddyWorkspaces,
  normalizeWorkbuddyWorkspace,
  parseWorkbuddySessionDescriptor,
  resolveWorkbuddyTask,
  sameWorkbuddyWorkspace,
  workbuddyProjectId,
  WORKBUDDY_SESSION_STALE_MS
} from "./workbuddySessionStore.js";

function createTaskDatabase(rows: Array<Record<string, unknown>>): { root: string; databasePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-workbuddy-"));
  const databasePath = path.join(root, "workbuddy.db");
  const database = new DatabaseSync(databasePath);
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
      String(row.id), String(row.cwd), String(row.title ?? ""),
      row.custom_title == null ? null : String(row.custom_title),
      String(row.status ?? "pending"),
      Number(row.created_at ?? 1_000), Number(row.updated_at ?? 1_000),
      Number(row.last_activity_at ?? row.updated_at ?? 1_000),
      Number(row.deleted_at ?? 0), String(row.mode ?? "craft"), String(row.model ?? "m")
    );
  }
  database.close();
  return { root, databasePath };
}

function writeDescriptor(root: string, name: string, value: unknown): string {
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  return dir;
}

test("normalizeWorkbuddyWorkspace treats drive case and separators as one workspace", () => {
  assert.equal(
    normalizeWorkbuddyWorkspace("C:\\work\\example"),
    "c:\\work\\example"
  );
  assert.equal(
    normalizeWorkbuddyWorkspace("c:/work/example/"),
    "c:\\work\\example"
  );
  assert.equal(normalizeWorkbuddyWorkspace("d:\\"), "d:\\");
  assert.equal(normalizeWorkbuddyWorkspace("  "), "");
  assert.ok(sameWorkbuddyWorkspace("C:\\Data\\Project", "c:\\Data\\Project\\"));
  assert.ok(sameWorkbuddyWorkspace(
    "C:\\work\\example",
    "c:\\work\\example"
  ));
  assert.ok(!sameWorkbuddyWorkspace("C:\\Data\\Project", "C:\\Data\\Other"));
  assert.ok(!sameWorkbuddyWorkspace("", "C:\\Data\\Project"));
});

test("workbuddyProjectId keeps path case and matches the desktop project directory", () => {
  assert.equal(workbuddyProjectId("C:\\work\\example"), "c-work-example");
  assert.equal(workbuddyProjectId("c:\\work\\example\\"), "c-work-example");
  assert.equal(workbuddyProjectId("D:/Work/Demo"), "d-Work-Demo");
  assert.equal(workbuddyProjectId(""), "");
});

test("parseWorkbuddySessionDescriptor marks only live endpoint sessions deliverable", () => {
  const now = 1_700_000_000_000;
  const live = parseWorkbuddySessionDescriptor({
    pid: 63808,
    sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
    cwd: "C:\\work\\example",
    kind: "interactive",
    endpoint: "http://127.0.0.1:6762",
    lastHeartbeat: now - 1_000
  }, { now, alive: () => true });
  assert.equal(live?.deliverable, true);
  assert.equal(live?.endpoint, "http://127.0.0.1:6762");

  // Verified on a real machine: this shape has no endpoint at all.
  const noEndpoint = parseWorkbuddySessionDescriptor({
    pid: 24616,
    sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
    cwd: "C:\\work\\example",
    kind: "interactive",
    lastHeartbeat: now - 1_000
  }, { now, alive: () => true });
  assert.equal(noEndpoint?.deliverable, false);

  const stale = parseWorkbuddySessionDescriptor({
    pid: 63808,
    sessionId: "x",
    kind: "interactive",
    endpoint: "http://127.0.0.1:6762",
    lastHeartbeat: now - WORKBUDDY_SESSION_STALE_MS - 1
  }, { now, alive: () => true });
  assert.equal(stale?.stale, true);
  assert.equal(stale?.deliverable, false);

  const prewarm = parseWorkbuddySessionDescriptor({
    pid: 44672,
    sessionId: "prewarm-wb-pool-1",
    kind: "prewarm",
    endpoint: "http://127.0.0.1:1",
    lastHeartbeat: now,
    meta: { socketPath: "\\\\.\\pipe\\codebuddy-prewarm-wb-pool-1", status: "idle" }
  }, { now, alive: () => true });
  assert.equal(prewarm?.deliverable, false);
  assert.equal(prewarm?.socketPath, "\\\\.\\pipe\\codebuddy-prewarm-wb-pool-1");

  const dead = parseWorkbuddySessionDescriptor({
    pid: 1,
    sessionId: "x",
    kind: "interactive",
    endpoint: "http://127.0.0.1:6762",
    lastHeartbeat: now
  }, { now, alive: () => false });
  assert.equal(dead?.deliverable, false);
  assert.equal(parseWorkbuddySessionDescriptor({ sessionId: "no-pid" }), null);
});

test("listWorkbuddySessionDescriptors tolerates heterogeneous and broken files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-workbuddy-sessions-"));
  const dir = writeDescriptor(root, "1.json", { pid: 1, sessionId: "a", kind: "interactive", endpoint: "http://127.0.0.1:1", lastHeartbeat: Date.now() });
  fs.writeFileSync(path.join(dir, "2.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "3.json"), JSON.stringify({ sessionId: "missing-pid" }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const descriptors = listWorkbuddySessionDescriptors({ sessionsDir: dir, alive: () => true });
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].sessionId, "a");
});

test("resolveWorkbuddyTask follows the standard order for a saved ID", () => {
  const { databasePath } = createTaskDatabase([
    { id: "task-live", cwd: "C:\\Data\\Project", title: "auto title", custom_title: "用户命名", updated_at: 5_000 },
    { id: "task-archived", cwd: "C:\\Data\\Project", title: "old", deleted_at: 9_999, updated_at: 4_000 }
  ]);
  const descriptors = [
    parseWorkbuddySessionDescriptor(
      { pid: 10, sessionId: "task-live", kind: "interactive", endpoint: "http://127.0.0.1:5555", lastHeartbeat: Date.now() },
      { alive: () => true }
    )!
  ];

  const bound = resolveWorkbuddyTask({
    sessionId: "task-live", workspace: "c:\\data\\project", databasePath, descriptors
  });
  assert.equal(bound.outcome, "bound");
  assert.equal(bound.outcome === "bound" && bound.task.name, "用户命名");
  assert.equal(bound.outcome === "bound" && bound.task.userNamed, true);
  assert.equal(bound.outcome === "bound" && bound.task.live?.endpoint, "http://127.0.0.1:5555");

  const archived = resolveWorkbuddyTask({ sessionId: "task-archived", databasePath, descriptors });
  assert.deepEqual(archived, { outcome: "archived", taskId: "task-archived" });

  const unknown = resolveWorkbuddyTask({ sessionId: "does-not-exist", databasePath, descriptors });
  assert.equal(unknown.outcome, "invalid");

  const conflict = resolveWorkbuddyTask({
    sessionId: "task-live", workspace: "C:\\Data\\Other", databasePath, descriptors
  });
  assert.equal(conflict.outcome, "invalid");
  assert.match(conflict.outcome === "invalid" ? conflict.reason : "", /不一致/);
});

test("resolveWorkbuddyTask picks the newest name match and asks on a tie", () => {
  const { databasePath } = createTaskDatabase([
    { id: "newer", cwd: "C:\\Data\\Project", custom_title: "RabiRoute", updated_at: 8_000 },
    { id: "older", cwd: "C:\\Data\\Project", custom_title: "RabiRoute", updated_at: 7_000 },
    { id: "other-cwd", cwd: "C:\\Data\\Other", custom_title: "RabiRoute", updated_at: 9_000 },
    { id: "tie-a", cwd: "C:\\Data\\Tie", custom_title: "Tied", updated_at: 6_000 },
    { id: "tie-b", cwd: "C:\\Data\\Tie", custom_title: "Tied", updated_at: 6_000 }
  ]);
  const bound = resolveWorkbuddyTask({ sessionName: "RabiRoute", workspace: "C:\\Data\\Project", databasePath });
  assert.equal(bound.outcome, "bound");
  assert.equal(bound.outcome === "bound" && bound.task.id, "newer");

  const tied = resolveWorkbuddyTask({ sessionName: "Tied", workspace: "C:\\Data\\Tie", databasePath });
  assert.equal(tied.outcome, "candidates");
  assert.equal(tied.outcome === "candidates" && tied.candidates.length, 2);

  const missing = resolveWorkbuddyTask({ sessionName: "Not There", workspace: "C:\\Data\\Project", databasePath });
  assert.deepEqual(missing, { outcome: "missing", requestedName: "Not There", workspace: "C:\\Data\\Project" });

  const noName = resolveWorkbuddyTask({ databasePath });
  assert.equal(noName.outcome, "invalid");
});

test("auto title never drives the visible name or name lookup", () => {
  const { databasePath } = createTaskDatabase([
    { id: "auto-only", cwd: "C:\\Data\\Project", title: "首条 prompt 自动标题", updated_at: 3_000 }
  ]);
  const tasks = listWorkbuddyTasks({ databasePath, descriptors: [] });
  assert.equal(tasks[0].name, "首条 prompt 自动标题");
  assert.equal(tasks[0].userNamed, false);
  assert.equal(tasks[0].autoTitle, "首条 prompt 自动标题");
  assert.deepEqual(listWorkbuddyWorkspaces(databasePath), ["C:\\Data\\Project"]);
});

test("listWorkbuddyTasks filters archived and reports workspace candidates", () => {
  const { databasePath } = createTaskDatabase([
    { id: "live", cwd: "C:\\Data\\Project", custom_title: "Live", updated_at: 2_000 },
    { id: "archived", cwd: "C:\\Data\\Project", custom_title: "Archived", deleted_at: 3_000, updated_at: 1_000 }
  ]);
  assert.deepEqual(listWorkbuddyTasks({ databasePath, descriptors: [] }).map(task => task.id), ["live"]);
  assert.equal(listWorkbuddyTasks({ databasePath, descriptors: [], includeArchived: true }).length, 2);
  assert.deepEqual(listWorkbuddyTasks({ databasePath, descriptors: [], workspace: "c:\\data\\project" }).length, 1);
  assert.deepEqual(listWorkbuddyTasks({ databasePath, descriptors: [], query: "archive", includeArchived: true }).length, 1);
});
