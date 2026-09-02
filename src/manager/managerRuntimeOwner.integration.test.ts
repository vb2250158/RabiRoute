import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
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
  assert.match(control, /managerRuntimeOwner\.publish\(Object\.freeze\(\{[\s\S]*roleStorage: roleStorageApplication,[\s\S]*planStorage: planStorageStartupLifecycle,[\s\S]*routeCatalog: routeCatalogStartupLifecycle,[\s\S]*requestHandler: handleManagerRequest/);
});

test("Manager teardown fences ingress and uses only the shared owner flight", () => {
  assert.match(control, /fenceIngress\(reason\)[\s\S]*shuttingDown = true;[\s\S]*managerStoppingRequest/);
  assert.match(control, /const failManagerStartup[\s\S]*managerRuntimeOwner\.teardown\(phase, error\)/);
  assert.match(control, /shutdownManager = \(reason: string\)[\s\S]*managerRuntimeOwner\.teardown\(`signal:\$\{reason\}`\)/);
  assert.doesNotMatch(control, /cleanupMandatoryManagerResourcesInOrder|disposeManagerCordisRuntime|managerSharedResourcesRuntime\.unmount\(\)/);
});

test("Manager resources are registered in acquisition order and reverse teardown is delegated", () => {
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
    "lan_agent_upgrade",
    "manager_lan_discovery",
    "config_watcher",
    "plugin_package_watcher"
  ];
  let cursor = -1;
  for (const owner of owners) {
    const next = control.indexOf(`managerRuntimeOwner.register("${owner}"`, cursor + 1);
    assert.ok(next > cursor, `${owner} must be registered after the preceding acquisition`);
    cursor = next;
  }
});

test("Runtime owner integration retains the storage CAS application boundary", () => {
  assert.match(control, /function currentRoleStorageApplication\(\): RoleStorageApplication/);
  assert.match(control, /resolveRoleStorageApplication\(\)\.commands\.submitPlanFeedback/);
  assert.match(control, /context\.roleStorageApplication \?\? currentRoleStorageApplication/);
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
  assert.match(control, /new GenerationRuntime\([\s\S]*?\);\s*managerRuntimeOwner\.register\("manager_plugin_kernel"/);
  assert.match(control, /startManagerDiscoveryPublisher\([\s\S]*?\);\s*managerRuntimeOwner\.register\("manager_lan_discovery"/);
  assert.match(control, /startConfigWatcher\([\s\S]*?managerRuntimeOwner\.register\("config_watcher"/);
  assert.match(control, /startPluginPackageWatcher\([\s\S]*?managerRuntimeOwner\.register\("plugin_package_watcher"/);
});
