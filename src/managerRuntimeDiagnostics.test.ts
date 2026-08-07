import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagerRuntimeDiagnostics } from "./managerRuntimeDiagnostics.js";

test("Manager runtime diagnostics append privacy-bounded daily crash events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-diagnostics-"));
  const timestamps = [
    new Date("2026-07-30T10:00:00.000Z"),
    new Date("2026-07-30T10:00:01.000Z")
  ];
  const diagnostics = createManagerRuntimeDiagnostics({
    rootDir: root,
    now: () => timestamps.shift() ?? new Date("2026-07-30T10:00:02.000Z"),
    pid: 123,
    parentPid: 45,
    nodeVersion: "v22.17.1",
    platform: "win32",
    uptime: () => 2.5
  });
  try {
    assert.equal(diagnostics.logDirectory, path.join(root, "logs", "manager"));
    const error = new Error(`rename failed under ${root}`) as NodeJS.ErrnoException & { path: string };
    error.code = "EPERM";
    error.syscall = "rename";
    error.path = path.join(root, "data", "persona-sync", "manifest-index.json");
    diagnostics.record("uncaught_exception", { error });

    const logPath = path.join(
      diagnostics.logDirectory,
      "manager-runtime-2026-07-30.jsonl"
    );
    const records = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "uncaught_exception");
    assert.equal(records[0].pid, 123);
    assert.equal(records[0].uptimeMs, 2500);
    assert.equal(records[0].error.code, "EPERM");
    assert.equal(records[0].error.path, "data/persona-sync/manifest-index.json");
    assert.match(records[0].error.message, /<projectRoot>/);
    assert.doesNotMatch(JSON.stringify(records[0]), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
