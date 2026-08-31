import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginManifest } from "../plugin-kernel/types.js";
import { IsolatedPluginExecutor } from "./executor.js";

async function waitFor(predicate: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for isolated plugin lifecycle state.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("isolated executor prepares, commits and disposes a plugin outside Manager", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-isolated-plugin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "lifecycle.jsonl");
  const entryPath = path.join(root, "manager.mjs");
  await fs.writeFile(entryPath, `
    import fs from "node:fs";
    export async function activate(context) {
      context.services.provide("test.isolated@1", { pid: process.pid, value: 42 });
      context.contributions.register({ kind: "status", id: "isolated", value: { ready: true } });
      context.effects.add(() => {
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: "start", pid: process.pid }) + "\\n");
        return () => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: "stop", aborted: context.lifecycle.signal.aborted }) + "\\n");
      });
    }
  `, "utf8");
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: "io.test.isolated",
    version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: ["test.isolated@1"],
    requires: [],
    optional: [],
    permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated",
    revision: "one",
    manifest,
    config: {},
    entry: { execution: "isolated", path: entryPath }
  };
  const executor = new IsolatedPluginExecutor();
  const runtime = new GenerationRuntime({
    host: "manager",
    executor,
    applicationIdentity: { applicationGenerationId: "app-one", managerInstanceId: "manager-one" }
  });
  t.after(async () => { await runtime.dispose().catch(() => {}); await executor.leases.disposeAll(); });
  const activated = await runtime.switch([candidate], { readyRequires: ["test.isolated@1"] });
  assert.deepEqual(activated.generation.records.map(record => ({
    status: record.status,
    error: record.error?.message
  })), [{ status: "active", error: undefined }]);
  assert.equal(activated.generation.readiness.state, "ready");
  const value = activated.generation.services.services.get("test.isolated@1")?.value as { pid: number; value: number };
  assert.equal(value.value, 42);
  assert.notEqual(value.pid, process.pid);
  assert.equal(activated.generation.contributions.contributions[0]?.id, "isolated");
  await runtime.dispose();
  const rows = (await fs.readFile(marker, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.event), ["start", "stop"]);
  assert.equal(rows[1].aborted, true);
  assert.equal(executor.leases.list().length, 0);
});

test("isolated executor preserves maxChildProcesses=0 as fail-closed", async t => {
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: "io.test.isolated-disabled",
    version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated-disabled",
    revision: "one",
    manifest,
    config: {},
    entry: { execution: "isolated", path: "unused.mjs" },
    policy: {
      restart: { mode: "never", maxAttempts: 0, windowMs: 60_000, initialBackoffMs: 0, maximumBackoffMs: 1 },
      resources: { maxChildProcesses: 0, shutdownTimeoutMs: 1_000 }
    }
  };
  const executor = new IsolatedPluginExecutor();
  const runtime = new GenerationRuntime({ host: "manager", executor });
  t.after(async () => { await runtime.dispose().catch(() => {}); await executor.leases.disposeAll(); });
  const result = await runtime.switch([candidate]);
  assert.equal(result.generation.records[0]?.status, "failed");
  assert.match(result.generation.records[0]?.error?.message ?? "", /child-process limit/);
  assert.equal(executor.leases.list().length, 0);
});

test("isolated executor applies bounded restart and reports exhaustion to GenerationRuntime", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-isolated-restart-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "starts.jsonl");
  const entryPath = path.join(root, "manager.mjs");
  await fs.writeFile(entryPath, `
    import fs from "node:fs";
    export async function activate(context) {
      context.services.provide("test.restart@1", { value: 42 });
      context.effects.add(() => {
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: "start", pid: process.pid }) + "\\n");
        setTimeout(() => process.exit(31), 50);
        return () => {};
      });
    }
  `, "utf8");
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: "io.test.isolated-restart",
    version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: ["test.restart@1"], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated-restart",
    revision: "one",
    manifest,
    config: {},
    entry: { execution: "isolated", path: entryPath },
    policy: {
      restart: { mode: "on_failure", maxAttempts: 1, windowMs: 60_000, initialBackoffMs: 1, maximumBackoffMs: 1 },
      resources: { maxChildProcesses: 1, shutdownTimeoutMs: 5_000 }
    }
  };
  const executor = new IsolatedPluginExecutor();
  let runtimeFailure: (() => void) | undefined;
  const failureObserved = new Promise<void>(resolve => { runtimeFailure = resolve; });
  const runtime = new GenerationRuntime({
    host: "manager",
    executor,
    readyRequires: ["test.restart@1"],
    onRuntimeFailure: () => { runtimeFailure?.(); }
  });
  t.after(async () => { await runtime.dispose().catch(() => {}); await executor.leases.disposeAll(); });
  const activated = await runtime.switch([candidate]);
  assert.equal(activated.generation.readiness.state, "ready");
  await failureObserved;
  await waitFor(() => executor.leases.list().length === 0);
  const rows = (await fs.readFile(marker, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].pid, rows[1].pid);
  assert.equal(runtime.current().records[0]?.error?.code, "runtime_failed");
  assert.equal(runtime.current().readiness.state, "degraded");
  assert.deepEqual(runtime.current().readiness.missingCapabilities, ["test.restart@1"]);
});

