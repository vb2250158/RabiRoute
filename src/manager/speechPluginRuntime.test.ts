import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createSpeechPluginRuntime, type SpeechPluginPorts } from "./speechPluginRuntime.js";
import { SpeechControlError, SpeechModelManagerError, SpeechRuntimeControlError, SpeechModelSettingsError } from "../shared/speechErrors.js";
import { SpeechControlError as ControlError } from "./speechControl.js";
import { SpeechModelManagerError as ModelError } from "./speechModelManager.js";
import { SpeechRuntimeControlError as RuntimeError } from "./speechRuntimeControl.js";
import { SpeechModelSettingsError as SettingsError } from "./speechModelSettings.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import { configureTimeouts, readTimeoutOverrides } from "../plugin-kernel/runtimeTimeouts.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "speech-plugin-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const services = new Map<string, unknown>(), delivered: string[] = [], upstream: string[] = [];
  const ports: SpeechPluginPorts = {
    rootDir: root, packageRoot: process.cwd(), currentService: id => services.get(id), modelChanged: () => {}, reportError: () => {},
    computeTarget: () => undefined,
    peerRuntime: () => ({ selected: () => "fixture-compute", fetch: async (_device, _service, pathname) => {
      upstream.push(pathname); return new Response(Buffer.from("wave"), { status: 200, headers: { "content-type": "audio/wav" } });
    } }),
    control: { serviceUrl: () => "http://127.0.0.1:8781", personas: () => [],
      route: id => id === "voice" ? { id, speechEnabled: true } : undefined, routes: () => [{ id: "voice", speechEnabled: true }],
      deliverTranscript: async ({ record }) => { delivered.push(record.text); return { status: "delivered" }; }, appendRouteLog: () => {}
    },
    api: { readOnly: () => false, identity: () => ({ applicationGenerationId: "test", managerInstanceId: "test" }),
      capture: () => ({ guard: () => {}, run: operation => operation(), targetLocal: true }), readProxyJson: async () => ({}), hostSpeechCommand: body => body }
  };
  const service = createSpeechPluginRuntime(ports, undefined, "manager:speech");
  services.set("manager.speech@1", service); service.markReady();
  return { root, ports, services, service, delivered, upstream };
}

test("the speech endpoint owns transcript routing while shared TTS remains available after endpoint disable", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.speechControl.acceptMessage({ text: "before" })).status, "recorded");
  f.services.set("endpoint.speech@1", { type: "speech" });
  assert.equal((await f.service.speechControl.acceptMessage({ text: "enabled" })).status, "delivered");
  f.services.delete("endpoint.speech@1");
  assert.equal((await f.service.speechControl.acceptMessage({ text: "disabled" })).status, "recorded");
  assert.deepEqual(f.delivered, ["enabled"]);
  assert.equal((await f.service.speechControl.synthesize({ input: "shared consumer", model: "test", voice: "test", responseFormat: "wav", speed: 1,
    language: null, instructions: null, play: false, sessionId: null, routeId: null })).status, 200);
  assert.deepEqual(f.upstream, ["/v1/audio/speech"]);
});

test("replacement reuses native resources while stale service references cannot admit new work", async t => {
  const f = await fixture(t);
  const next = createSpeechPluginRuntime(f.ports, f.service, "manager:speech");
  assert.equal(next.resources, f.service.resources);
  f.services.set("manager.speech@1", next);
  assert.throws(() => next.speechControl.personas(), /waiting/);
  next.markReady();
  assert.deepEqual(next.speechControl.personas(), []);
  assert.throws(() => f.service.speechControl.personas(), SpeechControlError);
});

test("host and package retain the original shared exception identities", () => {
  assert.equal(ControlError, SpeechControlError); assert.equal(RuntimeError, SpeechRuntimeControlError);
  assert.equal(ModelError, SpeechModelManagerError); assert.equal(SettingsError, SpeechModelSettingsError);
});

