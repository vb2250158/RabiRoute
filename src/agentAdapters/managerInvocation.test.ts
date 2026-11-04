import assert from "node:assert/strict";
import test from "node:test";
import { ownAgentAdapter } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { invokeAgentManagerOperation, resolvePublishedAgentManagerProviders, createPublishedAgentServiceEndpointBridge, createPublishedAgentDeviceEndpointBridge } from "../manager/agentManagerProviders.js";
import { bridgeOperations } from "./managerNativeOperations.js";
import { withAgentManagerInvocation, invokeScopedAgentManagerOperation } from "./managerInvocation.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const events: string[] = [];
  let published = gate();
  const kernel = new GenerationRuntime({ host: "manager", executor: { async prepare(candidate) { return modules.get(candidate)!; } }, onPublished() { published.resolve(); } });
  function candidate(revision: string, type = "fixture"): PluginCandidate {
    const item: PluginCandidate = { instanceId: `owner:${type}`, revision, config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: `io.fixture.${type}`, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [`agent.adapter.${type.toLowerCase()}@1`], requires: [], optional: [], permissions: [] } };
    modules.set(item, { activate(context) {
      const bridge = {
        handlesSource: (request: { messageSource?: { agentAdapter?: string } }, principal?: { provider?: string; deviceOwner?: boolean }) =>
          request.messageSource?.agentAdapter === type || principal?.provider === type || type === "deviceAgent" && principal?.deviceOwner === true,
        handlesTarget: (request: { agentAdapter?: string }) => request.agentAdapter === type,
        owns: (endpoint: { provider: string }) => endpoint.provider === type,
        resolveSource: async () => undefined,
        resolveTarget: async () => { events.push(`${revision}:resolve`); return { endpoint: { kind: "service", provider: type }, threadId: "original-session" }; },
        authorize() { events.push(`${revision}:authorize`); },
        refresh: async () => { events.push(`${revision}:refresh`); },
        resolveExecutionOptions: () => { events.push(`${revision}:options`); return {}; },
        transport: async (_delivery: unknown, guard: () => void) => { guard(); events.push(`${revision}:transport`); return { accepted: true }; }
      };
      ownAgentAdapter(context, { type, capability: `agent.adapter.${type.toLowerCase()}@1`, manifest: {
        type, label: type, maturity: "experimental", transport: { protocol: "fixture", mode: "original-owner" }, capabilities: {}
      }, operations: {
        read: () => { events.push(`${revision}:read`); return "original-session"; },
        send: payload => { assert.equal(payload.id, "original-session"); events.push(`${revision}:send`); },
        fail: () => { throw new Error("original native failure"); },
        ...bridgeOperations("service", bridge), ...bridgeOperations("device", bridge)
      }, ...(type === "codex" ? {} : { serviceEndpoint: bridge, deviceEndpoint: bridge }), dispose() { events.push(`${revision}:dispose`); } });
    } });
    return item;
  }
  return { kernel, candidate, events, nextPublication() { published = gate(); return published.promise; } };
}

for (const mode of ["replace", "disable"] as const) {
  test(`one host request retains its original native provider through ${mode} and its ledger tail`, async () => {
    const f = fixture();
    await f.kernel.switch([f.candidate("A")]);
    const original = resolvePublishedAgentManagerProviders(f.kernel.current())[0]!;
    const read = gate(), resume = gate();
    let captures = 0;
    const context = {
      getProviders: () => { captures++; return resolvePublishedAgentManagerProviders(f.kernel.current()); },
      invokeAgentOperation: <T = unknown>(type: string, operation: string, payload: unknown, invocation?: import("@rabiroute/plugin-sdk").AgentAdapterInvocation) => invokeAgentManagerOperation<T>(f.kernel.current(), type, operation, payload, invocation)
    };
    const request = withAgentManagerInvocation(context, async () => {
      const id = await invokeScopedAgentManagerOperation<string>("fixture", "read", {});
      read.resolve();
      await resume.promise;
      await withAgentManagerInvocation(context, () => context.invokeAgentOperation("fixture", "send", { id }));
      await Promise.resolve();
      f.events.push("host:ledger-tail");
      assert.equal(original.inspect().activeLeases, 1);
    });
    await read.promise;
    const published = f.nextPublication();
    const updating = f.kernel.switch(mode === "replace" ? [f.candidate("B")] : []);
    await published;
    assert.equal(original.inspect().activeLeases, 1);
    assert.equal(f.events.includes("A:dispose"), false);
    await assert.rejects(withAgentManagerInvocation(context, async () => invokeScopedAgentManagerOperation("fixture", "send", { id: "original-session" })), /not ready|unavailable/);
    resume.resolve();
    await request;
    await updating;
    assert.equal(captures, 2, "nested primitives reuse the one original generation capture");
    assert.deepEqual(f.events.slice(0, 4), ["A:read", "A:send", "host:ledger-tail", "A:dispose"]);
    assert.equal(original.inspect().activeLeases, 0);
    if (mode === "replace") {
      await withAgentManagerInvocation(context, async () => invokeScopedAgentManagerOperation("fixture", "send", { id: "original-session" }));
      assert.equal(f.events.at(-1), "B:send");
    }
    await f.kernel.shutdown();
  });
}

