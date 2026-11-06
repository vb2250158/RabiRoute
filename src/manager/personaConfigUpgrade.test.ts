import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upgradePersonaMessageConfig, restorePersonaMessageConfig } from "./personaConfigUpgrade.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";
import { DEFAULT_RECENT_MESSAGE_LIMIT } from "../shared/gatewayConfigModel.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-upgrade-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const persona = path.join(root, "data/roles/Example/personaConfig.json");
  const route = path.join(root, "data/route/main/adapterConfig.json");
  const legacy = path.join(root, "data/roles/Example/roleMessageConfig.json");
  for (const file of [persona, route]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(persona, JSON.stringify({ customExtension: { preserved: true }, automationRules: [] }));
  fs.writeFileSync(route, JSON.stringify({ id: "main", agentRoleId: "Example", enabled: true, gatewayPort: 9000, messageAdapters: ["webhook"], recentMessageLimit: 12, languageStyle: { styleSkillUrl: "skill://example-style" }, agentAdapter: "codex", agentModel: "example-model", codexThreadId: "existing-task", adapterExtension: { keep: true } }));
  fs.writeFileSync(legacy, JSON.stringify({ notificationRules: [] }));
  const originals = [persona, route, legacy].map(file => fs.readFileSync(file));
  return { root, persona, route, legacy, originals };
}

test("preview never changes source; apply preserves references, endpoints and extensions; repeat is a no-op; restore is exact", t => {
  const f = fixture(t);
  const preview = upgradePersonaMessageConfig({ root: f.root });
  assert.ok(preview.changedFiles >= 2);
  assert.equal(preview.applied, false);
  [f.persona, f.route, f.legacy].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.originals[index]));
  const result = upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  assert.ok(result.snapshot);
  const persona = JSON.parse(fs.readFileSync(f.persona, "utf8"));
  const route = JSON.parse(fs.readFileSync(f.route, "utf8"));
  assert.equal(persona.recentMessageLimits.webhook, 12);
  assert.deepEqual(persona.customExtension, { preserved: true });
  assert.deepEqual(persona.languageStyle, { styleSkillUrl: "skill://example-style" });
  assert.equal(route.agentRoleId, "Example");
  assert.equal(route.codexThreadId, "existing-task");
  assert.equal(route.agentModel, "example-model");
  assert.equal(route.gatewayPort, 9000);
  assert.deepEqual(route.adapterExtension, { keep: true });
  assert.equal(route.recentMessageLimit, undefined);
  assert.equal(route.languageStyle, undefined);
  assert.equal(fs.existsSync(f.legacy), false);
  assert.equal(upgradePersonaMessageConfig({ root: f.root }).changedFiles, 0);
  restorePersonaMessageConfig(result.snapshot!, true);
  [f.persona, f.route, f.legacy].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.originals[index]));
});

test("partial failure restores originals and concurrent edits are preserved", t => {
  const f = fixture(t);
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true, beforeWrite(index) { if (index === 1) throw new Error("injected failure"); } }), /restored/);
  [f.persona, f.route, f.legacy].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.originals[index]));
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true, beforeWrite(index) { if (index === 0) fs.writeFileSync(f.persona, '{"concurrent":true}'); } }), /restored/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.persona, "utf8")), { concurrent: true });
});

test("malformed, unbound legacy and online apply fail before source writes", t => {
  const f = fixture(t);
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root, apply: true }), /offline/);
  fs.writeFileSync(f.persona, "{broken");
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root }), /Invalid JSON/);
  fs.writeFileSync(f.persona, f.originals[0]);
  const route = JSON.parse(f.originals[1].toString());
  delete route.agentRoleId;
  fs.writeFileSync(f.route, JSON.stringify(route));
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root }), /Unbound Route/);
  assert.deepEqual(fs.readFileSync(f.persona), f.originals[0]);
});

