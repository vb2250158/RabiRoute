import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

const WORKER_ARGUMENT = "--rabiroute-hung-plan-storage-worker";
const HUNG_ATTEMPT_MARKER = "RABIROUTE_TEST_HUNG_PLAN_STORAGE_ATTEMPT_STARTED";
const START_MANAGER_RETURNED_MARKER = "RABIROUTE_TEST_START_MANAGER_RETURNED";
const CANCELLATION_MARKER = "RABIROUTE_TEST_HUNG_PLAN_STORAGE_ATTEMPT_CANCELLED";
const READY_PREFIX = "RABIROUTE_MANAGER_READY:";

type ReadyDescriptor = Readonly<{
  protocolVersion: 1;
  applicationGenerationId: string;
  managerInstanceId: string;
  pid: number;
  baseUrl: string;
  readyAt: string;
}>;

async function runHungPlanStorageWorker(): Promise<void> {
  const runtimeModule = (name: string) => {
    const built = new URL(`../../dist/manager/${name}.js`, import.meta.url);
    return import(fs.existsSync(fileURLToPath(built)) ? built.href : `./${name}.js`);
  };
  const [{ PlanStorageStartupLifecycle }, { startManager }, { RouteCatalogStartupLifecycle }] = await Promise.all([
    runtimeModule("planStorageStartupLifecycle"),
    runtimeModule("controlPlaneRoutes"),
    runtimeModule("routeCatalogStartupLifecycle")
  ]);
  const neverCompletes = new Promise<never>(() => {});
  const partial = process.env.RABIROUTE_TEST_PARTIAL_PLAN_STORAGE === "1";
  if (partial) {
    const { ensurePersonaPlanWorkflow } = await import("../personaPlanWorkflow.js");
    const roleDir = path.join(String(process.env.ROLES_DIR), "ReadyRole");
    fs.mkdirSync(roleDir, { recursive: true });
    ensurePersonaPlanWorkflow(roleDir);
  }
  const lifecycle = new PlanStorageStartupLifecycle({
    rolesRoot: String(process.env.ROLES_DIR || ""),
    readOnly: false,
    attemptTimeoutMs: 60_000,
    retryBaseMs: 60_000,
    retryMaxMs: 60_000,
    attemptFactory: (onProgress: (summary: PlanStorageStartupGateSummary) => void) => {
      process.stdout.write(`${HUNG_ATTEMPT_MARKER}\n`);
      if (partial) onProgress({ roles: 2, migrated: 0, reconciled: 0, failures: [], skipped: false, readyRoleIds: ["ReadyRole"] });
      return Object.freeze({
        result: neverCompletes,
        cancel: async () => {
          process.stdout.write(`${CANCELLATION_MARKER}\n`);
        }
      });
    }
  });

  // This fixture exercises plan startup, not host process discovery or route activation.
  const routeLifecycle = new RouteCatalogStartupLifecycle({
    apply: () => {},
    attemptFactory: () => ({ result: neverCompletes, cancel: async () => {} })
  });
  await startManager({ planStorageStartupLifecycle: lifecycle, routeCatalogStartupLifecycle: routeLifecycle });
  process.stdout.write(`${START_MANAGER_RETURNED_MARKER}\n`);
}