for (const kind of ["service", "device"] as const) {
  test(`${kind} resolve, synchronous proof and transport retain one native owner until the original request releases`, async () => {
    const f = fixture();
    await f.kernel.switch([f.candidate("A")]);
    const context = {
      getProviders: () => resolvePublishedAgentManagerProviders(f.kernel.current()),
      invokeAgentOperation: <T = unknown>(type: string, operation: string, payload: unknown, invocation?: import("@rabiroute/plugin-sdk").AgentAdapterInvocation) => invokeAgentManagerOperation<T>(f.kernel.current(), type, operation, payload, invocation)
    };
    const bridge = kind === "service" ? createPublishedAgentServiceEndpointBridge(() => f.kernel.current()) : createPublishedAgentDeviceEndpointBridge(() => f.kernel.current());
    const resolved = gate(), resume = gate();
    const request = withAgentManagerInvocation(context, async () => {
      const target = await bridge.resolveTarget({ agentAdapter: "fixture", action: "read" });
      resolved.resolve(); await resume.promise;
      bridge.authorize(target!.endpoint!);
      await bridge.refresh?.(target!.endpoint!);
      await bridge.transport({ target: target!.endpoint } as Parameters<typeof bridge.transport>[0], () => {}, false);
    });
    await resolved.promise;
    const published = f.nextPublication();
    const updating = f.kernel.switch([f.candidate("B")]);
    await published;
    resume.resolve(); await request; await updating;
    assert.deepEqual(f.events, ["A:resolve", "A:authorize", "A:refresh", "A:transport", "A:dispose"]);
    await assert.rejects(withAgentManagerInvocation(context, async () => invokeScopedAgentManagerOperation("fixture", "fail", {})), /original native failure/);
    assert.equal(resolvePublishedAgentManagerProviders(f.kernel.current())[0]!.inspect().activeLeases, 0);
    await f.kernel.shutdown();
  });
}

test("unrelated service and Device plugins take no leases and can retire during a Codex host request", async () => {
  const f = fixture();
  const codex = f.candidate("A", "codex");
  await f.kernel.switch([codex, f.candidate("Grok", "grokBot"), f.candidate("Device", "deviceAgent")]);
  const providers = resolvePublishedAgentManagerProviders(f.kernel.current());
  const entered = gate(), resume = gate();
  const context = { getProviders: () => resolvePublishedAgentManagerProviders(f.kernel.current()) };
  const service = createPublishedAgentServiceEndpointBridge(() => f.kernel.current());
  const device = createPublishedAgentDeviceEndpointBridge(() => f.kernel.current());
  const request = withAgentManagerInvocation(context, async () => {
    await invokeScopedAgentManagerOperation("codex", "read", {});
    const source = { action: "send" as const, agentAdapter: "codex", sourceThreadId: "source", messageSource: { type: "agent" as const, agentAdapter: "codex", sessionId: "source", sessionName: "Source", agentType: "agent" } };
    assert.equal(await service.resolveSource(source), undefined);
    assert.equal(await service.resolveTarget(source), undefined);
    assert.equal(await device.resolveSource(source), undefined);
    assert.equal(await device.resolveTarget(source), undefined);
    assert.deepEqual(providers.filter(provider => provider.type !== "codex").map(provider => provider.inspect().activeLeases), [0, 0]);
    entered.resolve(); await resume.promise;
    await invokeScopedAgentManagerOperation("codex", "send", { id: "original-session" });
  });
  await entered.promise;
  await f.kernel.switch([codex]);
  assert.equal(f.events.includes("Grok:dispose"), true);
  assert.equal(f.events.includes("Device:dispose"), true);
  assert.equal(f.events.includes("A:dispose"), false);
  resume.resolve(); await request;
  assert.equal(f.events.at(-1), "A:send");
  await f.kernel.shutdown();
});
