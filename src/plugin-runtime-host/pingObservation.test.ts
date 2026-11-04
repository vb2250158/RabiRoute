import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { fixtureApiContract } from "../manager/apiOperationContractFixtures.js";
import { buildManagerHealthSnapshot } from "../manager/managerHealth.js";
import { BridgedIsolatedPluginExecutor, type RuntimeObservation } from "./bridge/executor.mjs";

async function until(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Original fixture observation did not settle.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-ping-observation-"));
  const entry = path.join(root, "manager.mjs"), marker = path.join(root, "writes");
  const source = `import fs from 'node:fs';export function activate(c){
    c.services.provide('fixture.control@1',{async run(value){fs.appendFileSync(c.config.marker,'write\\n');if(value==='pending')await new Promise(()=>{});if(value.startsWith('host:'))return await c.services.require('host.fixture@1').run(value);return value;}});
    c.contributions.register({kind:'command',id:'fixture-command',value:{label:'still available'}});
    const host=c.services.require('host.fixture@1');c.effects.add(async()=>{await host.register();});
  }`;
  await fs.writeFile(entry, source);
  const candidate: PluginCandidate = {
    instanceId: "fixture-control", revision: "fixture-revision", config: { marker },
    entry: { execution: "isolated", path: entry },
    manifest: { schemaVersion: 2, id: "io.fixture.control", version: "1.0.0", entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
      provides: ["fixture.control@1"], requires: ["host.fixture@1"], optional: [], permissions: [] }
  };
  const observations: RuntimeObservation[] = [], commands: Array<{ requestId: string; command: string }> = [];
  let child!: ChildProcess, closed!: Promise<void>, holdPing = false, held: unknown[] | undefined;
  let forward!: ChildProcess["emit"];
  let lastInvoke: Record<string, unknown> | undefined;
  let runtime!: GenerationRuntime;
  const routes = new ManagerPluginRouteRegistry(() => new Set(runtime.current().records.filter(row => row.status === "active").map(row => row.identity.activationId)));
  let registration: ReturnType<typeof routes.registerOperations> | undefined;
  let releaseHost!: () => void, hostCalls = 0;
  const hostGate = new Promise<void>(resolve => { releaseHost = resolve; });
  const host = {
    async run(value: string) { hostCalls++; await hostGate; return value; },
    async register() {
      registration = routes.registerOperations("fixture-control", [{ contract: fixtureApiContract({ operationId: "fixture.control.read", method: "GET", pathTemplate: "/fixture",
        request: { path: true, query: true, headers: true, body: { kind: "none" } }, responses: { "200": { mediaType: "text/plain", schema: true } } }),
        handler: () => ({ status: 200, body: "available" }) }]);
    },
    async unregister() { await registration?.dispose(); }
  };
  const executor = new BridgedIsolatedPluginExecutor({
    contracts: { "fixture.control@1": { kind: "async-methods", methods: ["run"], effects: { run: "mutation" } },
      "host.fixture@1": { kind: "async-methods", methods: ["register", "unregister", "run"], effects: { register: "owned-resource", unregister: "owned-resource", run: "mutation" } } },
    resolvePackage: async () => ({ root, files: [{ relative: "manager.mjs", sha256: createHash("sha256").update(source).digest("hex") }] }),
    runWithIdentity: runPluginActivation,
    requestMs: 10000, shutdownMs: 500,
    record: value => { observations.push(value); },
    launch: entrypoint => {
      const launchOptions: ForkOptions & { windowsHide: boolean } = { execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true };
      child = fork(entrypoint, [], launchOptions);
      closed = once(child, "close").then(() => undefined);
      const send = child.send.bind(child); forward = child.emit.bind(child);
      child.send = ((message: any, ...args: any[]) => {
        if (message.type === "command") commands.push({ requestId: message.requestId, command: message.command });
        if (message.command === "invoke") lastInvoke = message;
        return (send as any)(message, ...args);
      }) as typeof child.send;
      child.emit = ((event: string, ...args: unknown[]) => {
        const message = args[0] as { type?: string; requestId?: string } | undefined;
        if (event === "message" && message?.type === "result" && holdPing && commands.some(row => row.command === "ping" && row.requestId === message.requestId)) { held = args; return true; }
        return forward(event, ...args);
      }) as typeof child.emit;
      return child;
    }
  });
  const failures: unknown[] = [];
  runtime = new GenerationRuntime({ host: "manager", executor, hostServices: [{ capability: "host.fixture@1", value: host }],
    activationTimeoutMs: 15000, onRuntimeFailure: event => { failures.push(event); } });
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture`;
  t.after(async () => {
    releaseHost(); holdPing = false; if (held) { forward("message", ...held); held = undefined; }
    await runtime.shutdown(); await registration?.dispose(); await closed;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true });
  });
  const switched = await runtime.switch([candidate]);
  assert.equal(switched.generation.records[0]?.status, "active", JSON.stringify(switched.generation.records));
  const identity = switched.generation.records[0]!.identity;
  return { runtime, executor, identity, observations, commands, failures, url, marker, child: () => child, releaseHost, hostCalls: () => hostCalls,
    hold() { holdPing = true; }, release() { holdPing = false; assert.ok(held); forward("message", ...held); held = undefined; }, hasHeld: () => Boolean(held),
    wrongIdentityResponse() { assert.ok(lastInvoke); forward("message", { ...lastInvoke, type: "result", value: "forged", identity: { ...identity, managerInstanceId: "another-manager" } }); } };
}

test("late original ping reports degradation while its process, registration and exact request remain usable", { timeout: 60000 }, async t => {
  const f = await fixture(t), pid = f.child().pid, generation = f.runtime.current().id;
  assert.equal((await fetch(f.url)).status, 200);
  f.hold(); const probe = f.executor.probe(f.identity);
  await until(() => f.hasHeld() && Boolean(f.observations.at(-1)?.probe));
  const delayed = f.observations.at(-1)!;
  assert.equal(delayed.probe?.state, "degraded"); assert.equal(delayed.firstFailure, undefined);
  assert.equal(f.child().exitCode, null); assert.equal(f.child().pid, pid);
  assert.equal(f.runtime.current().id, generation); assert.equal(f.runtime.current().records[0]?.status, "active");
  assert.equal((await fetch(f.url)).status, 200, "The original route remains registered during observation delay.");
  const service = f.runtime.current().services.services.get("fixture.control@1")!.value as { run(value: string): Promise<string> };
  assert.equal(await service.run("once"), "once");
  assert.equal(f.commands.filter(row => row.command === "ping").length, 1);
  assert.ok(delayed.pending.includes(delayed.probe!.requestId));
  f.release(); await probe;
  assert.equal(f.observations.at(-1)?.probe, undefined); assert.equal(f.child().pid, pid); assert.equal(f.failures.length, 0);
  await f.executor.probe(f.identity);
  assert.equal(f.commands.filter(row => row.command === "ping").length, 2);
  assert.equal(f.commands.filter(row => row.command === "invoke").length, 1);
  assert.equal(await fs.readFile(f.marker, "utf8"), "write\n");
});

test("an actual isolated child exit still removes its original service and route", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.child().kill("SIGTERM"), true);
  await until(() => f.runtime.current().records[0]?.status === "failed");
  assert.equal(f.runtime.current().services.services.has("fixture.control@1"), false);
  assert.equal((await fetch(f.url)).status, 404); assert.equal(f.failures.length, 1);
});

test("seventy original invocations and host calls cross both bridge directions while one probe remains available", { timeout: 60000 }, async t => {
  const f = await fixture(t), pid = f.child().pid;
  const service = f.runtime.current().services.services.get("fixture.control@1")!.value as { run(value: string): Promise<string> };
  const original = Promise.all(Array.from({ length: 70 }, (_, index) => service.run(`host:${index}`)));
  void original.catch(() => {});
  await until(() => f.hostCalls() === 70);
  await f.executor.probe(f.identity);
  assert.equal(f.child().pid, pid); assert.equal(f.child().exitCode, null); assert.equal(f.failures.length, 0);
  assert.equal((await fetch(f.url)).status, 200);
  f.releaseHost();
  assert.deepEqual(await original, Array.from({ length: 70 }, (_, index) => `host:${index}`));
  assert.equal(f.commands.filter(row => row.command === "invoke").length, 70);
  assert.equal(f.commands.filter(row => row.command === "ping").length, 1);
  assert.equal((await fs.readFile(f.marker, "utf8")).trim().split("\n").length, 70);
});

test("a real mutating invoke timeout retains its original failure without replay", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const service = f.runtime.current().services.services.get("fixture.control@1")!.value as { run(value: string): Promise<string> };
  const original = service.run("pending");
  const unconfirmed = assert.rejects(original, (error: unknown) => error instanceof Error && /Isolated invoke exceeded its deadline/.test(error.message));
  await until(() => f.commands.some(row => row.command === "invoke")); f.wrongIdentityResponse();
  await unconfirmed;
  await until(() => f.runtime.current().records[0]?.status === "failed");
  assert.equal(f.commands.filter(row => row.command === "invoke").length, 1);
  assert.equal(await fs.readFile(f.marker, "utf8"), "write\n");
  assert.equal(f.observations.some(value => value.probe), false);
});

test("Manager-owned optional probe diagnostics degrade health and clear on the exact original response", async () => {
  const text = await fs.readFile(path.resolve("src/manager/controlPlaneRoutes.ts"), "utf8");
  const source = ts.createSourceFile("controlPlaneRoutes.ts", text, ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["capturePluginRuntimeObservation", "pluginReadinessWithProbeObservations"].includes(node.name?.text ?? ""));
  assert.equal(declarations.length, 2);
  const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const diagnostics = new Map();
  const { observe, readiness } = new Function("managerPluginProbeDiagnostics", compiled + ";return { observe: capturePluginRuntimeObservation, readiness: pluginReadinessWithProbeObservations };")(diagnostics) as { observe(value: RuntimeObservation): void; readiness(value: { state: "ready" | "degraded"; missingCapabilities: readonly string[] }): { state: "ready" | "degraded"; missingCapabilities: readonly string[] } };
  const value: RuntimeObservation = { identity: { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", activationId: "fixture-activation", instanceId: "fixture-control", pluginId: "io.fixture.control", version: "1.0.0", revision: "fixture-revision", host: "manager" }, calls: [], pending: ["original-probe"], state: "committed", pid: 1, observation: { exit: null, close: null },
    probe: { state: "degraded", requestId: "original-probe", deadlineMs: 5000, observedAt: 1 } };
  observe(value); assert.equal(diagnostics.size, 1);
  const health = buildManagerHealthSnapshot({ pluginReadiness: readiness({ state: "ready", missingCapabilities: [] }), planStorageReady: true, routesReady: true,
    routeReadyCount: 0, routeRequiredCount: 0, blockedRouteIds: [], failedRouteIds: [], backgroundIncidentCount: diagnostics.size, sourcePatchesReady: true });
  assert.equal(health.state, "degraded"); assert.equal(health.live, true); assert.equal(health.requiredReady, true);
  observe({ ...value, probe: undefined }); assert.equal(diagnostics.size, 0);
  assert.equal(readiness({ state: "ready", missingCapabilities: [] }).state, "ready");
  assert.match(text, /backgroundLifecycle\.isolatedPluginProbes\.length/);
});
