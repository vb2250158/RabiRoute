import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