test("isolated executor terminates a replacement whose commit is rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-isolated-commit-reject-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "first-commit");
  const entryPath = path.join(root, "manager.mjs");
  await fs.writeFile(entryPath, `
    import fs from "node:fs";
    export async function activate(context) {
      context.services.provide("test.commit-reject@1", { value: 42 });
      context.effects.add(() => {
        if (fs.existsSync(${JSON.stringify(marker)})) throw new Error("replacement commit rejected");
        fs.writeFileSync(${JSON.stringify(marker)}, "committed");
        setTimeout(() => process.exit(32), 50);
        return () => {};
      });
    }
  `, "utf8");
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: "io.test.isolated-commit-reject",
    version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: ["test.commit-reject@1"], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated-commit-reject",
    revision: "one",
    manifest,
    config: {},
    entry: { execution: "isolated", path: entryPath },
    policy: {
      restart: { mode: "on_failure", maxAttempts: 1, windowMs: 60_000, initialBackoffMs: 1, maximumBackoffMs: 1 },
      resources: { maxChildProcesses: 1, shutdownTimeoutMs: 1_000 }
    }
  };
  const executor = new IsolatedPluginExecutor();
  let reportFailure = (): void => {};
  const failureObserved = new Promise<void>(resolve => { reportFailure = resolve; });
  const runtime = new GenerationRuntime({
    host: "manager",
    executor,
    readyRequires: ["test.commit-reject@1"],
    onRuntimeFailure: () => { reportFailure(); }
  });
  t.after(async () => { await runtime.dispose().catch(() => {}); await executor.leases.disposeAll().catch(() => {}); });

  await runtime.switch([candidate]);
  await failureObserved;
  assert.equal(executor.leases.list().length, 0);
  assert.match(runtime.current().records[0]?.error?.message ?? "", /replacement commit rejected/);
});

test("isolated executor heartbeat terminates an unresponsive child and reports runtime failure", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-isolated-heartbeat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "starts.jsonl");
  const entryPath = path.join(root, "manager.mjs");
  await fs.writeFile(entryPath, `
    import fs from "node:fs";
    export async function activate(context) {
      context.services.provide("test.heartbeat@1", { ready: true });
      context.effects.add(() => {
        fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }) + "\\n");
        setTimeout(() => { while (true) {} }, 100);
        return () => {};
      });
    }
  `, "utf8");
  const manifest: PluginManifest = {
    schemaVersion: 2,
    id: "io.test.isolated-heartbeat",
    version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: ["test.heartbeat@1"], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated-heartbeat",
    revision: "one",
    manifest,
    config: {},
    entry: { execution: "isolated", path: entryPath },
    policy: {
      restart: { mode: "on_failure", maxAttempts: 1, windowMs: 60_000, initialBackoffMs: 1, maximumBackoffMs: 1 },
      resources: { maxChildProcesses: 1, shutdownTimeoutMs: 1_000 }
    }
  };
  const executor = new IsolatedPluginExecutor(undefined, {
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 25,
    terminationTimeoutMs: 1_000
  });
  let reportFailure = (): void => {};
  const failureObserved = new Promise<void>(resolve => { reportFailure = resolve; });
  const runtime = new GenerationRuntime({
    host: "manager",
    executor,
    readyRequires: ["test.heartbeat@1"],
    onRuntimeFailure: () => { reportFailure(); }
  });
  t.after(async () => { await runtime.dispose().catch(() => {}); await executor.leases.disposeAll(); });
  const activated = await runtime.switch([candidate]);
  assert.equal(activated.generation.readiness.state, "ready");
  await failureObserved;
  await waitFor(() => executor.leases.list().length === 0);
  const rows = (await fs.readFile(marker, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].pid, rows[1].pid);
  assert.equal(runtime.current().records[0]?.error?.code, "runtime_failed");
  assert.match(runtime.current().records[0]?.error?.message ?? "", /heartbeat failed/);
});
