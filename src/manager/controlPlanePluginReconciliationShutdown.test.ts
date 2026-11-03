import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { PluginPackageCatalog, loadPluginProfile, parsePluginProfile, type LoadedPluginProfile } from "../plugin-kernel/profile.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { ManagerRuntimeOwner, type ManagerRuntimeOwnerHooks } from "./managerRuntimeOwner.js";

const stopBudgetMs = 2_000;

class FixtureRuntimeOwner extends ManagerRuntimeOwner<unknown> {
  constructor(hooks: ManagerRuntimeOwnerHooks<unknown>) {
    super({ ...hooks, resourceStopTimeoutMs: stopBudgetMs, teardownTimeoutMs: 15_000 });
  }
}

type ControlPlanePorts = {
  owner: ManagerRuntimeOwner<unknown>;
  reconcile(reason: string): Promise<void>;
  tail(): Promise<void>;
  profile(): LoadedPluginProfile | undefined;
};

/** Execute the actual composition statements, including their lexical startup boundary. */
function actualControlPlane(input: {
  root: string;
  events: string[];
  beforeCatalog?: boolean;
  catalog?: PluginPackageCatalog;
  kernel?: GenerationRuntime;
  previous?: LoadedPluginProfile;
}): ControlPlanePorts {
  const filename = new URL("./controlPlaneRoutes.ts", import.meta.url);
  const source = ts.createSourceFile(filename.pathname, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const variables = new Map<string, ts.VariableDeclaration>();
  const registrations = new Map<string, ts.ExpressionStatement>();
  let assignPreparationStop: ts.ExpressionStatement | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node);
    if (ts.isExpressionStatement(node)) {
      const expression = node.expression;
      if (ts.isBinaryExpression(expression) && expression.left.getText(source) === "stopPluginPackagePreparation") assignPreparationStop = node;
      if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
        && expression.expression.expression.getText(source) === "managerRuntimeOwner"
        && expression.arguments[0] && ts.isStringLiteral(expression.arguments[0])) {
        registrations.set(expression.arguments[0].text, node);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  const declaration = (name: string): string => {
    const node = variables.get(name);
    assert.ok(node, `Missing actual composition declaration: ${name}`);
    return `const ${node.getText(source)};`;
  };
  const registration = (name: string): string => {
    const node = registrations.get(name);
    assert.ok(node, `Missing actual composition resource: ${name}`);
    return node.getText(source);
  };
  const earlyStop = variables.get("stopPluginPackagePreparation");
  const ownerDeclaration = variables.get("managerRuntimeOwner")!;
  const earlyStopText = earlyStop && earlyStop.pos < ownerDeclaration.pos ? earlyStop.parent.parent.getText(source) : "";
  const body = `
    const { ManagerRuntimeOwner, loadPluginProfile, path, rootDir, events } = deps;
    let shuttingDown = false, activeStorageLifecycleGeneration;
    const activeServer = { removeAllListeners() {}, on() {}, removeListener() {} };
    const managerStoppingRequest = () => {}, closeManagerEventClients = () => {};
    const agentRequests = { close: async () => {} }, agentRequestRouteReconciliation = { stopAccepting() {} };
    const managerOperationalLog = { record: (...args) => events.push(String(args[1])) }, managerOperationalError = error => error;
    ${earlyStopText}
    ${declaration("managerRuntimeOwner")}
    if (deps.beforeCatalog) return { owner: managerRuntimeOwner };
    const managerPluginPackageCatalog = deps.catalog, managerPluginKernel = deps.kernel;
    ${assignPreparationStop?.getText(source) ?? ""}
    ${registration("plugin_package_catalog")}
    ${registration("manager_plugin_kernel")}
    let managerPluginReconciliationTail = Promise.resolve(), loadedManagerPluginProfile = deps.previous, pendingManagerPluginProfile;
    let installedGatewayEndpointTypes, installedEndpointRouteDeclarations;
    const managerPluginSettings = { snapshot: async () => ({ profile: deps.profile }) }, managerPluginProfilePath = "fixture-profile";
    const readPluginManagementManifest = () => {}, readInstalledGatewayEndpointTypes = async () => ({ types: new Set(), diagnostics: [] });
    const readInstalledEndpointRouteDeclarations = async () => ({ declarations: [], diagnostics: [] });
    const managerPluginHostServices = [], managerServicesReady = false, managerReadOnly = true;
    ${declaration("reconcileManagerPlugins")}
    ${registration("manager_plugin_reconciliation")}
    return { owner: managerRuntimeOwner, reconcile: reconcileManagerPlugins, tail: () => managerPluginReconciliationTail,
      profile: () => loadedManagerPluginProfile };
  `;
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const instantiate = new Function("deps", compiled) as (dependencies: object) => ControlPlanePorts;
  return instantiate({ ...input, rootDir: input.root, ManagerRuntimeOwner: FixtureRuntimeOwner, loadPluginProfile, path,
    profile: parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: [{ id: "pending", package: "io.test.pending",
      version: "1.0.0", enabled: true, config: {}, grants: [] }] }) });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-reconciliation-shutdown-"));
  const worker = path.join(root, "gated-package-worker.mjs");
  fs.writeFileSync(worker, `import fs from "node:fs"; import path from "node:path";
    process.once("message", request => {
      const stage = path.join(request.task.runtimeRoot, ".staging", request.id);
      fs.mkdirSync(stage, { recursive: true }); fs.writeFileSync(path.join(stage, "partial"), "unpublished-fixture");
      fs.writeFileSync(path.join(request.task.runtimeRoot, "started-" + request.task.packageId + ".json"), JSON.stringify({ stage, pid: process.pid }));
      setInterval(() => {}, 1000);
    });`);
  const catalog = new PluginPackageCatalog([root], { loading: { maxConcurrency: 1, workerURL: pathToFileURL(worker) } });
  const oldService = Object.freeze({ revision: "published" });
  const oldModule: PluginModule = { activate(context) { context.services.provide("test.old@1", oldService); } };
  const kernel = new GenerationRuntime({ host: "manager", executor: { async prepare() { return oldModule; } } });
  const old: PluginCandidate = { instanceId: "old", revision: "published", config: {},
    entry: { execution: "in_process", path: "fixture.mjs" }, manifest: { schemaVersion: 2, id: "io.test.old", version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./fixture.mjs" } }, provides: ["test.old@1"], requires: [], optional: [], permissions: [] } };
  await kernel.switch([old]);
  const originalGeneration = kernel.current().id;
  const previous: LoadedPluginProfile = { profile: parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: [] }),
    candidates: [old], packages: [], loadFailures: [], grants: () => [] };
  const events: string[] = [], disposals: Promise<void>[] = [];
  const realDispose = catalog.dispose.bind(catalog);
  catalog.dispose = () => { events.push("cancel-package-preparation"); const disposal = realDispose(); disposals.push(disposal); return disposal; };
  const realShutdown = kernel.shutdown.bind(kernel);
  let shutdownStarted = false;
  kernel.shutdown = options => {
    if (!shutdownStarted) {
      shutdownStarted = true;
      assert.equal(kernel.current().id, originalGeneration);
      assert.equal(kernel.current().services.services.get("test.old@1")?.value, oldService);
      events.push("published-owner-shutdown");
    }
    return realShutdown(options);
  };
  const app = actualControlPlane({ root, catalog, kernel, previous, events });
  t.after(async () => {
    await catalog.dispose();
    await kernel.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pending = app.reconcile("fixture bundle reload");
  const reconciliationStopped = assert.rejects(pending, /reconciliation stopped during shutdown/);
  const started = path.join(root, "data", "plugins", ".runtime", "started-io.test.pending.json");
  const deadline = Date.now() + stopBudgetMs;
  while (!fs.existsSync(started)) {
    if (Date.now() >= deadline) throw new Error("The original package worker did not enter its staging operation.");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const stage = JSON.parse(fs.readFileSync(started, "utf8")) as { stage: string; pid: number };
  const queued = catalog.loadPackage("io.test.queued", "1.0.0", path.join(root, "data", "plugins", ".runtime"), "manager");
  const queuedStopped = assert.rejects(queued, /stopped before loading began/);
  assert.equal(catalog.snapshot().queued, 1);
  return { app, catalog, previous, events, disposals, stage, root, reconciliationStopped, queuedStopped };
}

test("global shutdown cancels original package preparation before a mid-PATCH resource joins reconciliation", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.app.owner.register("fixture_mid_patch", async () => { f.events.push("request-drain"); await f.app.tail(); });
  await f.app.owner.teardown("fixture signal");
  await Promise.all([f.reconciliationStopped, f.queuedStopped]);
  assert.ok(f.events.indexOf("cancel-package-preparation") < f.events.indexOf("request-drain"));
  assert.equal(f.app.profile(), f.previous);
  assert.equal(f.catalog.snapshot().active, 0);
  assert.equal(f.catalog.snapshot().queued, 0);
  assert.deepEqual(f.catalog.snapshot().workerPids, []);
  assert.equal(fs.existsSync(f.stage.stage), false, "The original staging cleanup must finish before shutdown succeeds.");
  assert.equal(fs.existsSync(path.join(f.root, "data", "plugins", ".runtime", "started-io.test.queued.json")), false);
  assert.throws(() => process.kill(f.stage.pid, 0), { code: "ESRCH" });
  assert.ok(f.disposals.length >= 2, "The original catalog resource must join the cancellation started by ingress fencing.");
  assert.ok(f.disposals.every(disposal => disposal === f.disposals[0]));
});

test("global shutdown is safe before the package catalog has been constructed", async () => {
  const app = actualControlPlane({ root: "unused", events: [], beforeCatalog: true });
  await app.owner.teardown("fixture early startup failure");
});

test("cancelled package preparation cannot certify an independently unconfirmed accepted request", { timeout: 15_000 }, async t => {
  const f = await fixture(t), acceptedWork = deferred();
  t.after(() => acceptedWork.resolve());
  f.app.owner.register("fixture_unconfirmed_request", async () => { await f.app.tail(); await acceptedWork.promise; });
  await assert.rejects(f.app.owner.teardown("fixture accepted request"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(item => item instanceof Error && /fixture_unconfirmed_request/.test(item.message)));
    return true;
  });
  acceptedWork.resolve();
  await Promise.all([f.reconciliationStopped, f.queuedStopped]);
  assert.deepEqual(f.catalog.snapshot().workerPids, []);
});