test("the real Speech endpoint rejects new work on retirement and joins its original accepted delivery", async t => {
  const f = await fixture(t);
  const packageRoot = new URL("../../plugins/builtin/io.rabiroute.endpoint.speech/1.0.0/", import.meta.url);
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(new URL("rabi.plugin.json", packageRoot), "utf8")));
  // @ts-expect-error Native package builder is outside src.
  const { bundleMessageEndpointRuntime } = await import("../../scripts/build-message-endpoint-runtime.mjs");
  const spec = JSON.parse(await fs.readFile(new URL("egress-runtime.build.json", packageRoot), "utf8"));
  await fs.writeFile(path.join(f.root, "egress-runtime.mjs"), (await bundleMessageEndpointRuntime(process.cwd(), spec)).contents);
  await fs.writeFile(path.join(f.root, "manager.mjs"), (await fs.readFile(new URL("manager.mjs", packageRoot), "utf8"))
    .replace('"@rabiroute/plugin-sdk"', JSON.stringify(pathToFileURL(path.resolve("plugins/contracts/plugin-sdk/index.mjs")).href)));
  const timeoutOwner = await import("../shared/timeoutSettings.js");

  let removed!: () => void, finish!: () => void;
  const removal = new Promise<void>(resolve => { removed = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new GenerationRuntime({ host: "manager", onPublished: current => { if (!current.services.services.has("endpoint.speech@1")) removed(); },
    hostServices: [{ capability: "manager.speech@1", value: f.service }, { capability: "host.message-endpoints@1", value: {
      prepareModules: async () => {}, module: () => timeoutOwner,
      scanProviders: { prepare: () => ({ dispose: () => {}, publication: { publish() {}, rollback() {} } }) }
    } }] });
  t.after(() => runtime.dispose());
  await runtime.switch([{ instanceId: "endpoint:speech", revision: "one", manifest, config: {}, entry: { execution: "in_process", path: path.join(f.root, "manager.mjs") } }]);
  const endpoint = runtime.current().services.services.get("endpoint.speech@1")!.value as { runAcceptedWork<T>(operation: () => Promise<T>): Promise<T> };
  const accepted = endpoint.runAcceptedWork(async () => { await pending; return "original delivery"; });
  let retired = false;
  const retirement = runtime.switch([]).then(() => { retired = true; });
  await removal;
  await assert.rejects(endpoint.runAcceptedWork(async () => "new delivery"), /disabled|retiring/);
  assert.equal(retired, false);
  assert.equal(f.service.resources.operations.size, 1);
  finish(); assert.equal(await accepted, "original delivery");
  await retirement; assert.equal(f.service.resources.operations.size, 0);
  assert.equal(runtime.current().cleanupDiagnostics.length, 0);
});

test("the physical generated speech bundle recognizes the host's original admission error", async t => {
  const f = await fixture(t);
  // The packaging helper is a native JavaScript build owner.
  // @ts-ignore Native build helper.
  const { bundleMessageEndpointRuntime } = await import("../../scripts/build-message-endpoint-runtime.mjs");
  const spec = JSON.parse(await fs.readFile(new URL("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/manager-runtime.build.json", import.meta.url), "utf8"));
  const bundle = await bundleMessageEndpointRuntime(process.cwd(), spec);
  assert.ok(bundle.hostModules.includes("shared/speechErrors"));
  const modules = new Map(await Promise.all(bundle.hostModules.map(async (id: string) => [id, await import(pathToFileURL(path.join(process.cwd(), "src", id + ".ts")).href)] as const)));
  const filename = path.join(f.root, "manager-runtime.mjs"); await fs.writeFile(filename, bundle.contents);
  const generated = await import(pathToFileURL(filename).href);
  const implementation = generated.createImplementation({ module: (id: string) => modules.get(id) });
  const service = implementation.createSpeechPluginRuntime(f.ports, f.service, "bundled-speech");
  const owner = new service.SpeechApiOwner(service.speechApiContext);
  assert.equal(owner.failure(new SpeechControlError("Original admission revoked", 409)).status, 409);
  assert.equal(owner.failure(new SpeechControlError("Invalid compute target", 400)).status, 400);
});

async function nativeSpeechServiceFixture(t: test.TestContext, onEffectsRetirement?: () => void) {
  const f = await fixture(t);
  // Exercise the package's real lifecycle and native retirement, with isolated API registrations.
  // @ts-ignore The platform package exports its native JavaScript lifecycle.
  const { createSpeechPluginLifecycle } = await import("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/lifecycle.mjs");
  const raw = JSON.parse(await fs.readFile(new URL("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/rabi.plugin.json", import.meta.url), "utf8"));
  const manifest = parsePluginManifest({ ...raw, provides: ["manager.speech@1"], requires: [], optional: [] });
  const runtime = new GenerationRuntime({ host: "manager", onPublished: generation => {
    const current = generation.services.services.get("manager.speech@1");
    if (current) f.services.set("manager.speech@1", current.value); else f.services.delete("manager.speech@1");
  }, executor: { prepare: async () => ({ activate(context) {
    const owner = Object.create({ managerServicesReady: false, managerReadOnly: false, managerPluginRoutes: {
      registerOperationsAsync: async () => ({ dispose() {} }), registerHttpProxies: () => ({ dispose() {} })
    } }, Object.getOwnPropertyDescriptors(f.service));
    const lifecycle = createSpeechPluginLifecycle(owner, context.identity, context.lifecycle.signal);
    context.services.provide("manager.speech@1", f.service);
    context.effects.add(async () => {
      const retire = await lifecycle.prepare();
      return () => { onEffectsRetirement?.(); return retire(); };
    }, "real speech service lifecycle");
    context.publication.add(lifecycle.publication, "real speech service publication");
  } }) } });
  const candidate = { instanceId: "manager:speech", revision: "owned-release", manifest, config: {}, entry: { execution: "in_process" as const, path: "unused-custom-executor" } };
  return { ...f, runtime, candidate };
}