test("remote persona routes stay local and are not merged into same-name local personas", t => {
  const f = fixture(t);
  const remote = JSON.parse(f.originals[1].toString());
  remote.agentRoleDeviceId = "e583b1c2-7663-4057-b804-796aba9bb0c6";
  fs.writeFileSync(f.route, JSON.stringify(remote));
  const original = fs.readFileSync(f.route);
  upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  assert.deepEqual(fs.readFileSync(f.route), original);
  assert.equal(JSON.parse(fs.readFileSync(f.persona, "utf8")).recentMessageLimits.webhook, DEFAULT_RECENT_MESSAGE_LIMIT);
});

test("restore refuses to overwrite configuration edited after upgrade", t => {
  const f = fixture(t);
  const result = upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  fs.writeFileSync(f.route, '{"userEdit":true}');
  assert.throws(() => restorePersonaMessageConfig(result.snapshot!, true), /no restore was started/);
  assert.equal(fs.readFileSync(f.route, "utf8"), '{"userEdit":true}');
});

test("an interrupted prepared snapshot restores only written files and preserves untouched originals", t => {
  const f = fixture(t);
  const result = upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  const manifestPath = path.join(result.snapshot!, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.state = "prepared";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(f.persona, f.originals[0]);
  restorePersonaMessageConfig(result.snapshot!, true);
  [f.persona, f.route, f.legacy].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.originals[index]));
});


test("configuration migration persists its unified audit facts without configuration content or private paths", t => {
  const f = fixture(t), records: RecordedDataMutationAudit[] = [];
  t.after(installDataMutationAuditSink(record => { if (record.owner === "persona-config-upgrade") records.push(record); }));
  const result = upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  const receipt = JSON.parse(fs.readFileSync(path.join(result.snapshot!, "manifest.json"), "utf8"));
  assert.deepEqual(receipt.audit.map((row: RecordedDataMutationAudit) => row.outcome), ["started", "committed"]);
  assert.deepEqual(receipt.audit, JSON.parse(JSON.stringify(records)));
  assert.ok(records.every(record => record.before?.digest && record.after?.digest));
  assert.ok(!JSON.stringify(records).includes(f.root));
  assert.doesNotMatch(JSON.stringify(records), /existing-task|example-model|styleSkillUrl/);
  restorePersonaMessageConfig(result.snapshot!, true);
  assert.equal(records.at(-1)?.outcome, "committed");
  const failed = fixture(t);
  assert.throws(() => upgradePersonaMessageConfig({ root: failed.root, apply: true, offline: true,
    beforeWrite(index) { if (index === 1) throw new Error("private error content"); } }), /restored/);
  assert.equal(records.at(-1)?.outcome, "failed");
  assert.equal(records.at(-1)?.result, "restored");
  assert.doesNotMatch(JSON.stringify(records), /private error content/);
});


function roleStorageMetadata(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [relative, content] of [
    ["personaConfig.json", '{"planWorkflow":{"preserved":true}}\n'],
    ["locks/Example/owner.json", '{"operation":"fixture"}\n'],
    ["operations/example.json", '{"state":"prepared"}\n'],
    ["work/Example/lease.json", '{"pid":123,"startedAt":"fixture"}\n']
  ]) {
    const file = path.join(root, "data/roles/.role-state", relative!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(content!); fs.writeFileSync(file, bytes); files.set(file, bytes);
  }
  return files;
}
function assertUnchanged(files: Map<string, Buffer>) {
  for (const [file, bytes] of files) assert.deepEqual(fs.readFileSync(file), bytes, file);
}

test("role storage metadata stays outside full preview, apply and exact restore", t => {
  const f = fixture(t), metadata = roleStorageMetadata(f.root);
  const preview = upgradePersonaMessageConfig({ root: f.root });
  assert.ok(preview.changedFiles >= 2); assertUnchanged(metadata);
  const applied = upgradePersonaMessageConfig({ root: f.root, apply: true, offline: true });
  assert.ok(applied.snapshot); assertUnchanged(metadata);
  const receipt = JSON.parse(fs.readFileSync(path.join(applied.snapshot!, "manifest.json"), "utf8"));
  assert.ok(receipt.entries.every((entry: {file: string}) => !entry.file.includes(".role-state")));
  restorePersonaMessageConfig(applied.snapshot!, true); assertUnchanged(metadata);
  [f.persona, f.route, f.legacy].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.originals[index]));
});

