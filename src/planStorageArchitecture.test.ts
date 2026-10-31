import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "./manager/personaStorageOperations.js";
import type { RoleStorageApplication, RoleStorageCommandContext } from "./manager/roleStorageApplication.js";
import { apiPathParameters, compileApiOperation } from "./manager/apiOperationContract.js";
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
    "planStoragePackageRecovery.ts",
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

test("HTTP routes submit feedback through the application service", async t => {
  const routes = source(path.join("manager", "controlPlaneRoutes.ts")), storage = source(path.join("manager", "personaStorageOperations.ts"));
  assert.match(routes, /application: currentRoleStorageApplication/);
  assert.match(routes, /personaStorageContext: Object\.freeze\(createPersonaStorageOperationsContext\(\)\)/);
  for (const text of [routes, storage]) { assert.doesNotMatch(text, /commitPlanFeedback\(/); assert.doesNotMatch(text, /createPlanFeedbackRecord\(/); }
  assert.match(storage, /canonicalLogicalPlanId\(value\)/);
  assert.match(storage, /const id = feedbackPlanId\(planId\), actor = await this\.context\.planHistoryContext[\s\S]*a\.assertCurrent\(\);[\s\S]*application\.commands\.submitPlanFeedback\(roleId, id, value, \{ \.\.\.actor, authorize: a\.assertCurrent \}\)/);
  const applicationSource = source(path.join("manager", "roleStorageApplication.ts"));
  const commandStart = applicationSource.indexOf("  submitPlanFeedback(roleId:");
  const commandEnd = applicationSource.indexOf("  updatePlanFeedbackDelivery(", commandStart);
  assert.ok(commandStart >= 0 && commandEnd > commandStart);
  const commandSource = applicationSource.slice(commandStart, commandEnd);
  assert.match(commandSource, /this\.commitProjection\(/);
  assert.match(commandSource, /expectedRevision: \(\) => this\.requiredExpectedRevision\(context\.expectedRevision\)/);
  assert.match(commandSource, /this\.mutationPool\.submitPlanFeedback/);
  assert.match(commandSource, /this\.queries\.planFeedback[\s\S]*if \(!projection\)[\s\S]*projection_unavailable/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-application-route-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const identity = { applicationGenerationId: "feedback-generation", managerInstanceId: "feedback-manager" };
  let commands = 0, afterActor: () => void = () => {};
  const expectedRevision = '"' + "a".repeat(64) + '"';
  const application = { commands: { submitPlanFeedback: async (roleId: string, planId: string, _body: unknown, command: RoleStorageCommandContext) => {
    commands++; assert.equal(roleId, "Fixture"); assert.equal(planId, "plan-fixture"); assert.equal(command.expectedRevision, expectedRevision);
    assert.equal(command.idempotencyKey, "fixture-feedback"); assert.equal(typeof command.authorize, "function"); command.authorize!();
    return { operationId: "feedback-op", commit: { created: true, record: { id: "feedback-one", text: "Controlled" }, plan: { id: planId } }, projection: { planRevision: "b".repeat(64) } };
  } } } as unknown as RoleStorageApplication;
  const context: PersonaStorageOperationsContext = { application: () => application, roleDirectory: () => root, identity: () => identity, readOnly: () => false,
    planHistoryContext: async (_request, _body, command) => { await Promise.resolve(); afterActor(); return command; }, scheduleFeedbackPostCommit: () => {}, reportFeedbackScheduleError: () => {}, publish: () => {}, rescheduleMemory: () => {}, noteMemoryRunCompleted: () => {} };
  const owner = new PersonaStorageOwner(context); t.after(() => owner.stop());
  const operation = createPersonaStorageOperations(owner).find(value => value.contract.operationId === "manager.personas.storage.feedback.submit")!;
  const compiled = compileApiOperation(operation);
  const run = async (id: string) => {
    const request = new http.IncomingMessage(new Socket());
    request.headers = { "if-match": expectedRevision, "idempotency-key": "fixture-feedback" };
    const url = new URL("/api/roles/Fixture/plans/" + id + "/feedback", "http://fixture");
    try { return await operation.handler({ request, response: new http.ServerResponse(request), url, path: apiPathParameters(compiled, url.pathname)!, query: {}, body: { feedbackId: "feedback-one", text: "Controlled" } }); }
    finally { request.destroy(); }
  };
  const accepted = await run("plan-fixture"); assert.equal(accepted.status, 202); assert.equal(accepted.headers?.etag, '"' + "b".repeat(64) + '"'); assert.equal(commands, 1);
  assert.equal((await run("%20plan-fixture")).status, 400); assert.equal(commands, 1, "noncanonical decoded ID cannot reach application commands");
  afterActor = () => { identity.managerInstanceId = "replacement-manager"; };
  const stale = await run("plan-fixture"); assert.equal(stale.status, 409); assert.equal(commands, 1, "generation change after actor lookup cannot dispatch a storage command");
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

function importedModules(content: string): string[] {
  const tree = ts.createSourceFile("source.ts", content, ts.ScriptTarget.Latest, true);
  const modules: string[] = [];
  const add = (value: ts.Node | undefined) => {
    if (value && ts.isStringLiteralLike(value)) modules.push(value.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return modules;
}

test("physical import detection ignores documentation strings but recognizes actual module dependencies", () => {
  assert.deepEqual(importedModules(`
    // import hidden from "./plan-storage/internal/comment.js";
    const diagnostic = "./plan-storage/internal/description.ts";
    import { lease } from "./plan-storage/internal/static.js";
    export { helper } from "./plan-storage/internal/export.js";
    const lazy = import("./plan-storage/internal/dynamic.js");
    const common = require("./plan-storage/internal/require.js");
    import legacy = require("./plan-storage/internal/legacy.js");
  `), ["./plan-storage/internal/static.js", "./plan-storage/internal/export.js",
    "./plan-storage/internal/dynamic.js", "./plan-storage/internal/require.js", "./plan-storage/internal/legacy.js"]);
});

test("only the public plan storage repository facade imports physical internals", () => {
  const offenders = productionTypeScriptFiles(sourceRoot)
    .filter(filePath => importedModules(fs.readFileSync(filePath, "utf8")).some(specifier => specifier.includes("plan-storage/internal/")))
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
  assert.doesNotMatch(controlPlane, /\bmigrateRolePlanLayout\b|runPlanStorageStartupGate|recoverPlanLifecycleTransitions|recoverPlanFeedbackStoreTransactions|recoverStoredPlanPackages/);

  const child = source(path.join("manager", "storageStartupChild.ts"));
  assert.match(child, /\bmigrateRolePlanLayoutAtStartup\b/);
  assert.match(child, /runPlanStorageStartupGate/);
  assert.match(child, /recoverPlanLifecycleTransitions/);
  assert.match(child, /recoverPlanFeedbackStoreTransactions/);
  assert.match(child, /recoverStoredPlanPackages/);
});
