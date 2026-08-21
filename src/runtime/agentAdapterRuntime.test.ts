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

test("shared Host Agent runtime unmount preserves sibling Fibers", async () => {
  const { RabiCordisHost } = await import("./cordisHost.js");
  const { mountAgentAdapterRuntime } = await import("./agentAdapterRuntime.js");
  const host = new RabiCordisHost();
  let siblingActive = 0;
  await host.mount({
    name: "test:agent-runtime-sibling",
    apply(ctx) {
      ctx.effect(() => {
        siblingActive += 1;
        return () => { siblingActive -= 1; };
      });
    }
  });

  const runtime = await mountAgentAdapterRuntime(host, [definition("codex")]);
  assert.equal(runtime.registry.create("codex").type, "codex");
  await runtime.unmount();
  assert.deepEqual(runtime.registry.listManifests(), []);
  assert.equal(siblingActive, 1);

  await host.dispose();
  assert.equal(siblingActive, 0);
});

test("shared Host Agent registration failure rolls back only the Agent slice", async () => {
  const { RabiCordisHost } = await import("./cordisHost.js");
  const {
    AGENT_ADAPTER_REGISTRY_SERVICE,
    mountAgentAdapterRuntime
  } = await import("./agentAdapterRuntime.js");
  const host = new RabiCordisHost();
  let siblingActive = true;
  await host.mount({
    name: "test:agent-runtime-rollback-sibling",
    apply(ctx) {
      ctx.effect(() => () => { siblingActive = false; });
    }
  });

  await assert.rejects(
    mountAgentAdapterRuntime(host, [definition("codex"), definition("codex")]),
    /Agent adapter already registered: codex/
  );
  assert.equal(host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE), undefined);
  assert.equal(siblingActive, true);
  await host.dispose();
  assert.equal(siblingActive, false);
});

test("builtin Agent runtime is deduplicated by the builtin Gateway root", async () => {
  const {
    AGENT_ADAPTER_REGISTRY_SERVICE,
    getBuiltinAgentAdapterRuntime
  } = await import("./agentAdapterRuntime.js");
  const { getBuiltinGatewayCordisRoot } = await import("./gatewayCordisRoot.js");
  const [first, second] = await Promise.all([
    getBuiltinAgentAdapterRuntime(),
    getBuiltinAgentAdapterRuntime()
  ]);
  const root = getBuiltinGatewayCordisRoot();

  assert.strictEqual(first, second);
  assert.strictEqual(
    root.host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true),
    first.registry
  );
  await root.dispose();

  const replacement = await getBuiltinAgentAdapterRuntime();
  const replacementRoot = getBuiltinGatewayCordisRoot();
  assert.notStrictEqual(replacement.registry, first.registry);
  assert.notStrictEqual(replacementRoot, root);
  await replacementRoot.dispose();
});
