import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLineLog } from "./lineLog.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function lines(filePath: string): string[] {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

test("line log batches appended lines into a daily per-source shard", async () => {
  const dir = tempDir("rabiroute-line-log-");
  try {
    const log = createLineLog({ directory: dir, now: () => new Date("2026-11-12T03:04:05.000Z") });
    log.append("napcat:default", "[10:00:00] first");
    log.append("napcat:default", "[10:00:01] second");
    log.append("webhook", "[10:00:02] other");
    await log.flush();

    assert.deepEqual(lines(path.join(dir, "napcat_default-2026-11-12.log")), [
      "[10:00:00] first",
      "[10:00:01] second"
    ]);
    assert.deepEqual(lines(path.join(dir, "webhook-2026-11-12.log")), ["[10:00:02] other"]);
    assert.equal(log.status().pendingLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("line log flushes on its own timer without an explicit call", async () => {
  const dir = tempDir("rabiroute-line-log-timer-");
  try {
    const log = createLineLog({ directory: dir, flushDelayMs: 10, now: () => new Date("2026-11-12T03:04:05.000Z") });
    log.append("router", "auto flushed");
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.deepEqual(lines(path.join(dir, "router-2026-11-12.log")), ["auto flushed"]);
    assert.equal(log.status().pendingLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("line log removes expired shards but keeps the shard being written", async () => {
  const dir = tempDir("rabiroute-line-log-retention-");
  try {
    const now = new Date("2026-11-12T03:04:05.000Z");
    const expired = path.join(dir, "router-2026-10-01.log");
    const kept = path.join(dir, "router-2026-11-10.log");
    fs.writeFileSync(expired, "old\n", "utf8");
    fs.writeFileSync(kept, "recent\n", "utf8");
    const past = new Date(now.getTime() - 40 * 86_400_000);
    fs.utimesSync(expired, past, past);

    const log = createLineLog({ directory: dir, retentionDays: 7, now: () => now });
    log.append("router", "current");
    await log.flush();

    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(kept), true);
    assert.deepEqual(lines(path.join(dir, "router-2026-11-12.log")), ["current"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flush drains lines queued while a write is already in flight", async () => {
  const dir = tempDir("rabiroute-line-log-drain-");
  try {
    const log = createLineLog({ directory: dir, now: () => new Date("2026-11-12T03:04:05.000Z") });
    log.append("router", "first");
    const inFlight = log.flush();
    log.append("router", "second");
    await inFlight;

    assert.deepEqual(lines(path.join(dir, "router-2026-11-12.log")), ["first", "second"]);
    assert.equal(log.status().pendingLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("line log keeps pending lines when the write fails and retries on flush", async () => {
  const dir = tempDir("rabiroute-line-log-failure-");
  try {
    const log = createLineLog({ directory: dir, now: () => new Date("2026-11-12T03:04:05.000Z") });
    log.append("router", "queued");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, "not a directory", "utf8");

    await assert.rejects(() => log.flush(), /pending line/);
    assert.match(String(log.status().lastError), /ENOTDIR|EEXIST|not a directory/i);

    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir, { recursive: true });
    await log.flush();

    assert.deepEqual(lines(path.join(dir, "router-2026-11-12.log")), ["queued"]);
    assert.equal(log.status().lastError, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later shard failure does not replay shards already written", async () => {
  const dir = tempDir("rabiroute-line-log-partial-");
  try {
    const blocked = path.join(dir, "second-2026-11-12.log");
    fs.mkdirSync(blocked);
    const log = createLineLog({ directory: dir, now: () => new Date("2026-11-12T03:04:05.000Z") });
    log.append("first", "first line");
    log.append("second", "second line");
    await assert.rejects(() => log.flush(), /pending line/);
    assert.deepEqual(lines(path.join(dir, "first-2026-11-12.log")), ["first line"]);
    assert.equal(log.status().pendingLines, 1);
    fs.rmdirSync(blocked);
    await log.flush();
    assert.deepEqual(lines(path.join(dir, "first-2026-11-12.log")), ["first line"]);
    assert.deepEqual(lines(blocked), ["second line"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