async function waitUntil(
  predicate: () => boolean,
  message: () => string,
  timeoutMs = 30_000
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
  await runHungPlanStorageWorker().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  for (const partial of [false, true]) {
  test(`Manager emits structured READY before hung plan storage and permits only recovered roles (partial=${partial})`, { timeout: 45_000 }, async t => {
    const fixtureStartedAt = Date.now();
    const timings: string[] = [];
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-ready-plan-storage-"));
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
    for (const file of ["presets.json", "scene-rules.json", "observation.json"]) {
      fs.copyFileSync(path.join(packageRoot, "packages/rabi-companion", file), path.join(companionFixtureRoot, file));
    }
    const stateRoot = path.join(fixtureRoot, "state");
    const rolesRoot = path.join(fixtureRoot, "roles");
    const routeRoot = path.join(fixtureRoot, "route");
    const profilePath = path.join(fixtureRoot, "empty-manager-profile.json");
    const applicationGenerationId = randomUUID();
    const controlToken = randomBytes(32).toString("hex");
    fs.mkdirSync(stateRoot, { recursive: true });
    const pluginNames = ["core", "persona"];
    for (const name of pluginNames) {
      const pluginId = `io.rabiroute.manager.${name}`;
      fs.cpSync(path.join(packageRoot, "dist/plugins/packages", pluginId),
        path.join(fixturePackageRoot, "dist/plugins/packages", pluginId), { recursive: true });
    }
    fs.writeFileSync(profilePath, `${JSON.stringify({
      schemaVersion: 2,
      readyRequires: ["manager.persona@1"],
      instances: pluginNames.map(name => ({
        id: `manager:${name}`, package: `io.rabiroute.manager.${name}`,
        version: "1.0.0", enabled: true, config: {}, grants: []
      }))
    }, null, 2)}\n`, "utf8");

    let stage = "spawn";
    const mark = (next: string) => { stage = next; timings.push(`${next}:${Date.now() - fixtureStartedAt}ms`); };
    mark("spawn");
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
        RABIROUTE_TEST_PARTIAL_PLAN_STORAGE: partial ? "1" : "0",
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
      t.diagnostic(`Fixture stage timings: ${timings.join(", ")}; elapsed=${Date.now() - fixtureStartedAt}ms`);
      if (t.signal.aborted) t.diagnostic(`Manager fixture interrupted at ${stage}. stderr=${stderr}; stdout=${stdout}`);
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

    await waitUntil(
      () => stdout.includes(HUNG_ATTEMPT_MARKER) && stdout.includes(START_MANAGER_RETURNED_MARKER),
      () => `Manager did not finish post-READY startup around the hung attempt. stderr=${stderr}; stdout=${stdout}`
    );
    assert.ok(
      stdout.indexOf(READY_PREFIX) < stdout.indexOf(HUNG_ATTEMPT_MARKER),
      `Hung plan attempt started before structured READY. stdout=${stdout}`
    );
    assert.equal(ready.protocolVersion, 1);
    assert.equal(ready.applicationGenerationId, applicationGenerationId);
    assert.equal(ready.pid, worker.pid);
    const readyUrl = new URL(ready.baseUrl);
    assert.equal(readyUrl.hostname, "127.0.0.1");
    assert.ok(Number(readyUrl.port) > 0, `Manager did not publish a dynamic TCP endpoint: ${ready.baseUrl}`);

    mark("health");
    const healthResponse = await fetch(`${ready.baseUrl}/health`);
    const healthPayload = await healthResponse.json() as Record<string, any>;
    assert.equal(healthResponse.status, 200, JSON.stringify(healthPayload));
    assert.equal(healthPayload.health.live, true);
    assert.equal(healthPayload.health.requiredReady, true);
    assert.equal(healthPayload.health.businessReady, false);
    assert.equal(healthPayload.backgroundLifecycle.planStorageStartup.state, "running");

    mark("unready-plan-mutation");
    const planMutation = await fetch(`${ready.baseUrl}/api/roles/YeYu/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const planMutationPayload = await planMutation.json() as Record<string, unknown>;
    assert.equal(planMutation.status, 503, JSON.stringify(planMutationPayload));
    assert.equal(planMutationPayload.error, "PLAN_STORAGE_STARTUP_UNAVAILABLE");

    if (partial) {
      mark("ready-plan-create");
      const created = await fetch(`${ready.baseUrl}/api/roles/ReadyRole/plans`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          title: "Example partial startup plan", focus: "Partial recovery", keywords: ["startup"],
          status: "分析中", currentStepId: "verify", steps: [{ id: "verify", title: "Verify recovery" }]
        })
      });
      const body = await created.text();
      assert.equal(created.status, 201, body);
      mark("ready-plan-list");
      const listed = await fetch(`${ready.baseUrl}/api/roles/ReadyRole/plans`);
      const list = await listed.json() as { data: Array<{ title: string }> };
      assert.equal(listed.status, 200, JSON.stringify(list));
      assert.ok(list.data.some(plan => plan.title === "Example partial startup plan"));
      mark("post-create-health");
      const stillLive = await fetch(`${ready.baseUrl}/health`);
      const status = await stillLive.json() as Record<string, any>;
      assert.equal(status.health.live, true);
      assert.equal(status.health.businessReady, false);
      assert.equal(status.backgroundLifecycle.planStorageStartup.summary.readyRoles, 1);
    }

    mark("shutdown");
    const shutdown = await fetch(`${ready.baseUrl}/_rabiroute/host/shutdown`, {
      method: "POST",
      headers: { "x-rabiroute-host-token": controlToken }
    });
    assert.equal(shutdown.status, 202, await shutdown.text());
    assert.equal(await waitForExit(worker, 12_000), 0, `Manager shutdown failed. stderr=${stderr}; stdout=${stdout}`);
    assert.equal((stdout.match(new RegExp(CANCELLATION_MARKER, "g")) || []).length, 1);
  });
  }
}