test("native Speech service disable and application shutdown leave a real foreign listener running", { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const f = await nativeSpeechServiceFixture(t);
  const listener = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  f.service.resources.speechRuntimeControl = new SpeechRuntimeControl({ rootDir: f.root, packageRoot: f.root,
    serviceUrl: () => `http://127.0.0.1:${address.port}`, ensureDependencies: async () => { throw new Error("capture environment absent"); } });
  await assert.rejects(f.service.resources.speechRuntimeControl.start(), /capture environment absent/);
  await assert.rejects(f.service.resources.speechRuntimeControl.stop(), /拒绝停止/);
  await f.runtime.switch([f.candidate]);
  await f.runtime.switch([]);
  assert.deepEqual(f.runtime.current().cleanupDiagnostics, []);
  await f.runtime.shutdown();
  assert.equal(listener.listening, true, "retiring this service cannot close the unrelated listener");
  await new Promise<void>((resolve, reject) => { const socket = net.connect(address.port, "127.0.0.1", () => { socket.destroy(); resolve(); }); socket.once("error", reject); });
});

test("native Speech service retirement preserves a genuine owned termination failure through application shutdown", async t => {
  const f = await nativeSpeechServiceFixture(t);
  const failure = new Error("owned Speech process termination failed");
  f.service.resources.speechRuntimeControl = new SpeechRuntimeControl({ rootDir: f.root, platform: "win32",
    serviceUrl: () => "http://127.0.0.1:54321", existsSync: () => false,
    inspectOwner: async () => ({ pid: 456, owned: true }), killProcessTree: async () => { throw failure; } });
  await f.runtime.switch([f.candidate]); await f.runtime.switch([]);
  assert.ok(f.runtime.current().cleanupDiagnostics.some(item => item.instanceId === "manager:speech" && item.message === failure.message));
  await assert.rejects(f.runtime.shutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].cause, failure);
    return true;
  });
});

test("native Speech service retirement closes its OS-verified workspace process before shutdown confirms", { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const f = await nativeSpeechServiceFixture(t);
  const root = await fs.realpath(f.root);
  const expectedHost = path.join(root, "plugin-adapters/rabi-speech/scripts/windows_host.py");
  const child = spawn(process.execPath, ["-e", "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));", expectedHost], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root }
  });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  const [message] = await once(child, "message") as [{ port: number }];
  assert.ok(message.port > 0); assert.notEqual(message.port, 8781);
  f.service.resources.speechRuntimeControl = new SpeechRuntimeControl({ rootDir: root, packageRoot: root,
    serviceUrl: () => `http://127.0.0.1:${message.port}` });
  await f.runtime.switch([f.candidate]); await f.runtime.switch([]);
  await f.runtime.shutdown(); await closed;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  // Cold OS identity queries can outlast ordinary disposal. Application shutdown
  // must still join this exact owner and confirm its actual process closure.
  for (const diagnostic of f.runtime.current().cleanupDiagnostics) {
    assert.equal(diagnostic.instanceId, "manager:speech");
    assert.equal(diagnostic.phase, "superseded");
    assert.equal(diagnostic.message, "Plugin effect disposal timed out: real speech service publication retirement after 5000ms.");
    assert.equal(diagnostic.lateConfirmed, true, "only the native owner's formal retirement confirmation can resolve a transient diagnostic");
  }
});

test("ordinary timeout diagnostics are formally confirmed when the shared Speech owner completes during the next disposer", async t => {
  const previous = readTimeoutOverrides(), previousEnvironment = process.env.RABIROUTE_TIMEOUT_OVERRIDES;
  configureTimeouts({ ...previous, "plugin.disposal": 10 });
  t.after(() => {
    configureTimeouts(previous);
    if (previousEnvironment === undefined) delete process.env.RABIROUTE_TIMEOUT_OVERRIDES;
    else process.env.RABIROUTE_TIMEOUT_OVERRIDES = previousEnvironment;
  });
  let nextDisposer!: () => void, release!: () => void;
  const nextEntered = new Promise<void>(resolve => { nextDisposer = resolve; });
  const originalGate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await nativeSpeechServiceFixture(t, nextDisposer);
  let ownedAlive = true, killEntered = false;
  f.service.resources.speechRuntimeControl = new SpeechRuntimeControl({ rootDir: f.root, platform: "win32",
    serviceUrl: () => "http://127.0.0.1:54321", existsSync: () => false,
    inspectOwner: async () => ownedAlive ? { pid: 456, owned: true } : null,
    killProcessTree: async pid => { assert.equal(pid, 456); killEntered = true; await originalGate; ownedAlive = false; } });
  await f.runtime.switch([f.candidate]);
  const retirement = f.runtime.switch([]);
  // EffectScope reaches this second disposer only after its first publication
  // disposer timed out. Both join the original package's memoized cleanup.
  await nextEntered;
  assert.equal(killEntered, true); assert.equal(ownedAlive, true);
  release(); await retirement;
  assert.equal(ownedAlive, false);
  const diagnostics = f.runtime.current().cleanupDiagnostics;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].instanceId, "manager:speech");
  assert.equal(diagnostics[0].message, "Plugin effect disposal timed out: real speech service publication retirement after 10ms.");
  assert.equal(diagnostics[0].lateConfirmed, true);
  await f.runtime.shutdown();
  assert.equal(f.runtime.current().cleanupDiagnostics[0].lateConfirmed, true);
});
