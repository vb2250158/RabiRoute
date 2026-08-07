import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagerOperationalLog, managerOperationalError } from "./operationalLog.js";

test("Manager operational log writes daily structured records without project-root disclosure", () => {
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
