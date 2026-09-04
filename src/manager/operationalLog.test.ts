import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagerOperationalLog, managerOperationalError } from "./operationalLog.js";

test("Manager operational log writes daily structured records without project-root disclosure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-operations-"));
  try {
    const now = new Date("2026-08-05T03:04:05.000Z");
    const log = createManagerOperationalLog({ rootDir: root, now: () => now, pid: 321 });
    assert.equal(log.logDirectory, path.join(root, "logs", "manager"));
    const error = new Error(`failed inside ${root}`);
    log.record("error", "http_request_failed", {
      requestId: "req-1",
      method: "POST",
      pathname: "/gateways/example/restart",
      statusCode: 500,
      durationMs: 42,
      error: managerOperationalError(error, root)
    });
    await log.flush();

    const file = path.join(log.logDirectory, "manager-operations-2026-08-05.jsonl");
    const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(record.event, "http_request_failed");
    assert.equal(record.requestId, "req-1");
    assert.equal(record.pathname, "/gateways/example/restart");
    assert.equal(record.pid, 321);
    assert.match(record.error.message, /<projectRoot>/);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manager operational log batches concurrent records without dropping order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-operation-batch-"));
  try {
    const now = new Date("2026-08-05T03:04:05.000Z");
    const log = createManagerOperationalLog({ rootDir: root, now: () => now, pid: 321 });
    for (let index = 0; index < 100; index += 1) {
      log.record("info", "http_request_completed", { requestId: `req-${index}`, durationMs: index });
    }
    await log.flush();

    const file = path.join(log.logDirectory, "manager-operations-2026-08-05.jsonl");
    const records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(records.length, 100);
    assert.deepEqual(records.map((record) => record.requestId), Array.from({ length: 100 }, (_, index) => `req-${index}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manager operational log keeps a failed batch pending and reports degraded state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-operation-failure-"));
  try {
    const log = createManagerOperationalLog({ rootDir: root, retryBaseMs: 60_000 });
    fs.mkdirSync(log.logDirectory, { recursive: true });
    fs.writeFileSync(path.join(log.logDirectory, "manager-operations-2026-08-05.jsonl"), "occupied", "utf8");
    const fixed = new Date("2026-08-05T03:04:05.000Z");
    const failing = createManagerOperationalLog({ rootDir: root, now: () => fixed, retryBaseMs: 60_000 });
    fs.rmSync(log.logDirectory, { recursive: true, force: true });
    fs.writeFileSync(log.logDirectory, "not-a-directory", "utf8");
    failing.record("info", "mutation_committed", { group: "test" });
    await assert.rejects(failing.flush());
    assert.equal(failing.status().state, "degraded");
    assert.equal(failing.status().pendingRecords, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manager operational log filters disabled groups and captures configured diagnostic stacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-operation-groups-"));
  try {
    const log = createManagerOperationalLog({
      rootDir: root,
      enabledGroups: new Set(["config"]),
      diagnosticGroups: new Set(["config"])
    });
    assert.equal(log.record("info", "ignored", { group: "runtime" }), null);
    const record = log.record("info", "saved", { group: "config" });
    assert.match(record?.diagnostic?.stack ?? "", /Diagnostic callsite for saved/);
    await log.flush();
    assert.equal(log.status().state, "healthy");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manager operational log removes expired daily shards before appending the current batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-operation-retention-"));
  try {
    const logDirectory = path.join(root, "logs", "manager");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(path.join(logDirectory, "manager-operations-2026-08-01.jsonl"), "old\n", "utf8");
    fs.writeFileSync(path.join(logDirectory, "manager-operations-2026-08-04.jsonl"), "recent\n", "utf8");
    const log = createManagerOperationalLog({
      rootDir: root,
      now: () => new Date("2026-08-05T03:04:05.000Z"),
      retentionDays: 2
    });
    log.record("info", "current", { group: "test" });
    await log.flush();
    assert.equal(fs.existsSync(path.join(logDirectory, "manager-operations-2026-08-01.jsonl")), false);
    assert.equal(fs.existsSync(path.join(logDirectory, "manager-operations-2026-08-04.jsonl")), true);
    assert.equal(fs.existsSync(path.join(logDirectory, "manager-operations-2026-08-05.jsonl")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
