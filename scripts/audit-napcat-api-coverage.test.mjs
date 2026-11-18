import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditNapcatBundle, auditNapcatWebuiCoverage } from "./audit-napcat-api-coverage.mjs";

function fixture(payload = "Type.Object({ id: Type.String(), optional: Type.Optional(Type.Any()) })") {
  return `
const napCatVersion = "4.18.4";
const ActionName = { Read: "get_example", Unimplemented: "set_group_anonymous", Unknown: "unknown" };
class OneBotAction {}
class ReadBase extends OneBotAction { payloadSchema = ${payload}; returnSchema = Type.Null(); }
class Read extends ReadBase { actionName = ActionName.Read; actionSummary = "Example"; }
function getAllHandlers(obContext, core) { const actionHandlers = [new Read(obContext, core), new Read(obContext, core)]; return actionHandlers; }
function createActionMap(obContext, core) {
 const actionHandlers = getAllHandlers(obContext, core);
 const map = new Map();
 actionHandlers.forEach(h => { map.set(h.actionName, h); map.set(\`\${h.actionName}_async\`, h); map.set(\`\${h.actionName}_rate_limited\`, h); });
 AutoRegisterRouter.forEach(ActionClass => new ActionClass());
}
const router = Router(); const app = express();
router.post("/read", readHandler); app.use("/api", router); app.get("/page", pageHandler);
class OneBotEvent {}
class BaseEvent extends OneBotEvent { post_type = "notice"; }
class ConcreteEvent extends BaseEvent { notice_type = "example"; sub_type = "initial"; user_id; constructor(subtype) { super(); this.sub_type = subtype; } }
new ConcreteEvent();
`;
}

function audit(source, extra = {}) {
  return auditNapcatBundle(source, { version: "4.18.4", expectedSha256: crypto.createHash("sha256").update(source).digest("hex"), ...extra });
}

test("extracts explicit registry duplicates, inherited schemas and generated aliases", () => {
  const result = audit(fixture());
  assert.equal(result.counts.registeredBaseActions, 1);
  assert.equal(result.counts.duplicateRegistryEntries, 1);
  assert.equal(result.counts.registeredNamesIncludingAliases, 3);
  assert.deepEqual(result.actions[0].aliases, ["get_example_async", "get_example_rate_limited"]);
  assert.deepEqual(result.actions[0].payloadContract.schema.required, ["id"]);
  assert.deepEqual(result.actions[0].payloadContract.schema.properties.optional, { "x-typebox-optional": true });
  assert.equal(result.counts.instantiatedEventClasses, 1);
  assert.equal(result.counts.eventBaseClasses, 1);
  const event = result.events.find(item => item.className === "ConcreteEvent");
  assert.equal(event.fields.includes("post_type"), true);
  assert.equal(event.selectors.sub_type.resolved, false);
  assert.equal(event.selectors.sub_type.initialValue, "initial");
  assert.deepEqual(result.webuiRoutes.map(item => item.path), ["/api/read", "/page"]);
});

test("preserves unknown schema expressions without executing arbitrary source", () => {
  const result = audit(fixture("Type.Unimplemented(globalThis.untrustedNapcatAuditProbe = true)"));
  assert.equal(result.counts.unresolvedSchemas, 1);
  assert.equal(result.actions[0].payloadContract.resolved, false);
  assert.equal(result.actions[0].payloadContract.schema, null);
  assert.match(result.unresolvedSchemas[0].reason, /unsupported Type.Unimplemented/);
  assert.equal(globalThis.untrustedNapcatAuditProbe, undefined);
});

test("distinguishes an upstream absent schema from an unconstrained schema", () => {
  const absent = audit(fixture("void 0")).actions[0].payloadContract;
  assert.equal(absent.resolved, true);
  assert.deepEqual(absent.schema, { "x-upstream-schema-absent": true });
  assert.deepEqual(audit(fixture("Type.Any()")).actions[0].payloadContract.schema, {});
});

test("requires the explicit source identity and excludes unregistered constants", () => {
  assert.throws(() => auditNapcatBundle(fixture(), { version: "4.18.4", expectedSha256: "0".repeat(64) }), /SHA256 mismatch/);
  assert.throws(() => audit(fixture(), { version: "4.18.5" }), /declared version mismatch/);
  const result = audit(fixture());
  assert.equal(result.actions.some(item => item.action === "set_group_anonymous"), false);
  assert.equal(result.standardComparison.absent.includes("set_group_anonymous"), true);
  assert.equal(result.standardComparison.absent.includes("set_group_anonymous_ban"), true);
  assert.equal(result.groupJoining.activeApplicationAction, null);
  assert.deepEqual(result.groupJoining.registeredActionsContainingJoin, []);
});

