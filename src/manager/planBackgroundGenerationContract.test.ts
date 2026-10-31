import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

type Publication = { publish(): void; retire(): Promise<void>; afterPublish(input: { previousRetirement: Promise<void>; signal: AbortSignal }): Promise<void> };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function activateBackground(kind: "memory-consolidation" | "plan-feedback-delivery", readOnly = false) {
  const plugin = await import(pathToFileURL(path.join(repositoryRoot, "plugins/builtin/io.rabiroute.manager." + kind + "/1.0.0/manager.mjs")).href);
  const publications: Publication[] = [], effects: Array<() => unknown> = [];
  const lifecycle = new AbortController(); let constructions = 0, starts = 0, activations = 0, manualStops = 0;
  const runtime: any = {
    managerReadOnly: readOnly, activePlanFeedbackDeliveryFlights: new Map<string, Promise<void>>(),
    manualTriggerProcesses: { stopOwner: async (owner: string) => { assert.equal(owner, "manager:memory-consolidation"); manualStops++; } },
    createMemoryConsolidationScheduler: () => {
      constructions++; let active = true, requested = false;
      return { deferActivation() { active = false; }, isStarted: () => starts > 0, start() { if (active) starts++; else requested = true; },
        activate(resume: boolean) { activations++; active = true; if (resume || requested) starts++; }, async stop() { active = false; } };
    },
    PlanFeedbackRecoveryService: class {
      constructor() { constructions++; }
      isActive() { return starts > 0; }
      async start(reason: string) { assert.equal(reason, "plan and route readiness"); starts++; }
      async stopAndJoin() {}
    }
  };
  Object.defineProperty(runtime, "managerListenerReady", { get() { throw new Error("Listener readiness must not start background work."); } });
  await plugin.activate({ identity: { instanceId: "controlled-background" }, lifecycle: { signal: lifecycle.signal, fail(error: unknown) { throw error; } },
    services: { require: () => runtime, provide: () => {} }, effects: { add: (starter: () => unknown) => effects.push(starter) },
    publication: { add: (owner: Publication) => publications.push(owner) } });
  for (const effect of effects) assert.equal(typeof await effect(), "function");
  return { runtime, publications, lifecycle, counts: () => ({ constructions, starts, activations, manualStops }) };
}

test("background plugins register services but never start from listener readiness", async () => {
  const memory = read("plugins/builtin/io.rabiroute.manager.memory-consolidation/1.0.0/manager.mjs");
  const feedback = read("plugins/builtin/io.rabiroute.manager.plan-feedback-delivery/1.0.0/manager.mjs");
  assert.doesNotMatch(memory, /managerListenerReady|scheduler\.start\s*\(/);
  assert.doesNotMatch(feedback, /managerListenerReady|manager plugin activation/);
  assert.match(feedback, /recovery\.start\("plan and route readiness"\)/);
  for (const kind of ["memory-consolidation", "plan-feedback-delivery"] as const) for (const requestEarly of [false, true]) {
    const f = await activateBackground(kind), publication = f.publications[0]!;
    assert.equal(f.publications.length, 1); assert.equal(f.counts().starts, 0);
    publication.publish(); assert.equal(f.counts().starts, 0);
    const predecessor = deferred(), after = publication.afterPublish({ previousRetirement: predecessor.promise, signal: f.lifecycle.signal });
    await turn(); assert.equal(f.counts().starts, 0); assert.equal(f.counts().activations, 0);
    if (kind === "plan-feedback-delivery") assert.equal(f.counts().constructions, 0);
    const startReady = () => kind === "plan-feedback-delivery" ? f.runtime.startActivePlanFeedbackRecovery() : f.runtime.memoryConsolidationScheduler.start();
    if (requestEarly) startReady();
    assert.equal(f.counts().starts, 0, "an early readiness request must wait for original predecessor retirement");
    predecessor.resolve(); await after; assert.equal(f.counts().starts, requestEarly ? 1 : 0);
    if (!requestEarly) startReady(); assert.equal(f.counts().starts, 1);
    assert.equal(f.counts().constructions, 1);
    await publication.retire();
    if (kind === "memory-consolidation") assert.equal(f.counts().manualStops, 1);
    else assert.equal(f.runtime.planFeedbackDeliveryActive, false);
  }
});

test("read-only and aborted background candidates never acquire running work", async () => {
  for (const kind of ["memory-consolidation", "plan-feedback-delivery"] as const) {
    const readOnly = await activateBackground(kind, true); assert.deepEqual(readOnly.counts(), { constructions: 0, starts: 0, activations: 0, manualStops: 0 }); assert.equal(readOnly.publications.length, 0);
    const f = await activateBackground(kind), publication = f.publications[0]!;
    publication.publish(); const predecessor = deferred();
    const after = publication.afterPublish({ previousRetirement: predecessor.promise, signal: f.lifecycle.signal }).catch(error => error);
    f.lifecycle.abort(); predecessor.resolve(); await after;
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().activations, 0);
    if (kind === "plan-feedback-delivery") assert.equal(f.counts().constructions, 0);
    await publication.retire(); assert.equal(f.counts().manualStops, 0);
  }
});

