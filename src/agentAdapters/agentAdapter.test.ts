import assert from "node:assert/strict";
import test from "node:test";
import { createAgentAdapter } from "./agentAdapter.js";
import { normalizeAgentAdapters, parseAgentAdapterType } from "./types.js";

test("codex agent adapter exposes the Desktop-owner delivery entry", () => {
  const adapter = createAgentAdapter("codex");
  assert.equal(adapter.type, "codex");
  assert.equal(typeof adapter.deliver, "function");
});

test("runtime parsing accepts canonical Agent ids while config migration is one-way", () => {
  assert.equal(parseAgentAdapterType("codex"), "codex");
  assert.equal(parseAgentAdapterType("codexDesktop"), null);
  assert.equal(parseAgentAdapterType("codexApp"), null);
  assert.deepEqual(normalizeAgentAdapters(["codexDesktop", "codexApp"]), ["codex"]);
});
