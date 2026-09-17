import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  antigravitySummariesDatabasePath,
  listAntigravitySessions,
  listAntigravityWorkspaces,
  normalizeAntigravityWorkspace,
  readAntigravitySessions
} from "./antigravitySessionStore.js";

type Row = {
  conversation_id: string;
  title: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
  status?: string;
  project_id?: string;
  app_data_dir?: string;
  last_user_input_step_index?: number;
};

/** Build a conversation index with the columns the store reads. */
function makeDatabase(rows: Row[]): { root: string; databasePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-index-"));
  const databasePath = path.join(root, "conversation_summaries.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
    step_count INTEGER NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
    agent_name TEXT NOT NULL DEFAULT '', parent_conversation_id TEXT NOT NULL DEFAULT '',
    nesting_depth INTEGER NOT NULL DEFAULT 0, battle_id TEXT NOT NULL DEFAULT '',
    winning_conversation_id TEXT NOT NULL DEFAULT '', not_fully_idle numeric NOT NULL DEFAULT false,
    killed numeric NOT NULL DEFAULT false, last_user_input_time datetime,
    last_user_input_step_index INTEGER NOT NULL DEFAULT -1, app_data_dir TEXT NOT NULL DEFAULT '',
    raw_summary BLOB, group_id TEXT NOT NULL DEFAULT '')`);
  const insert = db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id,
     app_data_dir, last_user_input_step_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.conversation_id,
      row.title,
      row.preview ?? "",
      row.step_count ?? 0,
      row.last_modified_time ?? "2026-09-17 03:00:00+00:00",
      row.workspace_uris ?? "[]",
      row.status ?? "CASCADE_RUN_STATUS_IDLE",
      row.project_id ?? "outside-of-project",
      row.app_data_dir ?? "antigravity",
      row.last_user_input_step_index ?? -1
    );
  }
  db.close();
  return { root, databasePath };
}

test("the index path follows the per-user data directory", () => {
  assert.equal(
    antigravitySummariesDatabasePath({ ANTIGRAVITY_DATA_HOME: "D:\\agy" }),
    path.join("D:\\agy", "conversation_summaries.db")
  );
});

test("conversations are read with their title, workspace and recency", () => {
  const { root, databasePath } = makeDatabase([
    {
      conversation_id: "conv-a",
      title: "Named conversation",
      preview: "first words",
      step_count: 12,
      last_modified_time: "2026-09-17 04:00:00+00:00",
      workspace_uris: JSON.stringify(["file:///C:/Work/ExampleProject"]),
      last_user_input_step_index: 4
    },
    {
      conversation_id: "conv-b",
      title: "Older conversation",
      step_count: 3,
      last_modified_time: "2026-09-17 01:00:00+00:00",
      last_user_input_step_index: 1
    }
  ]);
  try {
    const sessions = readAntigravitySessions({ databasePath });
    // Newest first, which is the order the desktop sidebar shows.
    assert.deepEqual(sessions.map((session) => session.id), ["conv-a", "conv-b"]);
    assert.equal(sessions[0]?.title, "Named conversation");
    assert.equal(sessions[0]?.preview, "first words");
    assert.equal(sessions[0]?.stepCount, 12);
    assert.deepEqual(sessions[0]?.workspaceUris, ["file:///C:/Work/ExampleProject"]);
    assert.equal(sessions[0]?.empty, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversations with no user turn are excluded unless explicitly requested", () => {
  // `last_user_input_step_index` stays at -1 until a real user turn lands, so it
  // is the reliable emptiness signal.
  const { root, databasePath } = makeDatabase([
    { conversation_id: "used", title: "Has a turn", last_user_input_step_index: 2 },
    { conversation_id: "untouched", title: "No turn yet", last_user_input_step_index: -1 }
  ]);
  try {
    assert.deepEqual(readAntigravitySessions({ databasePath }).map((session) => session.id), ["used"]);
    assert.deepEqual(
      readAntigravitySessions({ databasePath, includeEmpty: true }).map((session) => session.id).sort(),
      ["untouched", "used"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing index reads as empty rather than throwing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-noindex-"));
  try {
    assert.deepEqual(readAntigravitySessions({ databasePath: path.join(root, "absent.db") }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attribution filters out conversations owned by another product", () => {
  // The index is shared by the desktop app and the CLI, so an unfiltered read
  // would list conversations that belong to a different host.
  const { root, databasePath } = makeDatabase([
    { conversation_id: "desktop", title: "Desktop convo", app_data_dir: "antigravity", last_user_input_step_index: 3 },
    { conversation_id: "cli", title: "CLI convo", app_data_dir: "agy", last_user_input_step_index: 3 }
  ]);
  try {
    assert.deepEqual(
      readAntigravitySessions({ databasePath, appDataDir: "antigravity" }).map((session) => session.id),
      ["desktop"]
    );
    assert.equal(readAntigravitySessions({ databasePath }).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search matches title and preview but stays case-insensitive", () => {
  const { root, databasePath } = makeDatabase([
    { conversation_id: "a", title: "Plan review", preview: "", last_user_input_step_index: 1 },
    { conversation_id: "b", title: "Other", preview: "mentions plan review too", last_user_input_step_index: 1 },
    { conversation_id: "c", title: "Unrelated", preview: "", last_user_input_step_index: 1 }
  ]);
  try {
    const result = listAntigravitySessions({ databasePath, query: "PLAN REVIEW" });
    assert.deepEqual(result.sessions.map((session) => session.id), ["a", "b"]);
    assert.equal(result.total, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("paging reports whether more conversations remain", () => {
  const { root, databasePath } = makeDatabase(
    Array.from({ length: 5 }, (_unused, index) => ({
      conversation_id: `conv-${index}`,
      title: `Conversation ${index}`,
      last_modified_time: `2026-09-17 0${index}:00:00+00:00`,
      last_user_input_step_index: 1
    }))
  );
  try {
    const first = listAntigravitySessions({ databasePath, limit: 2, offset: 0 });
    assert.equal(first.sessions.length, 2);
    assert.equal(first.total, 5);
    assert.equal(first.hasMore, true);
    const last = listAntigravitySessions({ databasePath, limit: 2, offset: 4 });
    assert.equal(last.sessions.length, 1);
    assert.equal(last.hasMore, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace filtering compares Windows paths case-insensitively", () => {
  const { root, databasePath } = makeDatabase([
    {
      conversation_id: "in-scope",
      title: "In scope",
      workspace_uris: JSON.stringify(["file:///C:/Work/ExampleProject"]),
      last_user_input_step_index: 2
    },
    {
      conversation_id: "out-of-scope",
      title: "Out of scope",
      workspace_uris: JSON.stringify(["file:///C:/Work/OtherProject"]),
      last_user_input_step_index: 2
    }
  ]);
  try {
    const result = listAntigravitySessions({ databasePath, workspace: "c:\\work\\exampleproject" });
    assert.deepEqual(result.sessions.map((session) => session.id), ["in-scope"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspaces are listed once each, decoded from their file URIs", () => {
  const { root, databasePath } = makeDatabase([
    {
      conversation_id: "a",
      title: "A",
      workspace_uris: JSON.stringify(["file:///C:/Work/ExampleProject"]),
      last_user_input_step_index: 1
    },
    {
      conversation_id: "b",
      title: "B",
      workspace_uris: JSON.stringify(["file:///C:/Work/ExampleProject"]),
      last_user_input_step_index: 1
    },
    {
      conversation_id: "c",
      title: "C",
      workspace_uris: JSON.stringify(["file:///C:/Work/Second%20Project"]),
      last_user_input_step_index: 1
    }
  ]);
  try {
    const workspaces = listAntigravityWorkspaces({ databasePath }).sort();
    assert.deepEqual(workspaces, ["C:/Work/ExampleProject", "C:/Work/Second Project"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plain-text workspace value is accepted for rows older than the array format", () => {
  const { root, databasePath } = makeDatabase([
    { conversation_id: "legacy", title: "Legacy", workspace_uris: "C:\\Work\\LegacyProject", last_user_input_step_index: 1 }
  ]);
  try {
    assert.deepEqual(readAntigravitySessions({ databasePath })[0]?.workspaceUris, ["C:\\Work\\LegacyProject"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace normalization makes Windows path comparisons reliable", () => {
  assert.equal(
    normalizeAntigravityWorkspace("C:\\Work\\ExampleProject\\"),
    normalizeAntigravityWorkspace("c:/work/exampleproject")
  );
});
