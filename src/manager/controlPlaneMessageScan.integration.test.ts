import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ARGUMENT = "--rabiroute-scan-history-worker";
const SCAN_READ_MARKER = "RABIROUTE_TEST_MAIN_THREAD_HISTORY_READ";
const START_MANAGER_RETURNED_MARKER = "RABIROUTE_TEST_START_MANAGER_RETURNED";
const READY_PREFIX = "RABIROUTE_MANAGER_READY:";

type ReadyDescriptor = Readonly<{
  protocolVersion: 1;
  applicationGenerationId: string;
  managerInstanceId: string;
  pid: number;
  baseUrl: string;
  readyAt: string;
}>;

async function runSlowHistoryWorker(): Promise<void> {
  // Prefer the production build so this HTTP test does not measure tsx compiling
  // the entire Manager graph. Source-only runs retain the existing path.
  const built = new URL("../../dist/manager/controlPlaneRoutes.js", import.meta.url);
  const { startManager } = await import(fs.existsSync(fileURLToPath(built)) ? built.href : "./controlPlaneRoutes.js");
  const lifecycleModule = new URL("../../dist/manager/planStorageStartupLifecycle.js", import.meta.url);
  const { PlanStorageStartupLifecycle } = await import(fs.existsSync(fileURLToPath(lifecycleModule))
    ? lifecycleModule.href : "./planStorageStartupLifecycle.js");
  // This scan test does not exercise background plan migration. Reuse the
  // lifecycle seam while retaining the actual route catalog and HTTP scanner.
  const planStorageStartupLifecycle = new PlanStorageStartupLifecycle({
    rolesRoot: String(process.env.ROLES_DIR || ""), readOnly: false,
    attemptFactory: () => ({ result: new Promise<never>(() => {}), cancel: async () => {} })
  });
  const transactionModule = new URL("../../dist/manager/routeCatalogTransaction.js", import.meta.url);
  const { executeRouteCatalogTransaction } = await import(fs.existsSync(fileURLToPath(transactionModule))
    ? transactionModule.href : "./routeCatalogTransaction.js");
  await startManager({
    planStorageStartupLifecycle,
    routeCatalogStartupAttemptFactory: (operation: import("./routeCatalogTransaction.js").RouteCatalogTransactionOperation, identity: import("./routeCatalogStartupLifecycle.js").RouteCatalogAttemptIdentity) => ({
      result: Promise.resolve(executeRouteCatalogTransaction({
        ...identity, operation, rootDir: String(process.env.RABIROUTE_STATE_ROOT),
        routeRoot: String(process.env.ROUTE_DIR), rolesRoot: String(process.env.ROLES_DIR),
        managerPort: 0, readOnly: false
      })),
      cancel: async () => {}
    })
  });
  const exists = fs.existsSync;
  fs.existsSync = ((target: fs.PathLike): boolean => {
    if (String(target).endsWith("private-messages.jsonl")) {
      process.stdout.write(`${SCAN_READ_MARKER}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
    return exists(target);
  }) as typeof fs.existsSync;
  process.stdout.write(`${START_MANAGER_RETURNED_MARKER}\n`);
}

async function waitUntil(
  predicate: () => boolean,
  message: () => string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Manager integration worker did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once("exit", onExit);
  });
}

if (process.argv.includes(WORKER_ARGUMENT)) {
  await runSlowHistoryWorker().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  test("message-adapter scan does not read message history on the Manager HTTP thread", { timeout: 120_000 }, async t => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-message-scan-"));
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const fixturePackageRoot = path.join(fixtureRoot, "package");
    for (const directory of ["dist/plugins/packages", "dist/automatic-code", "ribiwebgui/dist", "assets", "docs"]) {
      fs.mkdirSync(path.join(fixturePackageRoot, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(fixturePackageRoot, "ribiwebgui/dist/index.html"), "<!doctype html><title>Manager fixture</title>");
    fs.writeFileSync(path.join(fixturePackageRoot, "docs/guide.md"), "# Manager fixture\n");
    fs.writeFileSync(path.join(fixturePackageRoot, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "0".repeat(64) }));
    const speechFixtureRoot = path.join(fixturePackageRoot, "plugin-adapters/rabi-speech");
    fs.mkdirSync(speechFixtureRoot, { recursive: true });
    fs.copyFileSync(path.join(packageRoot, "plugin-adapters/rabi-speech/model-catalog.json"), path.join(speechFixtureRoot, "model-catalog.json"));
    const companionFixtureRoot = path.join(fixturePackageRoot, "packages/rabi-companion");
    fs.mkdirSync(companionFixtureRoot, { recursive: true });
    for (const file of ["presets.json", "scene-rules.json"]) {
      fs.copyFileSync(path.join(packageRoot, "packages/rabi-companion", file), path.join(companionFixtureRoot, file));
    }
    for (const name of ["core", "gateway-runtime", "message-adapter-control"]) {
      const pluginId = `io.rabiroute.manager.${name}`;
      fs.cpSync(path.join(packageRoot, "dist/plugins/packages", pluginId),
        path.join(fixturePackageRoot, "dist/plugins/packages", pluginId), { recursive: true });
    }
    const stateRoot = path.join(fixtureRoot, "state");
    const rolesRoot = path.join(fixtureRoot, "roles");
    const routeRoot = path.join(fixtureRoot, "route");
    const profilePath = path.join(fixtureRoot, "scan-manager-profile.json");
    const applicationGenerationId = randomUUID();
    const controlToken = randomBytes(32).toString("hex");
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(profilePath, `${JSON.stringify({
      schemaVersion: 2,
      readyRequires: ["manager.message-adapter-control@1"],
      instances: ["core", "gateway-runtime", "message-adapter-control"].map(name => ({
        id: `manager:${name}`, package: `io.rabiroute.manager.${name}`,
        version: "1.0.0", enabled: true, config: {}, grants: []
      }))
    }, null, 2)}\n`, "utf8");

    const { executeRouteCatalogTransaction } = await import("./routeCatalogTransaction.js");
    executeRouteCatalogTransaction({
      requestId: "fixture", attemptToken: "fixture", operationId: "fixture",
      rootDir: fixtureRoot, routeRoot, rolesRoot, managerPort: 0, readOnly: false,
      operation: { kind: "replace", config: { gateways: [{
        id: "history-test", configName: "history-test", agentRoleId: "HistoryTest",
        enabled: false, messageAdapterType: "webhook", messageAdapters: ["webhook"], gatewayPort: 23001
      }] } }
    });
    let stdout = "";
    let stderr = "";
    const worker = spawn(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      WORKER_ARGUMENT
    ], {
      cwd: packageRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APPDATA: path.join(fixtureRoot, "appdata"),
        HOME: path.join(fixtureRoot, "home"),
        LOCALAPPDATA: path.join(fixtureRoot, "localappdata"),
        USERPROFILE: path.join(fixtureRoot, "userprofile"),
        GATEWAY_MANAGER_HOST: "127.0.0.1",
        GATEWAY_MANAGER_PORT: "0",
        GATEWAY_MANAGER_URL: "",
        RABIROUTE_APPLICATION_GENERATION_ID: applicationGenerationId,
        RABIROUTE_HOST_CONTROL_TOKEN: controlToken,
        RABIROUTE_HOSTED: "1",
        RABIROUTE_MANAGER_AUTOSTART: "0",
        RABIROUTE_MANAGER_READ_ONLY: "0",
        RABIROUTE_PACKAGE_ROOT: fixturePackageRoot,
        RABIROUTE_HOT_PATCH_WATCH: "0",
        RABIROUTE_HOT_PATCH_SOURCE_ROOT: "",
        RABIROUTE_HOT_PATCH_FULL_REPO: "0",
        RABIROUTE_PLUGIN_PACKAGE_ROOTS: path.join(fixturePackageRoot, "dist/plugins/packages"),
        RABIROUTE_PLUGIN_PROFILE: profilePath,
        RABIROUTE_STATE_ROOT: stateRoot,
        ROLES_DIR: rolesRoot,
        ROUTE_DIR: routeRoot
      }
    });
    assert.ok(worker.stdout);
    assert.ok(worker.stderr);
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stdout.on("data", chunk => { stdout += String(chunk); });
    worker.stderr.on("data", chunk => { stderr += String(chunk); });

    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await waitForExit(worker, 5_000).catch(() => undefined);
      }
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    await waitUntil(
      () => stdout.includes(READY_PREFIX) || worker.exitCode !== null || worker.signalCode !== null,
      () => `Manager did not emit structured READY. exit=${worker.exitCode}; stderr=${stderr}; stdout=${stdout}`
    );
    assert.equal(worker.exitCode, null, `Manager exited before READY. stderr=${stderr}`);
    const readyLine = stdout.split(/\r?\n/).find(line => line.startsWith(READY_PREFIX));
    assert.ok(readyLine, `Structured READY line is missing. stdout=${stdout}`);
    const ready = JSON.parse(readyLine.slice(READY_PREFIX.length)) as ReadyDescriptor;

    await waitUntil(() => stdout.includes(START_MANAGER_RETURNED_MARKER),
      () => `Manager startup incomplete. stderr=${stderr}; stdout=${stdout}`);
    let catalogReady = false;
    let catalogHealth: unknown;
    const catalogDeadline = Date.now() + 30_000;
    while (!catalogReady && Date.now() < catalogDeadline) {
      const body = await (await fetch(`${ready.baseUrl}/health`)).json() as any;
      catalogHealth = body.backgroundLifecycle?.routeCatalog;
      catalogReady = body.backgroundLifecycle?.routeCatalog?.state === "ready";
      if (!catalogReady) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(catalogReady, `fixture route catalog did not become ready: ${JSON.stringify(catalogHealth)}; stderr=${stderr}; stdout=${stdout}`);
    const scanPromise = fetch(`${ready.baseUrl}/api/scan/message-adapters`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const startedAt = performance.now();
    const health = await fetch(`${ready.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.ok(performance.now() - startedAt < 750, "scan blocked the health response");
    const scan = await scanPromise;
    assert.equal(scan.status, 200, await scan.text());
    assert.ok(!stdout.includes(SCAN_READ_MARKER), "HTTP scan synchronously probed message history");

    const shutdown = await fetch(`${ready.baseUrl}/_rabiroute/host/shutdown`, {
      method: "POST",
      headers: { "x-rabiroute-host-token": controlToken }
    });
    assert.equal(shutdown.status, 202, await shutdown.text());
    assert.equal(await waitForExit(worker, 30_000), 0, `Manager shutdown failed. stderr=${stderr}; stdout=${stdout}`);
  });
}