test("scheduled automation preview, apply, repeat and restore leave role storage metadata raw", t => {
  const f = fixture(t), metadata = roleStorageMetadata(f.root);
  const route = JSON.parse(fs.readFileSync(f.route, "utf8"));
  route.messageAdapters.push("heartbeat"); route.heartbeatSkipWhenAgentBusy = true;
  fs.writeFileSync(f.route, JSON.stringify(route));
  const originals = new Map([f.persona, f.route, f.legacy].map(file => [file, fs.readFileSync(file)]));
  const options = { root: f.root, mode: "scheduled_automation" as const };
  const preview = upgradePersonaMessageConfig(options);
  assert.ok(preview.changedFiles >= 2); assert.equal(preview.applied, false);
  assertUnchanged(originals); assertUnchanged(metadata);
  const applied = upgradePersonaMessageConfig({ ...options, apply: true, offline: true });
  assert.ok(applied.snapshot); assertUnchanged(metadata);
  assert.equal(JSON.parse(fs.readFileSync(f.persona, "utf8")).automationScheduleSchemaVersion, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.route, "utf8")).messageAdapters, ["webhook"]);
  assert.equal(upgradePersonaMessageConfig(options).changedFiles, 0);
  restorePersonaMessageConfig(applied.snapshot!, true); assertUnchanged(originals); assertUnchanged(metadata);
});

test("other invalid persona names and the same reserved name under Routes still require review", t => {
  for (const [kind, directory, filename] of [
    ["roles", ".business-role", "personaConfig.json"],
    ["roles", ".role-state-copy", "personaConfig.json"],
    ["route", ".role-state", "adapterConfig.json"]
  ]) {
    const f = fixture(t), metadata = roleStorageMetadata(f.root);
    const file = path.join(f.root, "data", kind!, directory!, filename!);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"automationRules":[]}');
    assert.throws(() => upgradePersonaMessageConfig({ root: f.root, mode: "scheduled_automation" }),
      error => error instanceof Error && error.message === `Configuration directory name requires review: ${directory}`);
    assertUnchanged(metadata);
    [f.persona, f.route, f.legacy].forEach((name, index) => assert.deepEqual(fs.readFileSync(name), f.originals[index]));
  }
});


test("reserved metadata junction is not followed while actual linked persona candidates still require review", t => {
  const f = fixture(t);
  const target = path.join(f.root, "unrelated-metadata-target");
  fs.mkdirSync(target); const file = path.join(target, "personaConfig.json");
  fs.writeFileSync(file, "{not role configuration");
  const reserved = path.join(f.root, "data/roles/.role-state");
  fs.symlinkSync(target, reserved, process.platform === "win32" ? "junction" : "dir");
  assert.ok(upgradePersonaMessageConfig({ root: f.root }).changedFiles >= 2);
  assert.equal(fs.readFileSync(file, "utf8"), "{not role configuration");
  const linkedRole = path.join(f.root, "data/roles/LinkedPersona");
  fs.symlinkSync(target, linkedRole, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => upgradePersonaMessageConfig({ root: f.root }), /Linked configuration directory requires review: LinkedPersona/);
});

test("reserved metadata case follows the host filesystem platform without skipping similarly named roles", t => {
  const f = fixture(t);
  const file = path.join(f.root, "data/roles/.ROLE-STATE/personaConfig.json");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{not role configuration");
  if (process.platform === "win32") assert.ok(upgradePersonaMessageConfig({ root: f.root }).changedFiles >= 2);
  else assert.throws(() => upgradePersonaMessageConfig({ root: f.root }), /Configuration directory name requires review: .ROLE-STATE/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not role configuration");
});
