import assert from "node:assert/strict";
import test from "node:test";
import { ownAgentAdapter } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { resolveAgentAdapterProviders } from "./agentAdapterProviders.js";
import { AgentAdapterRegistry } from "./agentAdapterRuntime.js";
import { createAgentAdapterHostPorts } from "./agentAdapterHostPorts.js";
import { installAgentAdapterManifestReader, agentAdapterSupportsManagedTaskFeature } from "../shared/agentAdapterCapabilities.js";
import { normalizeAgentAdapters } from "../agentAdapters/types.js";
test("native providers isolate duplicate wire types and retain healthy third-party capabilities", async () => {
    const modules = new WeakMap<PluginCandidate, PluginModule>();
    let calls = 0;
    const make = (id: string, type: string, capability: string): PluginCandidate => {
        const result: PluginCandidate = { instanceId: id, revision: "one", config: {}, entry: { execution: "in_process", path: "fixture.mjs" }, manifest: { schemaVersion: 2, id: `io.fixture.${id}`, version: "1.0.0", entries: { gateway: { execution: "in_process", module: "./gateway.mjs" } }, provides: [capability], requires: [], optional: [], permissions: [] } };
        modules.set(result, { activate(context) {
                // A faulty third-party author can use distinct contribution IDs while claiming one wire type.
                const scope = { ...context, contributions: { register(contribution: Parameters<typeof context.contributions.register>[0]) { context.contributions.register({ ...contribution, id: `agent.${id}.provider` }); } } };
                ownAgentAdapter(scope, { type, capability, manifest: { type, label: type, maturity: "experimental", transport: { protocol: "fixture", mode: "original-owner" }, capabilities: { managedTasks: { agentThreads: true } } }, operations: { deliver() { calls++; } } });
            } });
        return result;
    };
    const bad1 = make("bad-one", "conflicting", "fixture.first@1"), good = make("healthy", "thirdParty.id", "fixture.healthy@1"), bad2 = make("bad-two", "conflicting", "fixture.second@1");
    const runtime = new GenerationRuntime({ host: "gateway", executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
    const registry = new AgentAdapterRegistry();
    registry.bindGeneration(() => runtime.current());
    const restore = installAgentAdapterManifestReader(() => registry.listManifests());
    try {
        await runtime.switch([bad1, good, bad2]);
        const result = resolveAgentAdapterProviders(runtime.current());
        assert.deepEqual([...result.providers.keys()], ["thirdParty.id"]);
        assert.deepEqual(result.diagnostics.map(item => item.instanceId).sort(), ["bad-one", "bad-two"]);
        assert.throws(() => registry.create("conflicting"), /Unsupported/);
        assert.equal(agentAdapterSupportsManagedTaskFeature("thirdParty.id", "agentThreads"), true);
        assert.deepEqual(normalizeAgentAdapters(["thirdParty.id"]), ["thirdParty.id"]);
        const activation = result.providers.get("thirdParty.id")!.identity.activationId;
        await registry.create("thirdParty.id").deliver({ messageSource: { type: "system", eventId: "original", eventType: "fixture", eventName: "fixture" }, messageContent: "test" });
        assert.equal(calls, 1);
        await runtime.switch([good]);
        assert.equal(resolveAgentAdapterProviders(runtime.current()).providers.get("thirdParty.id")!.identity.activationId, activation);
        await runtime.switch([]);
        assert.equal(agentAdapterSupportsManagedTaskFeature("thirdParty.id", "agentThreads"), false);
    }
    finally {
        restore();
        await runtime.shutdown();
    }
});
test("lazy shared-port failure affects only Agent packages that request that port", async () => {
    let healthy = 0, bad = 0;
    const host = createAgentAdapterHostPorts({ loaders: {
            "fixture/failed": async () => { bad++; throw new Error("broken optional owner"); },
            "fixture/healthy": async () => { healthy++; return { originalOwner: { id: "one" } }; }
        } });
    await host.prepareModules(["fixture/healthy"]);
    assert.equal(bad, 0);
    assert.equal(healthy, 1);
    const owner = host.module<{
        originalOwner: object;
    }>("fixture/healthy").originalOwner;
    await assert.rejects(host.prepareModules(["fixture/failed"]), /broken optional owner/);
    assert.strictEqual(host.module<{
        originalOwner: object;
    }>("fixture/healthy").originalOwner, owner);
});
test("a malformed package-owned descriptor cannot publish or break a healthy Agent", async () => {
    const modules = new WeakMap<PluginCandidate, PluginModule>();
    const make = (id: string, manifest: unknown): PluginCandidate => {
        const candidate: PluginCandidate = { instanceId: id, revision: "one", config: {}, entry: { execution: "in_process", path: "fixture.mjs" }, manifest: { schemaVersion: 2, id: `io.fixture.${id}`, version: "1.0.0", entries: { gateway: { execution: "in_process", module: "./gateway.mjs" } }, provides: [`fixture.${id}@1`], requires: [], optional: [], permissions: [] } };
        modules.set(candidate, { activate(context) { ownAgentAdapter(context, { type: id, capability: `fixture.${id}@1`, manifest: JSON.parse(JSON.stringify(manifest)), sessionBinding: { sessionId: "originalField" }, operations: { deliver() { } } }); } });
        return candidate;
    };
    const healthy = make("healthy", { type: "healthy", label: "Healthy", maturity: "verified", transport: { protocol: "fixture", mode: "fixture" }, capabilities: {} });
    const broken = make("broken", { type: "broken", label: "Broken", maturity: "verified", transport: null, capabilities: {} });
    const runtime = new GenerationRuntime({ host: "gateway", executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
    try {
        await runtime.switch([broken, healthy]);
        const result = resolveAgentAdapterProviders(runtime.current());
        assert.deepEqual([...result.providers.keys()], ["healthy"]);
        assert.ok(runtime.current().records.find(record => record.identity.instanceId === "broken")?.error);
        const binding = result.providers.get("healthy")!.sessionBinding;
        assert.equal(Object.isFrozen(binding), true);
        assert.equal(binding.sessionId, "originalField");
        const contribution = runtime.current().contributions.contributions.find(item => item.kind === "agent-adapter");
        assert.deepEqual((contribution?.value as {
            sessionBinding: unknown;
        }).sessionBinding, binding);
    }
    finally {
        await runtime.shutdown();
    }
});
