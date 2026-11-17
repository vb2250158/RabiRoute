import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { AgentAdapterProvider } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { createVoiceAssistantHostAccess } from "./voiceAssistantHostAccess.js";
import { createOwnedServiceAgentSender } from "./ownedServiceAgentSender.js";
// @ts-expect-error The formal ESM builder is also the CLI implementation.
import { buildPluginPackages } from "../../scripts/build-plugin-packages.mjs";

// The process that dlopens koffi.node must exit before its fixture can be removed.
async function activateReadOnlyPackage(directory: string, packageRoot: string) {
  const module = await import(pathToFileURL(path.join(packageRoot, "manager.mjs")).href);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "rabi.plugin.json"), "utf8"));
  const applicationIdentity = { applicationGenerationId: "isolated-app", managerInstanceId: "isolated-manager" };
  let endpointCalls = 0, dispatches = 0, registrations = 0, disposedRegistrations = 0;
  const access = createVoiceAssistantHostAccess({ readOnly: () => true, assertActive() {}, deliveryAuthorityId: () => "isolated-local-authority" });
  const sender = createOwnedServiceAgentSender({ providers: () => [], deliveryAuthorityId: access.deliveryAuthorityId,
    assertCurrent: access.assertSendAllowed, async dispatch() { dispatches++; throw Error("unexpected dispatch"); } });
  const operations: any[] = [];
  const ports: Record<string, unknown> = {
    "manager.core@1": {}, "manager.persona@1": {}, "manager.speech@1": { speechControl: {} },
    "host.agent-adapters@1": { environment: { RABIROUTE_STATE_ROOT: path.join(directory, "state") }, async prepareModules(ids: string[]) { assert.deepEqual(ids, []); }, manager: { readOnly: () => true, publishManagerEvent() {} } },
    "host.manager.operations@1": { async registerOperationsAsync(items: any[]) { registrations++; operations.push(...items); return { dispose() { disposedRegistrations++; } }; } },
    "host.manager.voice-assistant@2": { deliveryAuthorityId: access.deliveryAuthorityId, bindAgentSender: sender.bind, endpoint() { endpointCalls++; throw Error("unexpected manager access"); } }
  };
  const runtime = new GenerationRuntime({ host: "manager", applicationIdentity, readyRequires: ["manager.voice-assistant@1"],
    hostServices: Object.entries(ports).map(([capability, value]) => ({ capability, value })), executor: { async prepare() { return module; } } });
  try {
    const result = await runtime.switch([{ instanceId: "manager:voice-assistant", manifest, revision: "readonly-fixture", config: {}, entry: { execution: "in_process", path: path.join(packageRoot, "manager.mjs") } }]);
    assert.equal(result.generation.readiness.state, "ready");
    const record = result.generation.records[0]!;
    assert.equal(record.status, "active", JSON.stringify(record.error));
    assert.equal(record.identity.applicationGenerationId, applicationIdentity.applicationGenerationId);
    assert.equal(record.identity.managerInstanceId, applicationIdentity.managerInstanceId);
    assert.equal(record.identity.version, manifest.version);
    const voice = result.generation.services.services.get("manager.voice-assistant@1")!.value as { command(request: unknown): Promise<unknown> };
    for (const action of ["text", "start", "settings", "credential", "test-playback", "run-checks"])
      await assert.rejects(voice.command({ action, text: "fixture" }), /ASSISTANT_READ_ONLY/);
    const provider = result.generation.services.services.get("agent.adapter.voice-assistant@1")!.value as AgentAdapterProvider;
    await assert.rejects(provider.invoke("deliver", { envelope: { id: "blocked", text: "fixture" }, binding: { sessionId: "unopened" } }), /ASSISTANT_READ_ONLY/);
    for (const action of ["send", "reconcile_delivery"] as const)
      await assert.rejects(sender.bind(provider)({ action, agentAdapter: "voice-assistant", threadId: "target", prompt: "fixture" }, "unopened"), /admission is unavailable/);
    assert.equal(registrations, 1); assert.equal(operations.length, 4);
    assert.equal(endpointCalls, 0); assert.equal(dispatches, 0);
    assert.deepEqual(await fs.readdir(path.join(directory, "state/data/voice-assistant")), ["connection"]);
    assert.deepEqual(await fs.readdir(path.join(directory, "state/data/voice-assistant/connection")), []);
  } finally { await runtime.dispose(); }
  assert.equal(disposedRegistrations, registrations);
  assert.deepEqual(runtime.pendingRetirements(), []);
  return { active: true, retired: true, endpointCalls, dispatches, registrations, disposedRegistrations };
}

const childFlag = "--voice-readonly-activation-child";
if (process.argv[2] === childFlag) {
  try {
    const receipt = await activateReadOnlyPackage(process.argv[3]!, process.argv[4]!);
    process.stdout.write("READONLY_VOICE_ACTIVATION_OK " + JSON.stringify(receipt) + "\n");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  // Exercises the SDK-built production entry, not a second activation implementation.
  test("SDK-built voice package initializes read-only and retires without admitting commands or native delivery", { timeout: 60000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-voice-readonly-activation-"));
    let childClosed: Promise<void> = Promise.resolve();
    t.after(async () => {
      await childClosed;
      await fs.rm(directory, { recursive: true });
      await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    });
    const candidate = process.env.RABIROUTE_READONLY_VOICE_CANDIDATE;
    const output = candidate ?? path.join(directory, "built");
    if (!candidate) await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.manager.voice-assistant"], outputDirectory: output });
    const packageId = "io.rabiroute.manager.voice-assistant";
    const sourceManifest = JSON.parse(await fs.readFile(path.join(process.cwd(), "src/plugins", packageId, "rabi.plugin.json"), "utf8"));
    const packageRoot = path.join(output, "packages", packageId, sourceManifest.version);
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "./scripts/test-manager-runtime-env.mjs", "--import", "tsx", fileURLToPath(import.meta.url), childFlag, directory, packageRoot], {
      cwd: process.cwd(), env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", spawnError: Error | undefined;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", error => { spawnError = error; });
    let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
    childClosed = new Promise(resolve => child.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolve(); }));
    await childClosed;
    assert.equal(spawnError, undefined);
    assert.equal(exitSignal, null, "activation child must exit naturally");
    assert.equal(exitCode, 0, stderr || stdout);
    const receiptLine = stdout.split(/\r?\n/).find(line => line.startsWith("READONLY_VOICE_ACTIVATION_OK "));
    assert.ok(receiptLine, "child must finish all lifecycle and safety assertions before exiting");
    assert.deepEqual(JSON.parse(receiptLine.slice("READONLY_VOICE_ACTIVATION_OK ".length)), {
      active: true, retired: true, endpointCalls: 0, dispatches: 0, registrations: 1, disposedRegistrations: 1
    });
    t.diagnostic("Activation child exited normally; parent joins it before exclusive fixture cleanup.");
  });
}
