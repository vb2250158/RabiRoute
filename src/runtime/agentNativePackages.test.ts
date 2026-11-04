import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentAdapterRegistry } from "./agentAdapterRuntime.js";
import { createAgentAdapterHostPorts } from "./agentAdapterHostPorts.js";
import { RabiCordisHost } from "./cordisHost.js";
import { mountGatewayEndpointPlugins } from "./gatewayEndpointPlugins.js";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { dispatchToAgentAdapter } from "../forwarding.js";
import { nativeHttpTestFetch } from "../manager/nativeHttpTestClient.js";
import { classifyRouteChange, readEndpointRouteDeclarations } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
    const end = Date.now() + 20000;
    while (!check()) {
        if (Date.now() > end)
            throw new Error("Native Agent publication did not settle.");
        await new Promise(done => setTimeout(done, 10));
    }
}
const envelope = { deliveryId: "original-delivery", messageSource: { type: "system" as const, eventType: "fixture", eventName: "Fixture", eventId: "original-event" }, messageContent: "isolated test input" };
test("physical Agent packages retain one Gateway and unrelated in-flight work across scoped save, disable, update and failure", { timeout: 120000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "native-agents-"));
    const host = new RabiCordisHost(), registry = new AgentAdapterRegistry();
    const deviceEntered = gate(), finishDevice = gate(), astrbotEntered = gate(), finishAstrbot = gate();
    let holdAstrbot = false, holdDevice = true;
    const requests: Array<{
        url: string;
        body: any;
    }> = [];
    const server = http.createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request)
            raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ url: request.url!, body });
        if (request.url === "/api/auth/login") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: { token: "fixture-token" } }));
            return;
        }
        if (request.url === "/api/chat/send") {
            if (holdAstrbot) {
                astrbotEntered.resolve();
                await finishAstrbot.promise;
            }
            response.end('data: {"type":"plain","data":"fixture reply"}\n');
            return;
        }
        if (request.url?.startsWith("/api/device-agents/")) {
            if (holdDevice) {
                deviceEntered.resolve();
                await finishDevice.promise;
            }
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ code: 0, data: { receipt: { ownerAccepted: true, status: "accepted" } } }));
            return;
        }
        response.statusCode = 404;
        response.end();
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    const environment = { ASTRBOT_URL: origin, ASTRBOT_USERNAME: "fixture-user", ASTRBOT_PASSWORD: "fixture-original", ASTRBOT_SESSION_ID: "original-session", GATEWAY_MANAGER_URL: origin, LAN_AGENT_ACCESS_TOKEN: "fixture-access", DATA_DIR: path.join(temporary, "data") };
    const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input, init) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); return url.origin === origin ? nativeHttpTestFetch(url, init) : originalFetch(input, init); }) as typeof fetch;
    try {
        // Uses the production package builder and original platform source, never a host platform factory.
        // @ts-expect-error JavaScript build entry is outside src.
        const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
        const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.agent.astrbot", "io.rabiroute.agent.device-agent"], outputDirectory: path.join(temporary, "built") });
        const profilePath = path.join(temporary, "profile.json"), settingsRoot = path.join(temporary, "settings");
        const instance = (slug: string) => ({ id: `agent:${slug}`, package: `io.rabiroute.agent.${slug}`, version: "1.0.0", enabled: true, config: {}, grants: [] });
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [instance("astrbot"), instance("device-agent")] }));
        const settings = new PluginProfileSettings({ profilePath, settingsRoot });
        const boot = { id: "native-agent-route", enabled: true, gatewayPort: 8789, messageAdapters: [], agentAdapters: ["astrbot", "deviceAgent"], astrbotUrl: origin, astrbotUsername: "fixture-user", astrbotPassword: "fixture-original", astrbotSessionId: "original-session" };
        const runtime = await mountGatewayEndpointPlugins(host, { profilePath, settingsRoot, packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: [], agentRegistry: registry, initialRouteDefinition: boot,
            agentHostPorts: createAgentAdapterHostPorts({ loaders: { "agentAdapters/stateReporter": async () => ({ reportAgentState() { } }) } }) });
        const activation = (slug: string) => runtime.current().records.find(record => record.identity.instanceId === `agent:${slug}`)?.identity.activationId;
        assert.equal(runtime.current().records.every(record => record.status === "active"), true, JSON.stringify(runtime.current().records));
        const deviceActivation = activation("device-agent"), astrbotActivation = activation("astrbot"), pid = process.pid;
        const binding = { instanceId: "original-device", agentId: "original-device-agent" };
        const inFlight = registry.create("deviceAgent", binding).deliver(envelope);
        await deviceEntered.promise;
        const changed = { ...boot, astrbotPassword: "fixture-new", astrbotSessionId: "new-session" };
        await runtime.applyRouteSnapshot(changed, "scoped-agent-change");
        assert.equal(process.pid, pid);
        assert.equal(activation("device-agent"), deviceActivation);
        assert.notEqual(activation("astrbot"), astrbotActivation);
        await dispatchToAgentAdapter("astrbot", envelope, [], { id: "local:astrbot", provider: "astrbot" }, async (type, target) => registry.create(type, typeof target === "object" ? target.binding : undefined));
        assert.equal(requests.find(request => request.url === "/api/auth/login")?.body.password, "fixture-new");
        assert.equal(requests.find(request => request.url === "/api/chat/send")?.body.session_id, "new-session");
        const loginCount = requests.filter(request => request.url === "/api/auth/login").length;
        await runtime.applyRouteSnapshot({ ...changed, astrbotPassword: "" }, "clear-agent-secret");
        await assert.rejects(registry.create("astrbot").deliver(envelope), /ASTRBOT_PASSWORD/);
        assert.equal(requests.filter(request => request.url === "/api/auth/login").length, loginCount, "An empty secret cannot fall back to the previous activation or environment.");
        assert.equal(activation("device-agent"), deviceActivation);
        await runtime.applyRouteSnapshot(changed, "restore-agent-secret");
        holdDevice = false;
        finishDevice.resolve();
        await inFlight;
        assert.equal(requests.find(request => request.url?.startsWith("/api/device-agents/"))?.body.deliveryId, envelope.deliveryId);
        holdAstrbot = true;
        const retained = registry.create("astrbot"), accepted = retained.deliver(envelope);
        await astrbotEntered.promise;
        let snapshot = await settings.snapshot();
        await settings.update("agent:astrbot", { expectedRevision: snapshot.revision, enabled: false });
        await until(() => !registry.manifest("astrbot"));
        await assert.rejects(retained.deliver(envelope), /retiring|not ready|disabled/);
        assert.equal(activation("device-agent"), deviceActivation);
        finishAstrbot.resolve();
        await accepted;
        await runtime.reconcile();
        assert.equal(runtime.current().cleanupDiagnostics.length, 0);
        const changedWhileDisabled = { ...changed, astrbotSessionId: "disabled-owner-new-session" };
        await runtime.applyRouteSnapshot(changedWhileDisabled, "disabled-agent-owned-field");
        assert.equal(activation("device-agent"), deviceActivation);
        assert.equal(registry.manifest("astrbot"), undefined);
        snapshot = await settings.snapshot();
        await settings.update("agent:astrbot", { expectedRevision: snapshot.revision, enabled: true });
        await until(() => Boolean(registry.manifest("astrbot")));
        await registry.create("astrbot").deliver(envelope);
        assert.equal(requests.filter(request => request.url === "/api/chat/send").at(-1)?.body.session_id, "disabled-owner-new-session");
        const beforeUpdate = activation("astrbot");
        const gatewayFile = path.join(built.packagesRoot, "io.rabiroute.agent.astrbot/1.0.0/gateway.mjs");
        await fs.appendFile(gatewayFile, "\n// independently updated Agent package\n");
        await runtime.reconcile();
        assert.notEqual(activation("astrbot"), beforeUpdate);
        assert.equal(activation("device-agent"), deviceActivation);
        const lastGood = activation("astrbot");
        const descriptorFile = path.join(built.packagesRoot, "io.rabiroute.agent.astrbot/1.0.0/agent-adapter.json");
        const descriptorBytes = await fs.readFile(descriptorFile);
        await fs.writeFile(descriptorFile, "{}");
        await runtime.reconcile();
        assert.equal(activation("astrbot"), lastGood, "A valid JSON document with invalid descriptor identity cannot uninstall its original owner.");
        assert.equal(activation("device-agent"), deviceActivation);
        await fs.writeFile(descriptorFile, descriptorBytes);
        await runtime.reconcile();
        await fs.appendFile(gatewayFile, "\nthrow new Error('isolated Agent activation failure');\n");
        await runtime.reconcile();
        assert.equal(activation("astrbot"), lastGood, "A rejected update retains its original native activation.");
        assert.equal(activation("device-agent"), deviceActivation);
        await registry.create("deviceAgent", binding).deliver(envelope);
        assert.ok(runtime.current().records.some(record => record.identity.instanceId === "agent:astrbot" && record.error));
        snapshot = await settings.snapshot();
        await settings.update("agent:astrbot", { expectedRevision: snapshot.revision, enabled: false });
        await until(() => !registry.manifest("astrbot"));
        await runtime.reconcile();
        snapshot = await settings.snapshot();
        await settings.update("agent:astrbot", { expectedRevision: snapshot.revision, enabled: true });
        await runtime.reconcile();
        assert.equal(registry.manifest("astrbot"), undefined);
        assert.equal(activation("device-agent"), deviceActivation);
        await registry.create("deviceAgent", binding).deliver(envelope);
    }
    finally {
        finishDevice.resolve();
        finishAstrbot.resolve();
        await host.dispose();
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(originalEnvironment)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        await new Promise<void>(done => server.close(() => done()));
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
test("formal dispatch uses the current DSH activation binding while the original accepted request retains its session", { timeout: 90000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "native-dsh-binding-"));
    const host = new RabiCordisHost(), registry = new AgentAdapterRegistry(), entered = gate(), finish = gate();
    const oldId = "session-00000000-0000-4000-8000-000000000001", newId = "session-00000000-0000-4000-8000-000000000002";
    const requests: Array<{
        sessionId: string;
        requestId: string;
    }> = [];
    const server = http.createServer(async (request, response) => {
        if (request.url === "/?token=fixture-token") {
            response.writeHead(303, { location: "/", "set-cookie": "dsh-auth-fixture=fixture-cookie; HttpOnly; Path=/" });
            response.end();
            return;
        }
        let raw = "";
        for await (const chunk of request)
            raw += chunk;
        const body = JSON.parse(raw), payload = body.payload.args.request;
        assert.equal(body.method, "session/prompt");
        requests.push(payload);
        if (payload.sessionId === oldId) {
            entered.resolve();
            await finish.promise;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}`;
    const auth = path.join(temporary, "auth.json"), log = path.join(temporary, "launch.log");
    await fs.writeFile(log, `dsh web: ${origin}/?token=fixture-token\n`);
    await fs.writeFile(auth, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input, init) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); return url.origin === origin ? nativeHttpTestFetch(url, init) : originalFetch(input, init); }) as typeof fetch;
    const environment = { RABI_DSH_AUTH_FILE: auth, RABI_DSH_LOCAL_OWNER_URL: "", DSH_MODEL: "", DSH_MODEL_PROVIDER: "", DSH_REASONING_EFFORT: "", GATEWAY_MANAGER_URL: "" };
    const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
        // @ts-expect-error JavaScript package builder is outside src.
        const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
        const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.agent.dsh"], outputDirectory: path.join(temporary, "built") });
        const profilePath = path.join(temporary, "profile.json");
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "agent:dsh", package: "io.rabiroute.agent.dsh", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
        const boot = { id: "dsh-route", gatewayPort: 8789, enabled: true, messageAdapters: [], agentAdapters: ["dsh"], dshSessionId: oldId, dshSessionName: "Original owner", dshCwd: temporary, dshBaseUrl: origin };
        const runtime = await mountGatewayEndpointPlugins(host, { profilePath, settingsRoot: path.join(temporary, "settings"), packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: [], agentRegistry: registry, initialRouteDefinition: boot, watch: false,
            agentHostPorts: createAgentAdapterHostPorts({ layout: { packageRoot: process.cwd(), stateRoot: temporary }, loaders: { "agentAdapters/stateReporter": async () => ({ reportAgentState() { } }) } }) });
        const optionsSeen: unknown[] = [];
        const dispatch = () => dispatchToAgentAdapter("dsh", envelope, [], { id: "local:dsh", provider: "dsh" }, async (type) => { const adapter = registry.create(type); return { ...adapter, deliver(message, options) { optionsSeen.push(options); return adapter.deliver(message, options); } }; });
        const oldActivation = runtime.current().records[0].identity.activationId;
        const original = dispatch();
        await entered.promise;
        const changed = { ...boot, dshSessionId: newId, dshSessionName: "New binding" };
        const updating = runtime.applyRouteSnapshot(changed, "new-dsh-binding");
        await until(() => runtime.current().records[0].identity.activationId !== oldActivation);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].sessionId, oldId);
        await assert.rejects(dispatch(), /not ready|retiring/);
        finish.resolve();
        await original;
        await updating;
        await dispatch();
        assert.deepEqual(requests.map(request => request.sessionId), [oldId, newId]);
        assert.ok(optionsSeen.every(options => !("threadId" in (options as object)) && !("workspace" in (options as object))), "Local dispatch must not overwrite native bindings with boot config.");
        const endpoint = runtime.current().records[0];
        const source = { instance: { id: endpoint.identity.instanceId }, package: { runtimeRoot: path.join(built.packagesRoot, "io.rabiroute.agent.dsh/1.0.0"), manifest: endpoint.manifest } };
        const declarations = (await readEndpointRouteDeclarations([source])).declarations;
        assert.equal(classifyRouteChange(boot, changed, declarations).sharedChanged, false);
        assert.equal(classifyRouteChange({ ...boot, messageProcessingAgents: { dsh: { enabled: true } } }, { ...changed, messageProcessingAgents: { dsh: { enabled: true } } }, declarations).sharedChanged, true);
        assert.equal(classifyRouteChange({ ...boot, codexMemoryConsolidationAgentEnabled: true }, { ...changed, codexMemoryConsolidationAgentEnabled: true }, declarations).sharedChanged, true);
        assert.equal(classifyRouteChange(boot, { ...boot, agentModel: "new-model" }, declarations).sharedChanged, true);
        assert.equal(classifyRouteChange(boot, { ...boot, codexPlanAssistantSessions: [{ threadId: "original-assistant" }] }, declarations).sharedChanged, true);
    }
    finally {
        finish.resolve();
        await host.dispose();
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        await new Promise<void>(done => server.close(() => done()));
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
