import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";

const workerArgument = "--capability-isolation-fixture";
const readyPrefix = "RABIROUTE_MANAGER_READY:";

async function startFixtureWorker(): Promise<void> {
  const [{ startManager }, { PlanStorageStartupLifecycle }, { RouteCatalogStartupLifecycle }] = await Promise.all([
    import("./controlPlaneRoutes.js"), import("./planStorageStartupLifecycle.js"), import("./routeCatalogStartupLifecycle.js")
  ]);
  const pending = new Promise<never>(() => {});
  await startManager({
    planStorageStartupLifecycle: new PlanStorageStartupLifecycle({ rolesRoot: process.env.ROLES_DIR!, readOnly: false,
      attemptFactory: () => ({ result: pending, cancel: async () => {} }) }),
    routeCatalogStartupLifecycle: new RouteCatalogStartupLifecycle({ apply: () => {},
      attemptFactory: () => ({ result: pending, cancel: async () => {} }) })
  });
}

function exited(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Capability-isolation fixture did not exit.")), timeoutMs);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

if (process.argv.includes(workerArgument)) {
  await startFixtureWorker().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  for (const explicitRequired of [true, false]) {
  test(`missing package and feature failure preserve unrelated Manager writes (explicit required=${explicitRequired})`, { timeout: 90_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-capability-isolation-"));
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const packageRoot = path.join(root, "package"), packages = path.join(packageRoot, "dist/plugins/packages");
    for (const directory of [packages, path.join(packageRoot, "ribiwebgui/dist"), path.join(packageRoot, "dist/automatic-code"),
      path.join(packageRoot, "assets"), path.join(packageRoot, "docs"), path.join(root, "state")]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "ribiwebgui/dist/index.html"), "<!doctype html><title>Isolation fixture</title>");
    fs.writeFileSync(path.join(packageRoot, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "0".repeat(64) }));
    for (const relative of ["plugin-adapters/rabi-speech/model-catalog.json", "packages/rabi-companion/presets.json",
      "packages/rabi-companion/scene-rules.json", "packages/rabi-companion/observation.json"]) {
      const target = path.join(packageRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repository, relative), target);
    }
    const noBody = { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false },
      headers: { type: "object" }, body: { kind: "none" as const } };
    const writeContract = fixtureApiContract({ operationId: "fixture.isolation.write", pathTemplate: "/api/isolation/write", request: noBody });
    const failContract = fixtureApiContract({ operationId: "fixture.isolation.fail", pathTemplate: "/api/isolation/fail", request: noBody });
    const definitions = [
      { name: "diagnostics", provides: "fixture.diagnostics@1", requires: ["host.manager.operations@1", "host.manager.core@1"], source: `
export function activate(context) {
  const host = context.services.require('host.manager.operations@1');
  const core = context.services.require('host.manager.core@1');
  context.services.provide('fixture.diagnostics@1', {});
  context.effects.add(() => {
    const self = core.createLanAgentManagementOperations({
      registry: core.lanAgentRegistry, authority: core.lanAgentAuthority, managerIdentity: core.lanAgentManagerIdentity,
      enabled: () => core.rabiGlobalConfig.read().webguiLan.enabled, releases: core.lanAgentReleaseStore,
      readJsonBody: core.readJsonBody, jsonResponse: core.jsonResponse,
      isManagementRequestAuthorized: () => false, isReleaseRequestAuthorized: () => false
    }).filter(operation => operation.contract.pathTemplate === '/api/lan-agent/self');
    const reconciliation = core.createPluginCatalogOperations().filter(operation => operation.contract.pathTemplate === '/api/plugins/reconciliation');
    const metadata = core.createCorePublicOperations().filter(operation => operation.contract.pathTemplate === '/meta');
    const registration = host.registerOperations([...metadata, ...self, ...reconciliation]);
    return () => registration.dispose();
  });
}` },
      { name: "writer", provides: "fixture.writer@1", requires: ["host.manager.operations@1"], source: `
export function activate(context) {
  const api = context.services.require('host.manager.operations@1');
  context.services.provide('fixture.writer@1', {});
  context.effects.add(() => {
    const registration = api.registerOperations([{ contract: ${JSON.stringify(writeContract)}, handler: () => ({status:200,body:{ok:true,value:1}}) }]);
    return () => registration.dispose();
  });
}` },
      { name: "fragile", provides: "fixture.fragile@1", requires: ["host.manager.operations@1"], source: `
export function activate(context) {
  const api = context.services.require('host.manager.operations@1');
  context.services.provide('fixture.fragile@1', {});
  context.effects.add(() => {
    const registration = api.registerOperations([{ contract: ${JSON.stringify(failContract)}, handler: () => {
      context.lifecycle.fail(new Error('fixture feature failed'));
      return {status:200,body:{ok:true,value:1}};
    } }]);
    return () => registration.dispose();
  });
}` }
    ];
    for (const definition of definitions) {
      const pluginId = "io.test." + definition.name, target = path.join(packages, pluginId, "1.0.0");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: pluginId, version: "1.0.0",
        entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [definition.provides], requires: definition.requires, optional: [], permissions: [] }));
      fs.writeFileSync(path.join(target, "manager.mjs"), definition.source);
    }
    const profilePath = path.join(root, "profile.json");
    fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 2,
      readyRequires: definitions.filter(item => explicitRequired || item.name !== "fragile").map(item => item.provides), instances: [
      ...definitions.map(item => ({ id: "test:" + item.name, package: "io.test." + item.name, version: "1.0.0", enabled: true, config: {}, grants: [] })),
      { id: "test:missing", package: "io.test.missing", version: "1.0.0", enabled: true, config: {}, grants: [] }
    ] }));
    const state = path.join(root, "state");
    new RabiGlobalConfigStore(state).patch({ webguiLan: { enabled: true } });
    const authority = new LanAgentAuthority({ statePath: path.join(state, "data/.runtime/lan-agent-authority.json") });
    const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "unbound-computer");
    const token = randomBytes(32).toString("hex");
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), workerArgument], { cwd: repository,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        APPDATA: path.join(root, "appdata"), HOME: path.join(root, "home"), LOCALAPPDATA: path.join(root, "localappdata"), USERPROFILE: path.join(root, "userprofile"),
        GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: "0", GATEWAY_MANAGER_URL: "",
        RABIROUTE_APPLICATION_GENERATION_ID: randomUUID(), RABIROUTE_HOST_CONTROL_TOKEN: token, RABIROUTE_HOSTED: "1",
        RABIROUTE_MANAGER_AUTOSTART: "0", RABIROUTE_MANAGER_READ_ONLY: "0", RABIROUTE_PACKAGE_ROOT: packageRoot,
        RABIROUTE_HOT_PATCH_WATCH: "0", RABIROUTE_HOT_PATCH_SOURCE_ROOT: "", RABIROUTE_HOT_PATCH_FULL_REPO: "0",
        RABIROUTE_PLUGIN_PACKAGE_ROOTS: packages, RABIROUTE_PLUGIN_PROFILE: profilePath,
        RABIROUTE_STATE_ROOT: path.join(root, "state"), ROLES_DIR: path.join(root, "roles"), ROUTE_DIR: path.join(root, "routes")
      } });
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += String(data); }); child.stderr!.on("data", data => { stderr += String(data); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child, 5000).catch(() => undefined); }
      fs.rmSync(root, { recursive: true, force: true }); });
    let endpoint: string | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      const line = stdout.split(/\r?\n/).find(line => line.startsWith(readyPrefix));
      if (line) { endpoint = JSON.parse(line.slice(readyPrefix.length)).baseUrl; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(endpoint, `Fixture not ready. stderr=${stderr.slice(-4000)} stdout=${stdout.slice(-4000)}`);
    const initial = await (await fetch(endpoint + "/meta", { signal: AbortSignal.timeout(3000) })).json();
    assert.equal(initial.health.live, true); assert.equal(initial.health.requiredReady, true); assert.equal(initial.health.state, "degraded");
    // Join the native reconciliation queue so a delayed post-READY activation
    // cannot re-enable the fixture feature after its deliberate runtime failure.
    const settled = await fetch(endpoint + "/api/plugins/reconciliation", { method: "POST" });
    assert.equal(settled.status, 200); await settled.arrayBuffer();
    assert.equal((await fetch(endpoint + "/api/isolation/write", { method: "POST" })).status, 200);
    // Optional business plugins start after READY; retry only an absent fixture route,
    // never a received failure trigger or an uncertain mutation.
    let triggerStatus = 404;
    const triggerDeadline = Date.now() + 15_000;
    while (triggerStatus === 404 && Date.now() < triggerDeadline) {
      const trigger = await fetch(endpoint + "/api/isolation/fail", { method: "POST" });
      triggerStatus = trigger.status; await trigger.arrayBuffer();
      if (triggerStatus === 404) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(triggerStatus, 200);
    let missing: string[] = [];
    const failureDeadline = Date.now() + 3000;
    while (Date.now() < failureDeadline) {
      const meta = await (await fetch(endpoint + "/meta", { signal: AbortSignal.timeout(1000) })).json();
      missing = meta.pluginGeneration.readiness.missingCapabilities;
      if (meta.pluginGeneration.sequence >= 2 && (!explicitRequired || missing.includes("fixture.fragile@1"))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(missing.includes("fixture.fragile@1"), explicitRequired);
    assert.equal((await fetch(endpoint + "/api/isolation/write", { method: "POST" })).status, 200);
    assert.equal((await fetch(endpoint + "/api/isolation/fail", { method: "POST" })).status, 404);
    const self = await fetch(endpoint + "/api/lan-agent/self", { headers: { authorization: `Bearer ${credential.token}` } });
    assert.equal(self.status, 200);
    assert.equal((await self.json()).data.nodeId, credential.nodeId);
    // The fixture intentionally listens only on loopback, so LAN discovery is
    // disabled. Use the real client's explicit, freshly published READY origin;
    // its ordinary authenticated identity/live checks still run. A missing
    // declared feature does not disable an unrelated authenticated write.
    const client = createManagerClient({ managerUrl: endpoint, credential: credential.token, timeoutMs: 5000 });
    const written = await client.request("POST", "/api/isolation/write");
    assert.equal(written.statusCode, 200);
    assert.equal(written.ok, true);
    const shutdown = await fetch(endpoint + "/_rabiroute/host/shutdown", { method: "POST", headers: { "x-rabiroute-host-token": token } });
    assert.equal(shutdown.status, 202); await shutdown.arrayBuffer();
    assert.equal(await exited(child, 12_000), 0, stderr.slice(-4000));
  });
  }
}
