import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapterDefinition } from "../agentAdapters/contracts.js";
import type { MessageAdapterDefinition } from "../adapters/messageAdapter.js";
import { agentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import {
  AGENT_ADAPTER_REGISTRY_SERVICE,
  mountAgentAdapterRuntime
} from "./agentAdapterRuntime.js";
import {
  CONTRIBUTION_REGISTRY_SERVICE,
  contributionPlugin,
  mountContributionRuntime
} from "./contributionRuntime.js";
import {
  MESSAGE_ADAPTER_REGISTRY_SERVICE,
  mountMessageAdapterRuntime
} from "./messageAdapterRuntime.js";
import { createGatewayCordisRoot } from "./gatewayCordisRoot.js";

const agentDefinition: AgentAdapterDefinition = {
  manifest: agentAdapterManifest("codex"),
  create: () => ({
    type: "codex",
    async deliver() {}
  })
};

function messageDefinition(onStart: () => void, onDispose: () => void): MessageAdapterDefinition {
  return {
    manifest: {
      type: "heartbeat",
      label: "Test heartbeat",
      host: "gateway",
      transport: "timer",
      lifecycle: "fiber"
    },
    create: () => ({
      type: "heartbeat",
      start() {
        onStart();
        return onDispose;
      }
    })
  };
}

const testContribution = {
  kind: "navigation" as const,
  id: "shared-root",
  labelKey: "nav.sharedRoot",
  target: "/shared-root",
  hosts: ["web"] as const
};

test("Gateway Cordis root initializes one runtime per key", async () => {
  const root = createGatewayCordisRoot();
  let initializeCount = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });

  const first = root.ensure("shared", async () => {
    initializeCount += 1;
    await gate;
    return { id: "runtime" };
  });
  const second = root.ensure("shared", async () => {
    initializeCount += 1;
    return { id: "duplicate" };
  });

  assert.strictEqual(first, second);
  finish();
  assert.deepEqual(await first, { id: "runtime" });
  assert.equal(initializeCount, 1);
  await root.dispose();
});

test("Gateway Cordis root removes failed initialization so the key can retry", async () => {
  const root = createGatewayCordisRoot();
  let attempts = 0;

  await assert.rejects(root.ensure("retry", async () => {
    attempts += 1;
    throw new Error("initialization failed");
  }), /initialization failed/);

  const value = await root.ensure("retry", async () => {
    attempts += 1;
    return "ready";
  });
  assert.equal(value, "ready");
  assert.equal(attempts, 2);
  await root.dispose();
});

test("Agent, Message, and Contribution registries share one Gateway root Context", async () => {
  const root = createGatewayCordisRoot();
  let activeMessageAdapters = 0;

  const agentRuntime = await root.ensure("agent", (host) => mountAgentAdapterRuntime(host, [agentDefinition]));
  const contributionRuntime = await root.ensure("contribution", (host) => mountContributionRuntime(host, [
    contributionPlugin("test:shared-root", [testContribution])
  ]));
  const messageRuntime = await root.ensure("message", (host) => mountMessageAdapterRuntime(host, [
    messageDefinition(
      () => { activeMessageAdapters += 1; },
      () => { activeMessageAdapters -= 1; }
    )
  ]));
  await messageRuntime.mount("heartbeat");

  let probeMatched = false;
  await root.host.mount({
    name: "test:three-registries",
    inject: [
      AGENT_ADAPTER_REGISTRY_SERVICE,
      MESSAGE_ADAPTER_REGISTRY_SERVICE,
      CONTRIBUTION_REGISTRY_SERVICE
    ],
    apply(ctx) {
      probeMatched = ctx.get(AGENT_ADAPTER_REGISTRY_SERVICE, true) === agentRuntime.registry
        && ctx.get(MESSAGE_ADAPTER_REGISTRY_SERVICE, true) === messageRuntime.registry
        && ctx.get(CONTRIBUTION_REGISTRY_SERVICE, true) === contributionRuntime.registry;
    }
  });

  assert.equal(probeMatched, true);
  assert.equal(activeMessageAdapters, 1);
  assert.equal(contributionRuntime.registry.catalog().contributions.length, 1);

  await root.dispose();
  assert.equal(activeMessageAdapters, 0);
  assert.deepEqual(agentRuntime.registry.listManifests(), []);
  assert.deepEqual(messageRuntime.registry.listManifests(), []);
  assert.deepEqual(contributionRuntime.registry.catalog().contributions, []);
});

test("Gateway Cordis root disposal is idempotent and blocks new initialization", async () => {
  const root = createGatewayCordisRoot();
  let releases = 0;
  await root.host.mount({
    name: "test:root-dispose",
    apply(ctx) {
      ctx.effect(() => () => { releases += 1; });
    }
  });

  const first = root.dispose();
  const second = root.dispose();
  assert.strictEqual(first, second);
  await assert.rejects(
    root.ensure("late", async () => "late"),
    /Gateway Cordis root is disposing/
  );
  await first;
  assert.equal(root.disposed, true);
  assert.equal(releases, 1);
  await root.dispose();
  assert.equal(releases, 1);
});
