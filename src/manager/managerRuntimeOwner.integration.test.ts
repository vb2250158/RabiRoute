import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ManagerRuntimeOwner } from "./managerRuntimeOwner.js";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const control = fs.readFileSync(path.join(root, "src", "manager", "controlPlaneRoutes.ts"), "utf8");
const managerEntry = fs.readFileSync(path.join(root, "src", "manager.ts"), "utf8");

function occurrences(fragment: string): number {
  return control.split(fragment).length - 1;
}

test("Manager control plane has one owner and one atomic publication boundary", () => {
  assert.equal(occurrences("new ManagerRuntimeOwner<"), 1);
  assert.equal(occurrences("managerRuntimeOwner.publish("), 1);
  assert.match(control, /publish\(publication\)[\s\S]*removeAllListeners\("request"\)[\s\S]*on\("request", publication\.requestHandler\)[\s\S]*activeStorageLifecycleGeneration = publication/);
  assert.match(control, /managerRuntimeOwner\.publish\(Object\.freeze\(\{[\s\S]*roleStorage: roleStorageApplication,[\s\S]*planStorage: planStorageStartupLifecycle,[\s\S]*routeCatalog: routeCatalogStartupLifecycle,[\s\S]*requestHandler: withAutomaticCodeRequest\(handleManagerRequest\)/);
});

test("Manager teardown fences ingress and uses only the shared owner flight", () => {
  assert.match(control, /fenceIngress\(reason\)[\s\S]*shuttingDown = true;[\s\S]*managerStoppingRequest/);
  assert.match(control, /const failManagerStartup[\s\S]*managerRuntimeOwner\.teardown\(phase, error\)/);
  assert.match(control, /shutdownManager = \(reason: string\)[\s\S]*managerRuntimeOwner\.teardown\(`signal:\$\{reason\}`\)/);
  assert.doesNotMatch(control, /cleanupMandatoryManagerResourcesInOrder|disposeManagerCordisRuntime|managerSharedResourcesRuntime\.unmount\(\)/);
});

test("Manager resources are registered in acquisition order and reverse teardown is delegated", async () => {
  const owners = [
    "cordis_root",
    "http_server",
    "role_storage",
    "plan_storage_startup",
    "route_catalog_startup",
    "manager_plugin_process_leases",
    "lan_agent_registry",
    "manager_plugin_kernel",
    "request_scoped_resources",
    "manual_trigger_processes",
    "manager_plugin_upgrade",
    "manager_lan_discovery",
    "config_watcher",
    "plugin_package_watcher"
  ];
  let cursor = -1;
  for (const owner of owners) {
    const registration = owner === "manager_plugin_kernel" ? "registerWithBudget" : "register";
    const next = control.indexOf(`managerRuntimeOwner.${registration}("${owner}"`, cursor + 1);
    assert.ok(next > cursor, `${owner} must be registered after the preceding acquisition`);
    cursor = next;
  }
  assert.match(control, /activeServer\.on\("upgrade", managedUpgrade\);\s*managerRuntimeOwner\.register\("manager_plugin_upgrade", \(\) => \{ activeServer\.removeListener\("upgrade", managedUpgrade\);/);
  const core = fs.readFileSync(path.join(root, "plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs"), "utf8");
  assert.match(core, /registerUpgrades\(context\.identity\.instanceId, \[runtime\.createLanAgentConnectionOperation\(\)\]\)/);
  const fenceAt = core.indexOf("upgrades.stopAccepting();");
  const httpDrainAt = core.indexOf("await registration.dispose();", fenceAt);
  const upgradeDrainAt = core.indexOf("await upgrades.dispose();", httpDrainAt);
  assert.ok(fenceAt >= 0 && httpDrainAt > fenceAt && upgradeDrainAt > httpDrainAt, "core fences upgrades, drains accepted HTTP commands, then closes their upgrade transport");
  assert.match(core.slice(httpDrainAt, upgradeDrainAt), /catch \(error\) \{ errors\.push\(error\); \}/);
  assert.match(core, /if \(errors\.length === 1\) throw errors\[0\]/);
  assert.match(core, /catch \(error\) \{ await upgrades\.dispose\(\); throw error; \}/);
  const stopped: string[] = [];
  let release!: () => void;
  const lastStop = new Promise<void>(resolve => { release = resolve; });
  const runtime = new ManagerRuntimeOwner({ fenceIngress: () => stopped.push("fence"), publish: () => {}, unpublish: () => stopped.push("unpublish") });
  for (const owner of owners) runtime.register(owner, async () => { stopped.push(owner); if (owner === owners.at(-1)) await lastStop; });
  runtime.publish(Object.freeze({ generation: "controlled" }));
  const retirement = runtime.teardown("controlled");
  assert.deepEqual(stopped, ["fence", "unpublish"]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(stopped, ["fence", "unpublish", owners.at(-1)]);
  release(); await retirement;
  assert.deepEqual(stopped, ["fence", "unpublish", ...[...owners].reverse()]);
});

test("Runtime owner integration retains the storage CAS application boundary", () => {
  const syntax = ts.createSourceFile("controlPlaneRoutes.ts", control, ts.ScriptTarget.Latest, true);
  const method = (name: string) => {
    const declaration = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `${name} must remain an explicit composition function`); return declaration.getText(syntax);
  };
  assert.match(method("currentRoleStorageApplication"), /return activeStorageLifecycleGeneration\.roleStorage/);
  assert.match(method("createPersonaStorageOperationsContext"), /application: currentRoleStorageApplication/);
  const feedback = method("submitAgentPlanFeedback");
  assert.match(feedback, /const application = currentRoleStorageApplication\(\);[\s\S]*application\.queries\.planFeedback[\s\S]*application\.commands\.submitPlanFeedback/);
  assert.match(feedback, /expectedRevision: projection\.planRevision/);
  assert.match(feedback, /idempotencyKey: roleStorageOperationKey\("agent-plan-feedback-reply", input\.deliveryId\)/);
  const storage = fs.readFileSync(path.join(root, "src/manager/personaStorageOperations.ts"), "utf8");
  assert.match(storage, /application = this\.context\.application\(\)/);
  assert.match(storage, /this\.context\.application\(\) !== application/);
  assert.match(storage, /expectedRevision: singleHeader\(input\.request, "if-match"\) \?\? singleHeader\(input\.request, "x-rabiroute-expected-revision"\), authorize: admission\.assertCurrent/);
  assert.match(control, /personaStorageContext: Object\.freeze\(createPersonaStorageOperationsContext\(\)\)/);
  const persona = fs.readFileSync(path.join(root, "plugins/builtin/io.rabiroute.manager.persona/1.0.0/manager.mjs"), "utf8");
  assert.match(persona, /new runtime\.PersonaStorageOwner\(runtime\.personaStorageContext\)/);
  assert.match(persona, /await runtime\.managerPluginRoutes\.registerOperationsAsync\(context\.identity\.instanceId, runtime\.createPersonaStorageOperations\(owner\), context\.lifecycle\.signal\)/);
  assert.match(persona, /try \{ await registration\.dispose\(\); \} catch \(error\) \{ failures\.push\(error\); \}\s*try \{ await owner\.stop\(\); \} catch \(error\) \{ failures\.push\(error\); \}/);
  assert.match(control, /ensurePlanSecretaryBindingForEvent\(currentRoleStorageApplication\(\)/);
  assert.match(control, /replacePlanTaskBindingForDelivery\(currentRoleStorageApplication\(\)/);
});

test("RuntimeOwner and signal fencing precede every fallible resource acquisition", () => {
  const owner = control.indexOf("new ManagerRuntimeOwner<");
  const signal = control.indexOf("installManagerSignalHandlers", owner);
  const cordis = control.indexOf("getBuiltinManagerCordisRoot()", owner);
  const server = control.indexOf("http.createServer", owner);
  assert.ok(owner >= 0 && signal > owner && cordis > signal && server > cordis);
  assert.doesNotMatch(managerEntry, /getBuiltinManagerCordisRoot|managerCordisRoot/);
});

test("disposable acquisitions register with RuntimeOwner at their acquisition site", () => {
  assert.match(control, /getBuiltinManagerCordisRoot\(\);\s*managerRuntimeOwner\.register\("cordis_root"/);
  assert.match(control, /http\.createServer\(managerStartingRequest\);\s*managerRuntimeOwner\.register\("http_server"/);
  assert.match(control, /new RoleStorageApplication\([\s\S]*?\);\s*managerRuntimeOwner\.register\("role_storage"/);
  assert.match(control, /new GenerationRuntime\([\s\S]*?\);\s*managerRuntimeOwner\.registerWithBudget\("manager_plugin_kernel", budget => managerPluginKernel\?\.shutdown\(\{\s*timeoutMs: Math\.max\(1, Math\.floor\(budget\.deadlineAt - performance\.now\(\)\)\)/);
  assert.match(control, /managerRuntimeOwner\.register\("manager_lan_discovery", async \(\) => \{[\s\S]*?managerLanDiscoveryFlight\?\.catch[\s\S]*?const startLanDiscovery/);
  assert.match(control, /startConfigWatcher\([\s\S]*?managerRuntimeOwner\.register\("config_watcher"/);
  assert.match(control, /startPluginPackageWatcher\([\s\S]*?managerRuntimeOwner\.register\("plugin_package_watcher"/);
});

test("deferred discovery reserves its owner before publication and starts after READY", () => {
  const reserved = control.indexOf('managerRuntimeOwner.register("manager_lan_discovery"');
  const published = control.indexOf("managerRuntimeOwner.publish(");
  const ready = control.indexOf("console.log(managerReadyLine(");
  const started = control.indexOf("void startLanDiscovery().catch");
  assert.ok(reserved > 0 && reserved < published);
  assert.ok(published < ready && ready < started);
  assert.equal(occurrences('managerRuntimeOwner.register("manager_lan_discovery"'), 1);
});
