import assert from "node:assert/strict";
import test from "node:test";
import { createAgentAdapter } from "./agentAdapter.js";

test("Node test runner rejects implicit real local and remote Agent delivery", async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "this test must run under node --test");
  await assert.rejects(createAgentAdapter("codex", "local"), /disabled in the Node test runner/);
  await assert.rejects(createAgentAdapter("dsh", "primary"), /disabled in the Node test runner/);
  await assert.rejects(createAgentAdapter("codex", { binding: { instanceId: "isolated-owner", agentId: "isolated-agent" } }), /disabled in the Node test runner/);
});
