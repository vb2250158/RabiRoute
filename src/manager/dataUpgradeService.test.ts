import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DataUpgradeService } from "./dataUpgradeService.js";
import { discoverPlanDataUpgrades, readDataUpgradeReceipt, createDataUpgradeOperations, consumeConfirmedDataUpgrades } from "./dataUpgradeOperations.js";
import { createStorageStartupProcess } from "./storageStartupProcess.js";
import { canonicalizeRolePlanStorageDirectories } from "../planStorageReconciliation.js";
import { applyPluginStorageMigrations, pluginStorageRoot } from "../shared/pluginStorage.js";
import { EventEmitter } from "node:events";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "data-upgrade-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { layout: { stateRoot: root, packageRoot: root }, rolesRoot: path.join(root, "roles") };
}
const pending = [{ id: "plan:example", title: "Plan", description: "Legacy layout", state: "pending" as const, inputFingerprint: "fixture" }];

test("snapshot stays cached; durable confirmation uses CAS and stable original operation receipts", async t => {
  const options = fixture(t); let discoveries = 0, restarts = 0;
  const service = new DataUpgradeService({ ...options, discover: async () => { discoveries++; return pending; }, requestRestart: async () => { restarts++; } });
  await service.start();
  assert.equal(service.snapshot().restartRequired, true, "confirmation must disclose the required restart before accepting consent");
  for (let i = 0; i < 20; i++) service.snapshot();
  assert.equal(discoveries, 1);
  assert.throws(() => service.accept({ operationId: "operation-stale", expectedRevision: 0 }), /列表已更新/);
  const accepted = service.accept({ operationId: "operation-first", expectedRevision: service.snapshot().revision });
  assert.equal(accepted.state, "awaiting-restart"); assert.equal(restarts, 0);
  assert.equal((await readDataUpgradeReceipt(options.layout))?.confirmedItemIds[0], "plan:example");
  assert.deepEqual(service.accept({ operationId: "operation-first", expectedRevision: 0 }), accepted);
  assert.deepEqual(service.accept({ operationId: "operation-second", expectedRevision: 0 }), accepted);
  await service.requestRestart("operation-first"); await service.requestRestart("operation-first"); assert.equal(restarts, 1);
  await service.stop();
});

test("HTTP response finishes before requesting Host restart; read is passive", async t => {
  const options = fixture(t); let restarts = 0;
  const service = new DataUpgradeService({ ...options, discover: async () => pending, requestRestart: async () => { restarts++; } });
  await service.start();
  const operations = createDataUpgradeOperations({ service, canManage: () => true });
  const response = new EventEmitter();
  const input = { request: {}, response, body: { operationId: "operation-http", expectedRevision: service.snapshot().revision } } as any;
  const result = await operations[1]!.handler(input);
  assert.equal(result.status, 202); assert.equal(restarts, 0);
  await operations[0]!.handler(input); assert.equal(restarts, 0);
  response.emit("finish"); await new Promise(resolve => setImmediate(resolve)); assert.equal(restarts, 1);
  await service.stop();
});

test("failed restart retains an interrupted operation across a new service", async t => {
  const options = fixture(t);
  const service = new DataUpgradeService({ ...options, discover: async () => pending, requestRestart: async () => { throw new Error("private path"); } });
  await service.start(); const accepted = service.accept({ operationId: "operation-failure", expectedRevision: service.snapshot().revision });
  await service.requestRestart(accepted.operation!.operationId);
  assert.equal(service.snapshot().state, "awaiting-restart"); assert.doesNotMatch(JSON.stringify(service.snapshot()), /private path/);
  const replacement = new DataUpgradeService({ ...options, discover: async () => { throw new Error("must use receipt"); } });
  await replacement.start(); assert.equal(replacement.snapshot().operation?.operationId, "operation-failure");
  assert.equal(replacement.snapshot().state, "awaiting-restart");
  assert.deepEqual((await readDataUpgradeReceipt(options.layout))?.confirmedItemIds, ["plan:example"]);
  await service.stop(); await replacement.stop();
});

