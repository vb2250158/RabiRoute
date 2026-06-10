import assert from "node:assert/strict";
import test from "node:test";
import { notifyCodexDesktop } from "../codexDesktopIpc.js";
import { createAgentAdapter } from "./agentAdapter.js";

test("codex agent adapter uses Codex Desktop IPC delivery", () => {
  const adapter = createAgentAdapter("codex");
  assert.equal(adapter.type, "codex");
  assert.equal(adapter.deliver, notifyCodexDesktop);
});
