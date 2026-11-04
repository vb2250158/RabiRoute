import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mountAgentPluginRuntime } from "./agentPluginRuntime.js";
import { createAgentAdapterHostPorts } from "./agentAdapterHostPorts.js";
import { publishedAgentAdapterProviders } from "./agentAdapterProviders.js";
test("a missing descriptor or removed host in a bad Agent update retains the exact prior owner and healthy sibling", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subgraph-"));
    let runtime: Awaited<ReturnType<typeof mountAgentPluginRuntime>> | undefined;
    try {
        const instances = [];
        for (const name of ["first", "second"]) {
            const packageId = `io.fixture.${name}`, directory = path.join(root, "packages", packageId, "1.0.0");
            await fs.mkdir(directory, { recursive: true });
            await fs.cp("plugins/contracts/plugin-sdk", path.join(directory, "sdk"), { recursive: true });
            const capability = `agent.adapter.${name}@1`;
            await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: packageId, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [capability], requires: ["host.agent-adapters@1"], optional: [], permissions: [] }));
            await fs.writeFile(path.join(directory, "agent-adapter.json"), JSON.stringify({ type: name, capability, manifest: { type: name, label: name, maturity: "experimental", transport: { protocol: "fixture", mode: "fixture" }, capabilities: {} }, sessionBinding: { sessionId: "originalField" } }));
            await fs.writeFile(path.join(directory, "manager.mjs"), `import {ownAgentAdapter} from './sdk/index.mjs';import fs from 'node:fs/promises';export async function activate(context){const descriptor=JSON.parse(await fs.readFile(new URL('./agent-adapter.json',import.meta.url),'utf8'));ownAgentAdapter(context,{...descriptor,operations:{read:()=>({owner:context.identity.activationId,binding:descriptor.sessionBinding})}});}`);
            instances.push({ id: name, package: packageId, version: "1.0.0", enabled: true, config: {}, grants: [] });
        }
        const profilePath = path.join(root, "profile.json");
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances }));
        runtime = await mountAgentPluginRuntime({ host: "manager", profilePath, settingsRoot: path.join(root, "settings"), packageRoots: [path.join(root, "packages")], runtimeRoot: path.join(root, "runtime"), hostPorts: createAgentAdapterHostPorts(), watch: false });
        const read = () => publishedAgentAdapterProviders(runtime!.current());
        const first = read().get("first")!, second = read().get("second")!;
        assert.ok(first);
        assert.ok(second);
        await fs.rm(path.join(root, "packages/io.fixture.first/1.0.0/agent-adapter.json"));
        await runtime.reconcile();
        assert.equal(read().get("first")!.identity.activationId, first.identity.activationId);
        assert.equal(read().get("second")!.identity.activationId, second.identity.activationId);
        assert.deepEqual(await read().get("first")!.invoke("read", {}), { owner: first.identity.activationId, binding: { sessionId: "originalField" } });
        assert.ok(runtime.diagnostics().some(item => item.instanceId === "first"));
        const manifestPath = path.join(root, "packages/io.fixture.first/1.0.0/rabi.plugin.json");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        manifest.entries = { web: { execution: "in_process", module: "./manager.mjs" } };
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        await runtime.reconcile();
        assert.equal(read().get("first")!.identity.activationId, first.identity.activationId);
        assert.equal(read().get("second")!.identity.activationId, second.identity.activationId);
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: instances.map(item => ({ ...item, enabled: item.id !== "first" })) }));
        await runtime.reconcile();
        assert.equal(read().has("first"), false);
        assert.equal(read().get("second")!.identity.activationId, second.identity.activationId);
    }
    finally {
        await runtime?.dispose();
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("whole-node cancellation joins entered Agent activation and never publishes its candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subgraph-abort-"));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { enter = done; });
    const held = new Promise<void>(done => { release = done; });
    const key = `agent-subgraph-${Date.now()}`;
    const globals = globalThis as unknown as Record<string, unknown>;
    let retired = false, published = false;
    globals[key] = { enter, held, retire: () => { retired = true; }, publish: () => { published = true; } };
    const controller = new AbortController();
    try {
        const directory = path.join(root, "packages/io.fixture.cancelled/1.0.0");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.fixture.cancelled", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: ["agent.adapter.cancelled@1"], requires: [], optional: [], permissions: [] }));
        await fs.writeFile(path.join(directory, "agent-adapter.json"), JSON.stringify({ type: "cancelled", capability: "agent.adapter.cancelled@1", manifest: { type: "cancelled", label: "Cancelled", maturity: "experimental", transport: { protocol: "fixture", mode: "fixture" }, capabilities: {} }, sessionBinding: {} }));
        await fs.writeFile(path.join(directory, "manager.mjs"), `export async function activate(context){const gate=globalThis[${JSON.stringify(key)}];context.effects.adopt(gate.retire);context.services.provide('agent.adapter.cancelled@1',{});context.publication.add({publish:gate.publish,rollback(){}});gate.enter();await gate.held;}`);
        const profilePath = path.join(root, "profile.json");
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "cancelled", package: "io.fixture.cancelled", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
        let completed = false;
        const mounting = mountAgentPluginRuntime({ host: "manager", profilePath, settingsRoot: path.join(root, "settings"), packageRoots: [path.join(root, "packages")], runtimeRoot: path.join(root, "runtime"), hostPorts: createAgentAdapterHostPorts(), watch: false, signal: controller.signal });
        void mounting.finally(() => { completed = true; }).catch(() => {});
        await entered;
        const reason = new Error("Original whole-node shutdown"); controller.abort(reason);
        await new Promise<void>(done => setImmediate(done));
        assert.equal(completed, false, "Entered real activation must settle before its owner is released.");
        assert.equal(retired, false); assert.equal(published, false);
        release();
        await assert.rejects(mounting, error => error === reason);
        assert.equal(retired, true); assert.equal(published, false);
    } finally {
        release(); delete globals[key]; await fs.rm(root, { recursive: true, force: true });
    }
});
