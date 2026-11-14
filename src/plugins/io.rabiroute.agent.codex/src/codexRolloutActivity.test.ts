import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  clearCodexRolloutActivityCacheForTest,
  readCodexRolloutActivity,
  rolloutShowsActive
} from "./codexRolloutActivity.js";

function withRollout(rows: string[], run: (filePath: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-rollout-activity-"));
  const filePath = path.join(root, "rollout.jsonl");
  fs.writeFileSync(filePath, rows.join(""), "utf8");
  return run(filePath).finally(() => {
    clearCodexRolloutActivityCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const zstdCompressSync = (zlib as typeof zlib & {
  zstdCompressSync?: (input: string | Buffer) => Buffer;
}).zstdCompressSync;

const turn = (id: string) => JSON.stringify({ type: "turn_context", payload: { turn_id: id } }) + "\n";
const terminal = (id: string, type = "task_complete") => JSON.stringify({
  type: "event_msg",
  payload: { type, turn_id: id }
}) + "\n";

const timedTurn = (id: string, timestamp: string) => JSON.stringify({
  timestamp,
  type: "turn_context",
  payload: { turn_id: id }
}) + "\n";

const timedTerminal = (id: string, timestamp: string, type = "task_complete") => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: { type, turn_id: id }
}) + "\n";

test("rollout activity reports the latest unterminated turn as active", async () => {
  await withRollout([
    turn("old"),
    terminal("old"),
    turn("current"),
    JSON.stringify({ type: "response_item", payload: { type: "message", text: "working" } }) + "\n"
  ], async filePath => {
    assert.equal(await rolloutShowsActive(filePath, { chunkBytes: 64 }), true);
  });
});

test("rollout activity reads the exact compressed sibling for the requested task", async t => {
  assert.ok(zstdCompressSync, "This regression requires the Node Zstandard runtime used by RabiRoute.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-compressed-rollout-activity-"));
  t.after(() => {
    clearCodexRolloutActivityCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recordedPath = path.join(root, "rollout.jsonl");
  const content = JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n"
    + turn("current") + terminal("current");
  fs.writeFileSync(recordedPath + ".zst", zstdCompressSync(Buffer.from(content)));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "exact-task" })).state, "inactive");
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "different-task" })).state, "unknown",
    "a cached physical scan cannot bypass the requested task identity");
});

test("recorded JSONL activity verifies identity and never reuses cache across tasks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-recorded-identity-rollout-activity-"));
  t.after(() => {
    clearCodexRolloutActivityCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recordedPath = path.join(root, "rollout.jsonl");
  fs.writeFileSync(recordedPath, JSON.stringify({ type: "session_meta", payload: { id: "task-a" } }) + "\n" + turn("current"));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "task-a" })).state, "active");
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "task-b" })).state, "unknown",
    "a recorded JSONL scan and cache must remain bound to the requested task identity");
  clearCodexRolloutActivityCacheForTest();
  const [owner, other] = await Promise.all([
    readCodexRolloutActivity(recordedPath, { threadId: "task-a" }),
    readCodexRolloutActivity(recordedPath, { threadId: "task-b" })
  ]);
  assert.equal(owner.state, "active");
  assert.equal(other.state, "unknown", "in-flight scans must remain bound to the requested task identity");
});

test("recorded identity has no artificial length cutoff", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-large-rollout-identity-"));
  t.after(() => { clearCodexRolloutActivityCacheForTest(); fs.rmSync(root, { recursive: true, force: true }); });
  const filePath = path.join(root, "rollout.jsonl");
  fs.writeFileSync(filePath, JSON.stringify({ type: "session_meta", payload: { id: "task-large", extra: "x".repeat(100_000) } }) + "\n" + turn("current"));
  assert.equal((await readCodexRolloutActivity(filePath, { threadId: "task-large" })).state, "active");
});

test("rollout activity verifies an uncompressed fallback against the requested task", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-restored-rollout-activity-"));
  t.after(() => {
    clearCodexRolloutActivityCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recordedPath = path.join(root, "rollout.jsonl.zst");
  const restoredPath = recordedPath.slice(0, -4);
  fs.writeFileSync(restoredPath, JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n" + turn("current"));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "exact-task" })).state, "active");
  clearCodexRolloutActivityCacheForTest();
  fs.writeFileSync(restoredPath, JSON.stringify({ type: "session_meta", payload: { id: "different-task" } }) + "\n" + terminal("current"));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "exact-task" })).state, "unknown");
});

test("rollout activity restores recorded authority when the archived path reappears", async t => {
  assert.ok(zstdCompressSync, "This regression requires the Node Zstandard runtime used by RabiRoute.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-restored-authority-activity-"));
  t.after(() => {
    clearCodexRolloutActivityCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recordedPath = path.join(root, "rollout.jsonl.zst");
  const restoredPath = recordedPath.slice(0, -4);
  const identity = JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n";
  fs.writeFileSync(restoredPath, identity + turn("fallback-turn"));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "exact-task" })).state, "active");
  fs.writeFileSync(recordedPath, zstdCompressSync(Buffer.from(identity + turn("recorded-turn") + terminal("recorded-turn"))));
  assert.equal((await readCodexRolloutActivity(recordedPath, { threadId: "exact-task" })).state, "inactive");
});

test("rollout activity reports the latest terminal turn as inactive", async () => {
  await withRollout([
    turn("current"),
    JSON.stringify({ type: "response_item", payload: { type: "message", text: "done" } }) + "\n",
    terminal("current")
  ], async filePath => {
    assert.equal(await rolloutShowsActive(filePath, { chunkBytes: 37 }), false);
  });
});

test("rollout activity exposes when the durable terminal state was observed", async () => {
  await withRollout([
    timedTurn("current", "2026-08-04T17:00:00.000Z"),
    timedTerminal("current", "2026-08-04T17:05:00.000Z")
  ], async filePath => {
    assert.deepEqual(await readCodexRolloutActivity(filePath, { chunkBytes: 37 }), {
      state: "inactive",
      observedAtMs: Date.parse("2026-08-04T17:05:00.000Z")
    });
  });
});

test("rollout activity ignores an incomplete last JSONL record", async () => {
  await withRollout([
    turn("current"),
    terminal("current"),
    '{"type":"turn_context","payload":{"turn_id":"partial'
  ], async filePath => {
    assert.equal(await rolloutShowsActive(filePath, { chunkBytes: 31 }), false);
  });
});

test("rollout activity skips a large irrelevant record without changing the result", async () => {
  await withRollout([
    turn("current"),
    JSON.stringify({ type: "response_item", payload: { text: "x".repeat(32_000) } }) + "\n",
    terminal("current")
  ], async filePath => {
    assert.equal(await rolloutShowsActive(filePath, {
      chunkBytes: 257,
      maxRecordBytes: 512
    }), false);
  });
});

test("rollout activity cache is invalidated when the file grows", async () => {
  await withRollout([
    turn("current")
  ], async filePath => {
    assert.equal(await rolloutShowsActive(filePath, { chunkBytes: 64 }), true);
    fs.appendFileSync(filePath, terminal("current"), "utf8");
    assert.equal(await rolloutShowsActive(filePath, { chunkBytes: 64 }), false);
  });
});