test("feedback retirement joins initial and late original flights in finally even when stopAndJoin rejects", async () => {
  const f = await activateBackground("plan-feedback-delivery"), publication = f.publications[0]!;
  publication.publish(); await publication.afterPublish({ previousRetirement: Promise.resolve(), signal: f.lifecycle.signal });
  const initial = deferred(), late = deferred(), stopping = deferred(), entered = deferred();
  f.runtime.activePlanFeedbackDeliveryFlights.set("initial", initial.promise);
  f.runtime.planFeedbackRecoveryService.stopAndJoin = async () => { f.runtime.activePlanFeedbackDeliveryFlights.set("late", late.promise); entered.resolve(); await stopping.promise; throw new Error("controlled stop failure"); };
  let settled = false;
  const original = publication.retire(); assert.equal(publication.retire(), original);
  const retirement = original.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await entered.promise; stopping.resolve(); await turn(); assert.equal(settled, false);
  initial.resolve(); await turn(); assert.equal(settled, false);
  late.resolve(); assert.match(String(await retirement), /controlled stop failure/);
  assert.equal(f.runtime.planFeedbackDeliveryActive, false);
});

test("plan and route readiness are the single background start owner", () => {
  const controlPlane = read("src/manager/controlPlaneRoutes.ts");
  const start = controlPlane.indexOf("const startPlanDependentBackground = (): void => {");
  const end = controlPlane.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start, "plan-dependent background controller is missing");
  const controller = controlPlane.slice(start, end);

  assert.match(controller, /!\["ready", "partial"\]\.includes\(planStorageStartupLifecycle\.snapshot\(\)\.state\)/);
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

test("plan-storage commands validate the active generation without blocking the Gateway runtime", () => {
  const gatewayCommands = read("src/gatewayCommands.ts");
  assert.match(gatewayCommands, /\.\/runtime\/planStorageGenerationFence\.js/);
  assert.doesNotMatch(gatewayCommands, /\.\/manager\/planStorageGenerationFence\.js/);
  assert.match(gatewayCommands, /planStorageGenerationLeaseFromEnvironment\(\)/);
  assert.match(gatewayCommands, /verifyPlanStorageGenerationLease\(/);
  assert.doesNotMatch(gatewayCommands, /migrateRolePlanLayout|planStorageMigration|planStorageLegacyLayout/);

  const gatewayMain = read("src/gatewayMain.ts");
  assert.doesNotMatch(gatewayMain, /planStorageGenerationFence/);
  assert.doesNotMatch(gatewayMain, /planStorageGenerationLeaseFromEnvironment|verifyPlanStorageGenerationLease/);
  assert.doesNotMatch(gatewayMain, /migrateRolePlanLayout|planStorageMigration|planStorageLegacyLayout/);

  const migrationImporters = productionTypeScriptFiles(sourceRoot)
    .filter(filePath => /from\s+["'][^"']*planStorageMigration\.js["']/.test(fs.readFileSync(filePath, "utf8")))
    .map(filePath => path.relative(sourceRoot, filePath).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(migrationImporters, ["manager/planStorageStartupMigration.ts"]);
  assert.match(read("src/manager/storageStartupChild.ts"), /migrateRolePlanLayoutAtStartup/);
});

test("Xiaomi Home event children verify the READY generation before reading or delivering an event", () => {
  const gatewayCommands = read("src/gatewayCommands.ts");
  const start = gatewayCommands.indexOf('if (argv.includes("--xiaomi-home-event-stdin"))');
  const end = gatewayCommands.indexOf('if (argv.includes("--wearable-health-alert-stdin"))', start);
  assert.ok(start >= 0 && end > start, "Xiaomi Home stdin command block is missing");
  const command = gatewayCommands.slice(start, end);
  const lease = command.indexOf("planStorageGenerationLeaseFromEnvironment()");
  const verification = command.indexOf("await verifyPlanStorageGenerationLease(storageGenerationLease)");
  const stdinRead = command.indexOf("await readStandardInputJson<XiaomiHomeEventCliPayload>()");
  const delivery = command.search(/await forwardMessageAndWait\(\s*"xiaomi_home_event"/);
  assert.ok(lease >= 0 && verification > lease, "Xiaomi Home child does not verify its Manager generation lease");
  assert.ok(stdinRead > verification, "Xiaomi Home child reads work before its generation is verified");
  assert.ok(delivery > stdinRead, "Xiaomi Home child delivery is not fenced behind generation verification");
});
