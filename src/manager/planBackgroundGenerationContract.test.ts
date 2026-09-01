import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const managerRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.dirname(managerRoot);
const repositoryRoot = path.dirname(sourceRoot);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [target];
  });
}

test("background plugins register services but never start from listener readiness", () => {
  const memory = read("plugins/builtin/io.rabiroute.manager.memory-consolidation/1.0.0/manager.mjs");
  const feedback = read("plugins/builtin/io.rabiroute.manager.plan-feedback-delivery/1.0.0/manager.mjs");

  assert.doesNotMatch(memory, /managerListenerReady|scheduler\.start\s*\(/);
  assert.doesNotMatch(feedback, /managerListenerReady|(?:^|\n)\s*start\(\);/);
  assert.doesNotMatch(feedback, /manager plugin activation/);
  assert.match(feedback, /recovery\.start\("plan and route readiness"\)/);
  assert.match(memory, /runtime\.memoryConsolidationScheduler = scheduler/);
  assert.match(feedback, /runtime\.startActivePlanFeedbackRecovery = start/);
});

test("plan and route readiness are the single background start owner", () => {
  const controlPlane = read("src/manager/controlPlaneRoutes.ts");
  const start = controlPlane.indexOf("const startPlanDependentBackground = (): void => {");
  const end = controlPlane.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start, "plan-dependent background controller is missing");
  const controller = controlPlane.slice(start, end);

  assert.match(controller, /planStorageStartupLifecycle\.snapshot\(\)\.state !== "ready"/);
  assert.match(controller, /routeCatalogStartupLifecycle\.snapshot\(\)\.state !== "ready"/);
  assert.match(controller, /memoryConsolidationScheduler\?\.start\(\)/);
  assert.match(controller, /startActivePlanFeedbackRecovery\(\)/);
  assert.equal(controlPlane.match(/^\s+memoryConsolidationScheduler\?\.start\(\);\s*$/gm)?.length, 1);
  assert.equal(controlPlane.match(/^\s+startActivePlanFeedbackRecovery\(\);\s*$/gm)?.length, 1);
});

test("Manager gives every child one dynamic READY identity tuple", () => {
  const controlPlane = read("src/manager/controlPlaneRoutes.ts");
  const environmentFactory = controlPlane.match(/function envFor\([\s\S]*?\r?\n}\r?\n/)?.[0];
  assert.ok(environmentFactory, "Gateway child environment factory is missing");

  assert.match(environmentFactory, /GATEWAY_MANAGER_URL:\s*`http:\/\/127\.0\.0\.1:\$\{managerPort\}`/);
  assert.match(
    environmentFactory,
    /RABIROUTE_APPLICATION_GENERATION_ID:\s*managerHostIdentity\?\.applicationGenerationId\s*\?\?\s*managerInstanceId/
  );
  assert.match(environmentFactory, /RABIROUTE_MANAGER_INSTANCE_ID:\s*managerInstanceId/);
  assert.doesNotMatch(environmentFactory, /879[0-9]/);
});

test("manual and Gateway children validate the active plan-storage generation without migration code", () => {
  for (const relativePath of ["src/gatewayCommands.ts", "src/gatewayMain.ts"]) {
    const source = read(relativePath);
    assert.match(source, /\.\/runtime\/planStorageGenerationFence\.js/);
    assert.doesNotMatch(source, /\.\/manager\/planStorageGenerationFence\.js/);
    assert.match(source, /planStorageGenerationLeaseFromEnvironment\(\)/);
    assert.match(source, /verifyPlanStorageGenerationLease\(/);
    assert.doesNotMatch(source, /migrateRolePlanLayout|planStorageMigration|planStorageLegacyLayout/);
  }

  const migrationImporters = productionTypeScriptFiles(sourceRoot)
    .filter(filePath => /from\s+["'][^"']*planStorageMigration\.js["']/.test(fs.readFileSync(filePath, "utf8")))
    .map(filePath => path.relative(sourceRoot, filePath).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(migrationImporters, ["manager/planStorageStartupMigration.ts"]);
  assert.match(read("src/manager/planStorageStartupChild.ts"), /migrateRolePlanLayoutAtStartup/);
});

test("Xiaomi Home event children verify the READY generation before reading or delivering an event", () => {
  const gatewayCommands = read("src/gatewayCommands.ts");
  const start = gatewayCommands.indexOf('if (argv.includes("--xiaomi-home-event-stdin"))');
  const end = gatewayCommands.indexOf('if (argv.includes("--wearable-health-alert-stdin"))', start);
  assert.ok(start >= 0 && end > start, "Xiaomi Home stdin command block is missing");
  const command = gatewayCommands.slice(start, end);
  const lease = command.indexOf("planStorageGenerationLeaseFromEnvironment()");
  const verification = command.indexOf("await verifyPlanStorageGenerationLease(storageGenerationLease)");
  const read = command.indexOf("await readStandardInputJson<XiaomiHomeEventCliPayload>()");
  const delivery = command.indexOf('await forwardMessageAndWait(\n        "xiaomi_home_event"');
  assert.ok(lease >= 0 && verification > lease, "Xiaomi Home child does not verify its Manager generation lease");
  assert.ok(read > verification, "Xiaomi Home child reads work before its generation is verified");
  assert.ok(delivery > read, "Xiaomi Home child delivery is not fenced behind generation verification");
});
