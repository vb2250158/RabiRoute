import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentAdapterCatalogWorkerPool } from "./agentAdapterCatalogWorkerPool.js";

test("owned scanner factory receives child-local host ports and one shared scan for concurrent callers", { timeout: 90_000 }, async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-scan-"));
  // Like the real Manager listener, a host remains alive while its unref'ed
  // scan child is working. The pool intentionally does not own host lifetime.
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  let pool: AgentAdapterCatalogWorkerPool | undefined;
  context.after(async () => {
    try { await pool?.stop(); }
    finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); await fs.rm(directory, { recursive: true, force: true }); }
  });
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  await fs.mkdir(path.join(directory, "src/shared"), { recursive: true });
  for (const name of ["runtimeLayout", "timeoutSettings"]) await fs.copyFile(path.join(packageRoot, "src/shared", name + ".ts"), path.join(directory, "src/shared", name + ".ts"));
  // timeoutSettings deliberately re-exports the single kernel timeout owner.
  await fs.mkdir(path.join(directory, "src/plugin-kernel"), { recursive: true });
  await fs.copyFile(path.join(packageRoot, "src/plugin-kernel/runtimeTimeouts.ts"), path.join(directory, "src/plugin-kernel/runtimeTimeouts.ts"));
  const source = "src/plugins/io.test.scan/src/scan.ts";
  await fs.mkdir(path.dirname(path.join(directory, source)), { recursive: true });
  await fs.writeFile(path.join(directory, source), `
    import { applicationRuntimeLayout } from "@rabiroute/host-api/shared/runtimeLayout";
    import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
    let calls = 0;
    export async function scanOwned(context) {
      return { calls: ++calls, pid: process.pid, rootDir: context.rootDir,
        stateRoot: applicationRuntimeLayout(process.env).stateRoot,
        deadline: getTimeoutMs("worker.factory.fixture", 1500) };
    }
  `);
  const builderUrl = new URL("../../scripts/build-message-endpoint-runtime.mjs", import.meta.url).href;
  const { bundleMessageEndpointWorker } = await import(builderUrl);
  const entry = path.join(directory, "scan.mjs");
  const built = await bundleMessageEndpointWorker(directory, { source, mode: "host-factory" }, entry, { dependencyRoot: packageRoot });
  assert.deepEqual(built.hostModules, ["shared/runtimeLayout", "shared/timeoutSettings"]);
  assert.doesNotMatch(await fs.readFile(entry, "utf8"), /node_modules[\\/]typescript|class AgentRequestStore/);
  pool = new AgentAdapterCatalogWorkerPool({ maxConcurrency: 1 });
  const task = { kind: "provider" as const, entry, exportName: "scanOwned", rootDir: directory, runtimes: [], options: {},
    runtimeLayout: { packageRoot, stateRoot: path.join(directory, "state") } };
  const [first, second] = await Promise.all([pool.query<Record<string, unknown>>(task), pool.query<Record<string, unknown>>(task)]);
  assert.deepEqual(first, second);
  assert.equal(first.calls, 1);
  assert.notEqual(first.pid, process.pid);
  assert.equal(first.stateRoot, task.runtimeLayout.stateRoot);
  assert.equal(first.rootDir, directory);
  assert.equal(first.deadline, 1500);
  await pool.stop();
  assert.equal(pool.status().workers, 0);
});
