import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

function source(fileName: string): string {
  return fs.readFileSync(path.join(sourceRoot, fileName), "utf8");
}

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [target];
  });
}

test("online plan storage paths do not depend on legacy migration or reconciliation", () => {
  for (const fileName of [
    "personaSync.ts",
    "personaSyncCoordinator.ts",
    "personaSyncManifestIndex.ts",
    "personaSyncPlanPackage.ts",
    "personaPlanStorage.ts"
  ]) {
    const content = source(fileName);
    assert.doesNotMatch(content, /planStorageLegacyLayout/);
    assert.doesNotMatch(content, /planStorageMigration/);
    assert.doesNotMatch(content, /planStorageReconciliation/);
    assert.doesNotMatch(content, /\.legacy\b/);
  }
});

test("legacy layout knowledge remains inside the startup migration boundary", () => {
  const offenders = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .filter(entry => source(entry.name).includes("planStorageLegacyLayout"))
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(offenders, ["planStorageMigration.ts"]);
});

test("HTTP routes submit feedback through the application service", () => {
  const routes = source(path.join("manager", "controlPlaneRoutes.ts"));
  assert.match(routes, /submitPlanFeedback\(/);
  assert.doesNotMatch(routes, /commitPlanFeedback\(/);
  assert.doesNotMatch(routes, /createPlanFeedbackRecord\(/);
  assert.match(routes, /canonicalLogicalPlanId\(decodeURIComponent\(planFeedbackMatch\[2\]\)\)/);
});

test("feedback writers use the command service and expose no attachment-only commit", () => {
  const outbox = source("outbox.ts");
  const facade = source("planFeedback.ts");
  assert.match(outbox, /submitPlanFeedback\(/);
  assert.doesNotMatch(outbox, /appendPlanFeedback\(/);
  assert.doesNotMatch(outbox, /createPlanFeedbackRecord\(/);
  assert.doesNotMatch(facade, /storePlanFeedbackAttachments/);
});

test("domain plan lifecycle publishes only complete final snapshots through the repository", () => {
  const knowledge = source("roleKnowledge.ts");
  assert.match(knowledge, /commitPlanLifecycleTransitionUnderLease\(/);
  assert.match(knowledge, /readCanonicalPlanStoragePackageUnderLease\(/);
  assert.doesNotMatch(knowledge, /fs\.renameSync\(/);
  assert.doesNotMatch(knowledge, /storePlanAttachments\(/);
  const attachments = source("planAttachments.ts");
  assert.match(attachments, /preparePlanAttachments\(/);
  assert.doesNotMatch(attachments, /fs\.(?:writeFileSync|mkdirSync|renameSync)\(/);
});

test("only the public plan storage repository facade imports physical internals", () => {
  const offenders = productionTypeScriptFiles(sourceRoot)
    .filter(filePath => fs.readFileSync(filePath, "utf8").includes("plan-storage/internal/"))
    .map(filePath => path.relative(sourceRoot, filePath).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(offenders, ["planStorageRepository.ts"]);
});

test("Manager publishes its fenced READY identity before starting the plan-storage recovery child", () => {
  const controlPlane = source(path.join("manager", "controlPlaneRoutes.ts"));
  const startManagerOffset = controlPlane.indexOf("export async function startManager");
  assert.ok(startManagerOffset >= 0, "Manager startup composition root is missing");
  const startup = controlPlane.slice(startManagerOffset);
  const requestHandlerInstalled = startup.indexOf("managerRuntimeOwner.publish(Object.freeze({");
  const listenerMarkedReady = startup.indexOf("managerListenerReady = true;");
  const readyPublished = startup.indexOf("console.log(managerReadyLine({");
  const recoveryChildStarted = startup.indexOf("planStorageStartupLifecycle.start();");

  assert.ok(requestHandlerInstalled >= 0, "Manager must atomically publish its complete HTTP handler");
  assert.ok(listenerMarkedReady > requestHandlerInstalled, "listener readiness must follow complete HTTP handler installation");
  assert.ok(readyPublished > listenerMarkedReady, "structured READY must follow listener readiness");
  assert.ok(readyPublished > requestHandlerInstalled, "READY must follow complete HTTP handler installation");
  assert.ok(recoveryChildStarted > readyPublished, "the plan-storage child must start only after fenced READY");
  assert.doesNotMatch(startup, /await\s+planStorageStartupLifecycle\.start\s*\(/);
  assert.doesNotMatch(controlPlane, /[A-Za-z0-9_]*BeforeReady[A-Za-z0-9_]*/);
  assert.doesNotMatch(controlPlane, /\bmigrateRolePlanLayout\b|runPlanStorageStartupGate|recoverPlanLifecycleTransitions|recoverPlanFeedbackStoreTransactions|recoverPersonaSyncPlanPackageTransactions/);

  const child = source(path.join("manager", "planStorageStartupChild.ts"));
  assert.match(child, /\bmigrateRolePlanLayoutAtStartup\b/);
  assert.match(child, /runPlanStorageStartupGate/);
  assert.match(child, /recoverPlanLifecycleTransitions/);
  assert.match(child, /recoverPlanFeedbackStoreTransactions/);
  assert.match(child, /recoverPersonaSyncPlanPackageTransactions/);
});
