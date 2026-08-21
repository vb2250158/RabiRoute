import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapterDefinition } from "../agentAdapters/contracts.js";
import {
  agentAdapterManifest,
  listAgentAdapterManifests,
  type AgentAdapterType
} from "../shared/agentAdapterCapabilities.js";
import { createAgentAdapterRuntime } from "./agentAdapterRuntime.js";

function definition(type: AgentAdapterType): AgentAdapterDefinition {
  return {
    manifest: agentAdapterManifest(type),
    create: () => ({
      type,
      async deliver() {}
    })
  };
}

test("Agent Adapter Fibers register and independently unload definitions", async () => {
  const runtime = await createAgentAdapterRuntime([
    definition("codex"),
    definition("dsh")
  ]);

  assert.deepEqual(runtime.registry.listManifests().map((item) => item.type), ["codex", "dsh"]);
  assert.equal(runtime.registry.create("codex").type, "codex");
  assert.equal(runtime.registry.create("dsh").type, "dsh");

  await runtime.fibers.get("dsh")?.dispose();
  assert.equal(runtime.registry.manifest("dsh"), undefined);
  assert.equal(runtime.registry.create("codex").type, "codex");
  assert.throws(() => runtime.registry.create("dsh"), /Unsupported agent adapter: dsh/);

  await runtime.dispose();
  assert.deepEqual(runtime.registry.listManifests(), []);
});

test("duplicate Agent Adapter types fail registration", async () => {
  await assert.rejects(
    createAgentAdapterRuntime([definition("codex"), definition("codex")]),
    /Agent adapter already registered: codex/
  );
});

test("builtin runtime definitions match the shared manifest catalogue", async () => {
  const runtime = await createAgentAdapterRuntime();
  try {
    assert.deepEqual(runtime.registry.listManifests(), listAgentAdapterManifests());
  } finally {
    await runtime.dispose();
  }
});
