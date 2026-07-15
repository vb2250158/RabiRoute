import assert from "node:assert/strict";
import test from "node:test";
import { failClosedCodexServerRequestForTest } from "./codexAppServerClient.js";
import { CODEX_SHARED_RUNTIME_URL } from "./codexSharedRuntime.js";

test("Codex clients use the one shared localhost Runtime", () => {
  assert.equal(CODEX_SHARED_RUNTIME_URL, "ws://127.0.0.1:4510");
});

test("unattended server requests remain fail-closed", () => {
  assert.deepEqual(failClosedCodexServerRequestForTest("item/commandExecution/requestApproval"), { decision: "decline" });
  assert.throws(() => failClosedCodexServerRequestForTest("unknown/request"), /no approved handler/);
});
