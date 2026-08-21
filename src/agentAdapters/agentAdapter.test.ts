import assert from "node:assert/strict";
import test from "node:test";
import { createAgentAdapter } from "./agentAdapter.js";
import { normalizeAgentAdapters, parseAgentAdapterType } from "./types.js";

test("codex agent adapter exposes the Desktop-owner delivery entry", async () => {
  const adapter = await createAgentAdapter("codex");
  assert.equal(adapter.type, "codex");
  assert.equal(typeof adapter.deliver, "function");
});

test("runtime parsing accepts canonical Agent ids while config migration is one-way", () => {
  assert.equal(parseAgentAdapterType("codex"), "codex");
  assert.equal(parseAgentAdapterType("codexDesktop"), null);
  assert.equal(parseAgentAdapterType("codexApp"), null);
  assert.deepEqual(normalizeAgentAdapters(["codexDesktop", "codexApp"]), ["codex"]);
});

test("Agent adapter facade reads the builtin Gateway root Registry", async () => {
  const { listRegisteredAgentAdapterManifests } = await import("./agentAdapter.js");
  const {
    AGENT_ADAPTER_REGISTRY_SERVICE,
    getBuiltinAgentAdapterRuntime
  } = await import("../runtime/agentAdapterRuntime.js");
  const { getBuiltinGatewayCordisRoot } = await import("../runtime/gatewayCordisRoot.js");
  const runtime = await getBuiltinAgentAdapterRuntime();
  const root = getBuiltinGatewayCordisRoot();

  assert.strictEqual(
    root.host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true),
    runtime.registry
  );
  assert.deepEqual(await listRegisteredAgentAdapterManifests(), runtime.registry.listManifests());
});

test("Agent adapter facade follows a rebuilt Gateway root", async () => {
  const { getBuiltinGatewayCordisRoot } = await import("../runtime/gatewayCordisRoot.js");
  const first = await createAgentAdapter("codex");
  assert.equal(first.type, "codex");

  const firstRoot = getBuiltinGatewayCordisRoot();
  await firstRoot.dispose();

  const second = await createAgentAdapter("codex");
  const secondRoot = getBuiltinGatewayCordisRoot();
  assert.equal(second.type, "codex");
  assert.notStrictEqual(secondRoot, firstRoot);
  await secondRoot.dispose();
});