test("published 4.18.4 facts preserve the verified action, route and event denominators", async () => {
  const contract = JSON.parse(await fs.readFile(new URL("../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json", import.meta.url), "utf8"));
  assert.equal(contract.counts.businessActions, 165);
  assert.equal(contract.counts.testActions, 2);
  assert.equal(contract.counts.registeredNamesIncludingAliases, 501);
  assert.equal(contract.counts.webuiApiRoutes, 112);
  assert.equal(contract.counts.pageRoutes, 3);
  assert.equal(contract.counts.instantiatedEventClasses, 25);
  assert.equal(contract.counts.eventBaseClasses, 6);
  assert.equal(contract.counts.messageEventProjections, 1);
  assert.deepEqual(contract.standardComparison.absent, ["set_group_anonymous", "set_group_anonymous_ban"]);
  assert.equal(contract.unregisteredActionConstants.some(item => item.action === ".get_word_slices"), true);
  assert.deepEqual(contract.groupJoining.registeredActionsContainingJoin, []);
  assert.equal(contract.actions.find(item => item.action === "get_version_info").payloadContract.schema["x-upstream-schema-absent"], true);
  assert.equal(contract.source.upstream.currentMainStatus, "README-only");
  assert.doesNotMatch(JSON.stringify(contract), /handleSource|constructorSource|handlerSources|C:\\\\Users|Administrator/);
});

test("CLI combines an explicit Rabi snapshot deterministically and reports unknown-schema exit status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-api-audit-"));
  try {
    const source = fixture("Type.UnknownNewKind()");
    const bundle = path.join(directory, "bundle.mjs");
    const snapshot = path.join(directory, "catalog.json");
    const output = path.join(directory, "out.json");
    await fs.writeFile(bundle, source);
    await fs.writeFile(snapshot, JSON.stringify({ rows: [{ operationId: "manager.test", upstreamOneBotActions: ["get_example", "missing_action"] }],
      webuiKnownActions: ["/api/read", "/api/missing"] }));
    const args = [fileURLToPath(new URL("./audit-napcat-api-coverage.mjs", import.meta.url)),
      "--bundle", bundle, "--version", "4.18.4", "--sha256", crypto.createHash("sha256").update(source).digest("hex"),
      "--rabi-catalog", snapshot, "--output", output];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 2, first.stderr);
    const bytes = await fs.readFile(output, "utf8");
    assert.deepEqual(JSON.parse(bytes).rabiCoverage.rows, [{ action: "get_example", operationIds: ["manager.test"] }]);
    assert.deepEqual(JSON.parse(bytes).rabiCoverage.unregisteredReferences, [{ action: "missing_action", operationIds: ["manager.test"] }]);
    assert.deepEqual(JSON.parse(bytes).rabiCoverage.unregisteredWebuiPathReferences, ["/api/missing"]);
    assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 2);
    assert.equal(await fs.readFile(output, "utf8"), bytes);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("versioned WebUI coverage reconciles 17 summaries, 13 compatible owners, 16 management shapes, 58 dependencies and 8 host boundaries", async () => {
  const facts = JSON.parse(await fs.readFile(new URL("../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json", import.meta.url), "utf8"));
  const declaration = JSON.parse(await fs.readFile(new URL("../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-webui-4.18.4-coverage.json", import.meta.url), "utf8"));
  const result = auditNapcatWebuiCoverage(facts, declaration);
  assert.deepEqual(result.counts.byState, { "typed-summary": 17, "existing-native-owner": 13, "typed-management": 16, "owner-dependency": 58, "host-owner-boundary": 8 });
  assert.equal(result.counts.total, 112);
  assert.equal(result.counts.implementedSourceRows, 46);
  assert.equal(result.counts.rabiOnlyOperations, 1);
  assert.equal(result.counts.byInventoryGroupAndState["protected-typed-owner"]["typed-management"], 16);
  assert.equal(result.rabiOnlyOperations[0].nativeCoverageContribution, 0);
  assert.equal(result.implementationRelease.firstPublicationVersionForManagement, "0.1.15");
  assert.equal(result.counts.byInventoryGroup["protected-typed-owner"], 75);
  assert.equal(result.rows.find(row => row.path === "/api/WebUIConfig/GetSSLStatus").state, "typed-summary");
  assert.throws(() => auditNapcatWebuiCoverage(facts, { ...declaration, rows: declaration.rows.slice(1) }), /missing native API rows/);
  const duplicate = [...declaration.rows]; duplicate[0] = duplicate[1];
  assert.throws(() => auditNapcatWebuiCoverage(facts, { ...declaration, rows: duplicate }), /duplicate method\/path/);
  const falseReady = structuredClone(declaration); falseReady.rows[0].runtimeAcceptance = "accepted";
  assert.throws(() => auditNapcatWebuiCoverage(facts, falseReady), /cannot assert runtime acceptance/);
  const wrongCount = structuredClone(declaration); wrongCount.counts.byState["typed-summary"] = 18;
  assert.throws(() => auditNapcatWebuiCoverage(facts, wrongCount), /counts do not match/);
  const falseReceiptCoverage = structuredClone(declaration);
  falseReceiptCoverage.rabiOnlyOperations[0].nativeCoverageContribution = 1;
  assert.throws(() => auditNapcatWebuiCoverage(facts, falseReceiptCoverage), /receipts cannot contribute native/);
  const badGroups = structuredClone(declaration);
  badGroups.counts.byInventoryGroupAndState["protected-typed-owner"]["typed-management"] = 15;
  assert.throws(() => auditNapcatWebuiCoverage(facts, badGroups), /group counts do not match/);
  const receiptInNativeRows = structuredClone(declaration);
  receiptInNativeRows.rows.push({ ...receiptInNativeRows.rows[0], ...receiptInNativeRows.rabiOnlyOperations[0] });
  assert.throws(() => auditNapcatWebuiCoverage(facts, receiptInNativeRows), /Unknown or duplicate method/);
});
