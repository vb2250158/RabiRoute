import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PersonaSyncManifestWorkerError,
  runPersonaSyncManifestWorker
} from "./personaSyncManifestWorkerClient.js";

function fixture(): { root: string; rolesRoot: string; stateRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-manifest-worker-"));
  const rolesRoot = path.join(root, "roles");
  const stateRoot = path.join(root, "state");
  const roleRoot = path.join(rolesRoot, "Rabi", "memory");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "memory.json"), "{\"id\":\"memory\"}\n", "utf8");
  return { root, rolesRoot, stateRoot };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as { port: number }).port;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Persona manifest worker ${pid} remained alive after cancellation.`);
}

test("persona manifest worker returns a complete cache without publishing it itself", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const result = await runPersonaSyncManifestWorker(data.rolesRoot, data.stateRoot, { timeoutMs: 5_000 });

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.cache.roles, ["Rabi"]);
  assert.deepEqual(result.cache.files.map(file => file.path), ["memory/memory.json"]);
  assert.equal(fs.existsSync(path.join(data.stateRoot, "manifest-index.json")), false);
});

test("a hung persona manifest scan is killed while the Manager event loop remains responsive", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{\"ok\":true}");
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let workerPid = 0;
  const refresh = runPersonaSyncManifestWorker(data.rolesRoot, data.stateRoot, {
    timeoutMs: 100,
    testDelayMs: 10_000,
    onSpawn: pid => { workerPid = pid; }
  });

  const startedAt = performance.now();
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(health.status, 200);
  assert.ok(elapsedMs < 250, `Health response took ${elapsedMs.toFixed(1)} ms.`);
  await assert.rejects(refresh, error =>
    error instanceof PersonaSyncManifestWorkerError && error.code === "timeout"
  );
  assert.ok(workerPid > 0);
  await waitForProcessExit(workerPid);
});
