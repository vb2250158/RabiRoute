import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayMessageAdapterType } from "./adapters/messageAdapter.js";
import { AGENT_ADAPTER_REGISTRY_SERVICE, AgentAdapterRegistry } from "./runtime/agentAdapterRuntime.js";
import { ContributionRegistry } from "./runtime/contributionRegistry.js";
import { CONTRIBUTION_REGISTRY_SERVICE } from "./runtime/contributionRuntime.js";
import { getBuiltinGatewayCordisRoot } from "./runtime/gatewayCordisRoot.js";
import { MESSAGE_ADAPTER_REGISTRY_SERVICE, MessageAdapterRegistry } from "./runtime/messageAdapterRuntime.js";
import {
  startGatewayMain,
  type GatewayProcessLifecycle
} from "./gatewayMain.js";

type LifecycleEvent = "SIGINT" | "SIGTERM" | "beforeExit";
type LifecycleListener = () => void;

class FakeProcessLifecycle implements GatewayProcessLifecycle {
  private readonly listeners = new Map<LifecycleEvent, Set<LifecycleListener>>();

  once(event: LifecycleEvent, listener: LifecycleListener): void {
    const listeners = this.listeners.get(event) ?? new Set<LifecycleListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: LifecycleEvent, listener: LifecycleListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: LifecycleEvent): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    this.listeners.delete(event);
    for (const listener of listeners) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

test("resident Gateway mounts all registries in one root and disposes once", async () => {
  const root = getBuiltinGatewayCordisRoot();
  const lifecycle = new FakeProcessLifecycle();
  let reporterStarts = 0;
  let reporterStops = 0;
  const options = {
    adapterTypes: [],
    processLifecycle: lifecycle,
    startPerformanceReporter: () => {
      reporterStarts += 1;
      return () => { reporterStops += 1; };
    }
  };

  const firstStart = startGatewayMain(options);
  const secondStart = startGatewayMain(options);
  assert.strictEqual(firstStart, secondStart);
  const runtime = await firstStart;
  assert.strictEqual(await secondStart, runtime);

  assert.strictEqual(runtime.root, root);
  assert.strictEqual(
    root.host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true),
    runtime.agentAdapters.registry
  );
  assert.strictEqual(
    root.host.context.get(MESSAGE_ADAPTER_REGISTRY_SERVICE, true),
    runtime.messageAdapters.registry
  );
  assert.strictEqual(
    root.host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true),
    runtime.contributions.registry
  );
  assert.ok(runtime.agentAdapters.registry instanceof AgentAdapterRegistry);
  assert.ok(runtime.messageAdapters.registry instanceof MessageAdapterRegistry);
  assert.ok(runtime.contributions.registry instanceof ContributionRegistry);
  assert.equal(reporterStarts, 1);
  assert.equal(lifecycle.listenerCount(), 3);

  await runtime.agentAdapters.unmount();
  assert.deepEqual(runtime.agentAdapters.registry.listManifests(), []);
  assert.ok(runtime.messageAdapters.registry.listManifests().length > 0);
  assert.equal(root.disposed, false);

  lifecycle.emit("SIGTERM");
  lifecycle.emit("SIGINT");
  await runtime.dispose();
  await runtime.dispose();

  assert.equal(root.disposed, true);
  assert.equal(reporterStops, 1);
  assert.equal(lifecycle.listenerCount(), 0);
  assert.deepEqual(runtime.messageAdapters.registry.listManifests(), []);
  assert.deepEqual(runtime.contributions.registry.catalog().contributions, []);
});

test("Gateway startup failure disposes the shared root before reporting ready", async () => {
  const root = getBuiltinGatewayCordisRoot();
  const lifecycle = new FakeProcessLifecycle();
  let reporterStarts = 0;

  await assert.rejects(
    startGatewayMain({
      adapterTypes: ["unsupported" as GatewayMessageAdapterType],
      processLifecycle: lifecycle,
      startPerformanceReporter: () => {
        reporterStarts += 1;
        return () => {};
      }
    }),
    /Unsupported message adapter: unsupported/
  );

  assert.equal(root.disposed, true);
  assert.equal(reporterStarts, 0);
  assert.equal(lifecycle.listenerCount(), 0);
});