test("history appends change the metadata fingerprint without reading a large history body", t => {
  const { rolesRoot } = fixture(t), directory = path.join(rolesRoot, "example", "plans", "active", "plan-test");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "plan.json"), JSON.stringify({ id: "plan-test", status: "执行中" }));
  const history = path.join(directory, "history.jsonl"); fs.writeFileSync(history, "original\n");
  const before = discoverPlanDataUpgrades(rolesRoot)[0]!.inputFingerprint;
  fs.appendFileSync(history, "new history\n");
  assert.notEqual(discoverPlanDataUpgrades(rolesRoot)[0]!.inputFingerprint, before);
});

test("upgrade fingerprints never enumerate attachment blobs or quarantine history subtrees", t => {
  const { rolesRoot } = fixture(t), root = path.join(rolesRoot, "example", "plans");
  const plan = path.join(root, "active", "plan-test"), attachments = path.join(plan, "attachments");
  fs.mkdirSync(path.join(attachments, "huge", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "quarantine", "historical", "blob-tree"), { recursive: true });
  fs.writeFileSync(path.join(plan, "plan.json"), JSON.stringify({ id: "plan-test", status: "执行中" }));
  fs.writeFileSync(path.join(plan, "history.jsonl"), "history\n");
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", ((directory: fs.PathLike, ...args: unknown[]) => {
    const relative = path.relative(root, String(directory));
    assert.ok(!relative.startsWith("quarantine") && !relative.includes("attachments"), "blob subtrees must not be enumerated even if they contain millions of entries");
    return Reflect.apply(original, fs, [directory, ...args]);
  }) as typeof fs.readdirSync);
  const items = discoverPlanDataUpgrades(rolesRoot);
  assert.equal(items[0]?.state, "pending"); assert.ok(items[0]?.inputFingerprint);
});

test("read-only and unsupported lifecycle reject before consent is written", async t => {
  for (const readOnly of [false, true]) {
    const options = fixture(t), service = new DataUpgradeService({ ...options, readOnly, discover: async () => pending });
    await service.start(); assert.throws(() => service.accept({ operationId: "operation-blocked", expectedRevision: service.snapshot().revision }));
    assert.equal(await readDataUpgradeReceipt(options.layout), undefined); await service.stop();
  }
});

test("plugin inspection and deferred startup preserve legacy bytes until exact confirmation", t => {
  const { layout } = fixture(t), source = path.join(layout.stateRoot, "legacy.json"); fs.writeFileSync(source, "original");
  const declaration = { schemaVersion: 1 as const, scope: "plugin" as const, migrations: [{ id: "layout", kind: "file" as const, source: { root: "state" as const, path: "legacy.json" }, target: "store.json" }] };
  const input = { phase: "owners-retired" as const, pluginId: "example", layout, declaration };
  const inspected = applyPluginStorageMigrations({ ...input, migrationPolicy: "inspect" });
  assert.equal(inspected[0]?.status, "pending"); assert.ok(inspected[0]?.inputFingerprint); assert.deepEqual(fs.readdirSync(layout.stateRoot), ["legacy.json"]);
  assert.equal(applyPluginStorageMigrations({ ...input, migrationPolicy: "defer" })[0]?.status, "pending"); assert.equal(fs.readFileSync(source, "utf8"), "original");
  assert.equal(applyPluginStorageMigrations({ ...input, migrationPolicy: "defer", confirmedMigrationIds: ['["example",null,"layout"]'] })[0]?.status, "migrated");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot("example", undefined, layout), "store.json"), "utf8"), "original");
});

test("plugin directory confirmation fingerprint notices an internal file append without reading its body", t => {
  const { layout } = fixture(t), source = path.join(layout.stateRoot, "legacy"), nested = path.join(source, "nested");
  fs.mkdirSync(nested, { recursive: true }); const filename = path.join(nested, "records.jsonl"); fs.writeFileSync(filename, "original\n");
  const declaration = { schemaVersion: 1 as const, scope: "plugin" as const, migrations: [{ id: "layout", kind: "directory" as const, source: { root: "state" as const, path: "legacy" }, target: "store" }] };
  const inspect = () => applyPluginStorageMigrations({ phase: "owners-retired", pluginId: "example", layout, declaration, migrationPolicy: "inspect" })[0]!.inputFingerprint;
  const before = inspect(), directoryTime = fs.lstatSync(source).mtimeMs;
  fs.appendFileSync(filename, "new record\n");
  assert.equal(fs.lstatSync(source).mtimeMs, directoryTime);
  assert.notEqual(inspect(), before);
});

