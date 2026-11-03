import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("remote Codex create retains caller ownership through the real Manager and SDK entrypoints", { timeout: 130_000 }, () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["scripts/test-remote-codex-create.mjs"], {
    cwd: repositoryRoot, env: childEnvironment, windowsHide: true, encoding: "utf8", timeout: 125_000, maxBuffer: 8 * 1024 * 1024
  });
  const summary = /^REMOTE_CODEX_CREATE_TEST_RESULT (.+)$/m.exec(output);
  assert.ok(summary, "The nested remote-create suite must report actual test execution.");
  const counts = JSON.parse(summary[1]!);
  assert.ok(counts.tests > 0 && counts.pass > 0, "The nested suite must execute passing tests.");
  assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0);
  console.log("REMOTE_CODEX_CREATE_TEST_RESULT " + JSON.stringify(counts));
});
