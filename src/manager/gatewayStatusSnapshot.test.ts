import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { GatewayStatusSnapshotService, readGatewayStatusInWorker } from "./gatewayStatusSnapshot.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("the installed read-process protocol returns gateway status without parent filesystem access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-status-process-"));
  const file = path.join(root, "gateway-status.json");
  fs.writeFileSync(file, JSON.stringify({ napcat: { connected: true } }));
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1 });
  try {
    const value = await pool.run<Record<string, unknown>>({ type: "gateway_status_snapshot", statusPath: file });
    assert.deepEqual(value, { napcat: { connected: true }, statusPath: file });
  } finally {
    await pool.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("physical gateway status reads are worker-only and reject invalid status", () => {
  const previous = process.env.RABIROUTE_MANAGER_READ_PROCESS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-status-read-"));
  const file = path.join(root, "gateway-status.json");
  try {
    delete process.env.RABIROUTE_MANAGER_READ_PROCESS;
    assert.throws(() => readGatewayStatusInWorker(file), /Manager read worker/);
    process.env.RABIROUTE_MANAGER_READ_PROCESS = "1";
    assert.deepEqual(readGatewayStatusInWorker(file), { statusPath: file, napcat: { connected: false } });
    fs.writeFileSync(file, JSON.stringify({ napcat: { connected: true }, httpCallbacks: { webhook: { url: "fixture" } } }));
    assert.equal((readGatewayStatusInWorker(file).napcat as { connected: boolean }).connected, true);
    fs.writeFileSync(file, "[]");
    assert.throws(() => readGatewayStatusInWorker(file), /Invalid gateway status/);
  } finally {
    if (previous === undefined) delete process.env.RABIROUTE_MANAGER_READ_PROCESS;
    else process.env.RABIROUTE_MANAGER_READ_PROCESS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor reads coalesce pending status refreshes and keep the last successful snapshot", async () => {
  let now = 1_000;
  let loads = 0;
  let finish!: (value: Record<string, unknown>) => void;
  let fail = false;
  const service = new GatewayStatusSnapshotService({ now: () => now, load: async () => {
    loads += 1;
    if (fail) throw new Error("storage unavailable");
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    for (let i = 0; i < 50; i++) assert.equal((service.read("route", "fixture").gatewayStatusSnapshot as { state: string }).state, "warming");
    await settled();
    assert.equal(loads, 1);
    finish({ napcat: { connected: true }, httpCallbacks: { webhook: { url: "fixture" } } });
    await settled();
    const ready = service.read("route", "fixture");
    (ready.napcat as { connected: boolean }).connected = false;
    assert.equal((service.read("route", "fixture").napcat as { connected: boolean }).connected, true);
    now += 5_001;
    fail = true;
    service.read("route", "fixture");
    await settled();
    const stale = service.read("route", "fixture");
    assert.equal((stale.napcat as { connected: boolean }).connected, true);
    assert.equal((stale.gatewayStatusSnapshot as { state: string }).state, "stale");
    assert.equal(loads, 2);
    for (let i = 0; i < 50; i++) service.read("route", "fixture");
    await settled();
    assert.equal(loads, 2, "failed reads must retain a retry interval");
  } finally { service.stop(); }
});

test("route path changes and generation teardown fence late storage results", async () => {
  const pending = new Map<string, (value: Record<string, unknown>) => void>();
  const signals = new Map<string, AbortSignal>();
  const service = new GatewayStatusSnapshotService({ load: async (file, signal) => {
    signals.set(file, signal);
    return new Promise(resolve => pending.set(file, resolve));
  } });
  service.read("route", "old");
  await settled();
  service.read("route", "new");
  await settled();
  assert.equal(signals.get("old")!.aborted, true);
  pending.get("old")!({ obsolete: true });
  pending.get("new")!({ current: true });
  await settled();
  assert.equal(service.read("route", "new").current, true);
  assert.equal(service.read("route", "new").obsolete, undefined);
  service.read("another", "late");
  await settled();
  service.stop();
  assert.equal(signals.get("late")!.aborted, true);
  pending.get("late")!({ obsolete: true });
  await settled();
  assert.equal(service.read("another", "late").obsolete, undefined);
  assert.equal((service.read("another", "late").gatewayStatusSnapshot as { state: string }).state, "stopped");
});

test("teardown before the background microtask never starts another read worker", async () => {
  let loads = 0;
  const service = new GatewayStatusSnapshotService({ load: async () => { loads++; return {}; } });
  service.read("route", "fixture");
  service.stop();
  await settled();
  assert.equal(loads, 0);
});

test("Manager health remains responsive while a supervisor status worker blocks on storage", async () => {
  let started!: () => void;
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  let worker: Worker | undefined;
  const service = new GatewayStatusSnapshotService({ load: async (_file, signal) => {
    worker = new Worker(`const {parentPort}=require('node:worker_threads'); parentPort.postMessage('started'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);`, { eval: true });
    worker.once("message", started);
    signal.addEventListener("abort", () => { void worker!.terminate(); }, { once: true });
    return new Promise((_resolve, reject) => worker!.once("exit", () => reject(new Error("worker stopped"))));
  } });
  const server = http.createServer((request, response) => {
    const data = request.url === "/health" ? { live: true } : service.read("route", "fixture");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = await fetch(url);
    assert.equal((await status.json() as { gatewayStatusSnapshot: { state: string } }).gatewayStatusSnapshot.state, "warming");
    await workerStarted;
    const before = performance.now();
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(750) });
    assert.equal((await health.json() as { live: boolean }).live, true);
    assert.ok(performance.now() - before < 750);
  } finally {
    service.stop();
    await worker?.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