test("failed upgrade sources are rediscovered after repair while original operation history remains", async t => {
  const options = fixture(t);
  const service = new DataUpgradeService({ ...options, discover: async () => pending, requestRestart: async () => { throw { restartDispatched: false }; } });
  await service.start(); const accepted = service.accept({ operationId: "operation-repaired", expectedRevision: service.snapshot().revision });
  await service.requestRestart(accepted.operation!.operationId);
  const originalReceipt = await readDataUpgradeReceipt(options.layout);
  let discoveries = 0;
  const repaired = new DataUpgradeService({ ...options, discover: async () => { discoveries++; return [{ ...pending[0]!, inputFingerprint: "repaired" }]; } });
  await repaired.start(); assert.equal(discoveries, 1); assert.equal(repaired.snapshot().state, "available");
  assert.equal(repaired.snapshot().items[0]?.inputFingerprint, "repaired"); assert.ok(repaired.snapshot().revision > originalReceipt!.status.revision);
  assert.equal(repaired.snapshot().operation?.operationId, "operation-repaired");
  assert.deepEqual((await readDataUpgradeReceipt(options.layout))?.receipts, originalReceipt?.receipts);
  await repaired.stop(); await service.stop();
});

test("stopping during the initial receipt read suppresses late status publication", async t => {
  const options = fixture(t), service = new DataUpgradeService({ ...options, discover: async () => { throw new Error("stopped initialization must not discover"); } });
  const events: unknown[] = []; service.subscribe(status => events.push(status));
  const initialization = service.start(); await service.stop(); await initialization;
  assert.equal(events.length, 0); assert.equal(service.snapshot().state, "checking");
});

test("recovery-only name migration resumes prepared work and leaves other legacy names for confirmation", t => {
  const { rolesRoot } = fixture(t), roleDir = path.join(rolesRoot, "example"), bucket = path.join(roleDir, "plans", "active");
  for (const id of ["Plan-Old", "Plan-Prepared"]) { fs.mkdirSync(path.join(bucket, id), { recursive: true }); fs.writeFileSync(path.join(bucket, id, "plan.json"), JSON.stringify({ id, status: "执行中" })); }
  assert.equal(canonicalizeRolePlanStorageDirectories(roleDir, { recoveryOnly: true }).migrated, 0);
  assert.ok(fs.existsSync(path.join(bucket, "Plan-Old")));
  canonicalizeRolePlanStorageDirectories(roleDir, { faultInjection: { afterRename: () => { throw new Error("crash"); } } });
  const resumed = canonicalizeRolePlanStorageDirectories(roleDir, { recoveryOnly: true }); assert.ok(resumed.recovered > 0); assert.deepEqual(resumed.failures, []);
  // Default retains the existing explicit migration behavior.
  const id = "Plan-Another"; fs.mkdirSync(path.join(bucket, id)); fs.writeFileSync(path.join(bucket, id, "plan.json"), JSON.stringify({ id, status: "执行中" }));
  assert.equal(canonicalizeRolePlanStorageDirectories(roleDir).migrated, 1);
});

test("plan discovery isolates malformed files and reports real legacy evidence without counts", t => {
  const { rolesRoot } = fixture(t);
  const legacy = path.join(rolesRoot, "legacy", "plans", "items", "active"); fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "original.json"), "{}");
  const broken = path.join(rolesRoot, "broken", "plans", "active", "bad"); fs.mkdirSync(broken, { recursive: true }); fs.writeFileSync(path.join(broken, "plan.json"), "{");
  const items = discoverPlanDataUpgrades(rolesRoot); assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === "plan:broken")?.state, "failed"); assert.equal(items.find(item => item.id === "plan:legacy")?.state, "pending");
  assert.ok(items.every(item => item.recordCount === undefined && item.bytes === undefined));
});

