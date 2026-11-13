import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewayMessageAdapterType } from "./adapters/messageAdapter.js";
import { AGENT_ADAPTER_REGISTRY_SERVICE, AgentAdapterRegistry } from "./runtime/agentAdapterRuntime.js";
import { ContributionRegistry } from "./runtime/contributionRegistry.js";
import { CONTRIBUTION_REGISTRY_SERVICE } from "./runtime/contributionRuntime.js";
import { getBuiltinGatewayCordisRoot } from "./runtime/gatewayCordisRoot.js";
import { MESSAGE_ADAPTER_REGISTRY_SERVICE, MessageAdapterRegistry } from "./runtime/messageAdapterRuntime.js";
import {
  installGatewayCrashHandlers,
  startGatewayMain,
  type GatewayProcessLifecycle
} from "./gatewayMain.js";

type LifecycleEvent = "SIGINT" | "SIGTERM" | "beforeExit";
type LifecycleListener = () => void;
let fixtureRoot: string;
let endpointPlugins: { profilePath: string; settingsRoot: string; packageRoots: string[]; runtimeRoot: string; watch: boolean };
test.before(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-main-profile-"));
  const profilePath = path.join(fixtureRoot, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [] }));
  endpointPlugins = { profilePath, settingsRoot: path.join(fixtureRoot, "settings"), packageRoots: [path.join(fixtureRoot, "packages")], runtimeRoot: path.join(fixtureRoot, "runtime"), watch: false };
});
test.after(async () => { await fs.rm(fixtureRoot, { recursive: true, force: true }); });

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
    endpointPlugins,
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
  assert.deepEqual(runtime.messageAdapters.registry.listManifests(), [], "The generic Gateway does not statically register platform factories.");
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

test("an unavailable endpoint does not dispose shared Gateway services", async () => {
  const root = getBuiltinGatewayCordisRoot();
  const lifecycle = new FakeProcessLifecycle();
  let reporterStarts = 0;

  const runtime = await startGatewayMain({
      endpointPlugins,
      adapterTypes: ["unsupported" as GatewayMessageAdapterType],
      processLifecycle: lifecycle,
      startPerformanceReporter: () => {
        reporterStarts += 1;
        return () => {};
      }
    });

  assert.equal(root.disposed, false);
  assert.equal(reporterStarts, 1);
  assert.equal(lifecycle.listenerCount(), 3);
  await runtime.dispose();
});

test("a missing shared profile fails Gateway startup and releases its root", async () => {
  const root = getBuiltinGatewayCordisRoot();
  const lifecycle = new FakeProcessLifecycle();
  let reporterStarts = 0;
  await assert.rejects(startGatewayMain({ endpointPlugins: { ...endpointPlugins, profilePath: path.join(fixtureRoot, "missing.json") },
    adapterTypes: [], processLifecycle: lifecycle, startPerformanceReporter() { reporterStarts += 1; return () => {}; }
  }), /ENOENT/);

  assert.equal(root.disposed, true);
  assert.equal(reporterStarts, 0);
  assert.equal(lifecycle.listenerCount(), 0);
});

test("gateway crash handlers record the stack, flush once and exit once", async () => {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const processEvents = {
    on(event: string, listener: (...args: never[]) => void): void {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event: string, listener: (...args: never[]) => void): void {
      listeners.get(event)?.delete(listener);
    }
  } as unknown as Pick<NodeJS.Process, "on" | "removeListener">;

  const recorded: Array<{ event: string; error: { stack?: string } | undefined }> = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  let flushes = 0;
  const uninstall = installGatewayCrashHandlers({
    stateRoot: path.join(os.tmpdir(), "gateway-crash-fixture"),
    record: (event, error) => recorded.push({ event, error }),
    flush: async () => { flushes += 1; },
    exit: code => exitCodes.push(code),
    writeStderr: text => stderr.push(text),
    crashExitDelayMs: 60_000
  }, processEvents);

  const failure = new Error("gateway probe failure");
  for (const listener of listeners.get("uncaughtException") ?? []) {
    (listener as unknown as (error: Error) => void)(failure);
  }
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.event, "gateway_uncaught_exception");
  assert.match(recorded[0]?.error?.stack ?? "", /gateway probe failure/);
  assert.match(stderr[0] ?? "", /gateway probe failure/);
  assert.equal(flushes, 1);
  assert.deepEqual(exitCodes, [1]);

  for (const listener of listeners.get("unhandledRejection") ?? []) {
    (listener as unknown as (reason: unknown) => void)("late rejection");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  assert.deepEqual(exitCodes, [1]);

  uninstall();
  assert.equal(listeners.get("uncaughtException")?.size, 0);
  assert.equal(listeners.get("unhandledRejection")?.size, 0);
});

test("gateway crash handler exits once if flush throws synchronously", async () => {
  const listeners = new Map<string, (...args: never[]) => void>();
  const events = {
    on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); },
    removeListener(event: string) { listeners.delete(event); }
  } as unknown as Pick<NodeJS.Process, "on" | "removeListener">;
  const exitCodes: number[] = [];
  const uninstall = installGatewayCrashHandlers({
    stateRoot: os.tmpdir(),
    record: () => {},
    flush: () => { throw new Error("flush failure"); },
    exit: code => exitCodes.push(code),
    writeStderr: () => {},
    crashExitDelayMs: 20
  }, events);
  const fail = listeners.get("uncaughtException") as unknown as (error: Error) => void;
  fail(new Error("gateway failure"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(exitCodes, [1]);
  uninstall();
});