test("real background discovery, explicit consent and next-generation child migrate the original plan only after confirmation", async t => {
  const options = fixture(t), profile = path.join(options.layout.packageRoot, "dist", "plugins", "profiles", "desktop.json");
  fs.mkdirSync(path.dirname(profile), { recursive: true }); fs.writeFileSync(profile, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [] }));
  const legacy = path.join(options.rolesRoot, "example", "plans", "items", "active", "plan-test.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ id: "plan-test", title: "Original plan", status: "执行中", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", steps: [] }));
  const history = path.join(options.rolesRoot, "example", "plans", "history", "plan-test.jsonl");
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, JSON.stringify({ id: "original-event", planId: "plan-test", kind: "created", recordedAt: "2026-01-01T00:00:00.000Z", after: JSON.parse(fs.readFileSync(legacy, "utf8")) }) + "\n");
  await createStorageStartupProcess({ kind: "plan", rolesRoot: options.rolesRoot, roleId: "example" }).result;
  assert.ok(fs.existsSync(legacy), "ordinary recovery must not perform a new layout upgrade");
  const service = new DataUpgradeService({ ...options, requestRestart: async () => {} });
  await service.start(); assert.equal(service.snapshot().state, "available");
  const accepted = service.accept({ operationId: "operation-real-child", expectedRevision: service.snapshot().revision });
  assert.ok(fs.existsSync(legacy), "confirmation alone never migrates active owners");
  await consumeConfirmedDataUpgrades(options.layout, options.rolesRoot, false);
  const receipt = await readDataUpgradeReceipt(options.layout);
  assert.equal(receipt?.status.state, "succeeded"); assert.equal(receipt?.status.operation?.operationId, accepted.operation?.operationId);
  assert.equal(fs.existsSync(legacy), false);
  const migrated = path.join(options.rolesRoot, "example", "plans", "active", "plan-test", "plan.json");
  assert.equal(JSON.parse(fs.readFileSync(migrated, "utf8")).id, "plan-test");
  await service.stop();
});

test("pre-start discovery rejection or timeout preserves consent and continues only deferred ordinary recovery", async t => {
  for (const reason of ["discovery rejection", "child timeout"]) {
    const options = fixture(t), source = path.join(options.layout.stateRoot, "original.json"); fs.writeFileSync(source, "original bytes");
    const service = new DataUpgradeService({ ...options, discover: async () => pending, requestRestart: async () => {} });
    await service.start(); service.accept({ operationId: "operation-startup-failure", expectedRevision: service.snapshot().revision });
    let recoveries = 0;
    await consumeConfirmedDataUpgrades(options.layout, options.rolesRoot, false, {
      discover: async () => { throw new Error(reason); },
      preparePlugins: async input => { recoveries++; assert.equal(input.migrationPolicy, "defer"); assert.deepEqual(input.confirmedMigrationIds, []); return []; }
    });
    assert.equal(recoveries, 1); assert.equal(fs.readFileSync(source, "utf8"), "original bytes");
    const receipt = await readDataUpgradeReceipt(options.layout);
    assert.equal(receipt?.status.state, "interrupted"); assert.equal(receipt?.status.operation?.operationId, "operation-startup-failure");
    assert.deepEqual(receipt?.confirmedItemIds, ["plan:example"]); await service.stop();
  }
});

test("bad confirmation and plugin preparation failure leave the startup status entrance available", async t => {
  const options = fixture(t), receiptPath = path.join(options.layout.stateRoot, "data", ".runtime", "data-upgrades.json");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, "{");
  let attempts = 0;
  await consumeConfirmedDataUpgrades(options.layout, options.rolesRoot, false, { preparePlugins: async input => {
    attempts++; assert.equal(input.migrationPolicy, "defer"); throw new Error("bad plugin profile");
  } });
  assert.equal(attempts, 1); assert.equal(fs.readFileSync(receiptPath, "utf8"), "{");
});
