import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeviceIdentityOwner, deviceIdentityConfigField, type OfflineIdentityLease } from "./deviceIdentity.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { loadTunnelIdentity } from "../peerTunnel/security.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-device-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RabiGlobalConfigStore(root);
  const owner = new DeviceIdentityOwner(root, { machineIdentity: () => "os-id-pc-a" });
  const config = store.configPath;
  const tunnel = path.join(root, "data", "rabilink");
  const key = path.join(tunnel, "tunnel-identity.json");
  const marker = path.join(tunnel, "device-identity.json");
  const pending = path.join(tunnel, "identity-reset-pending.json");
  const lease: OfflineIdentityLease = { schemaVersion: 1, stateRoot: root, pid: process.ppid, nonce: "a".repeat(64) };
  return { root, store, owner, config, tunnel, key, marker, pending, lease };
}
function parse(file: string): Record<string, any> { return JSON.parse(fs.readFileSync(file, "utf8")); }

test("first binding preserves legacy GUID/key and survives device and hostname display renames", t => {
  const f = fixture(t);
  const original = parse(f.config);
  original.rabiGuid = "legacy-guid";
  fs.writeFileSync(f.config, JSON.stringify(original));
  loadTunnelIdentity(f.key, "pc-a", "generation-a");
  const oldKey = fs.readFileSync(f.key);
  f.owner.assertStartup();
  f.owner.ensureBound();
  assert.equal(parse(f.config).rabiGuid, "legacy-guid");
  assert.deepEqual(fs.readFileSync(f.key), oldKey);
  const store = new RabiGlobalConfigStore(f.root);
  store.patch({ rabiName: "Renamed PC", rabiLinkRelay: { deviceId: "renamed-pc" } });
  f.owner.assertStartup();
  assert.equal(parse(f.config).rabiGuid, "legacy-guid");
  assert.deepEqual(parse(f.config)[deviceIdentityConfigField], parse(f.marker));
  assert.equal(deviceIdentityConfigField in store.read(), false);
  assert.equal(JSON.stringify(store.read()).includes("machineOwner"), false);
});

test("copying only bound Config.json to a fresh PC blocks before creating keys or changing the GUID", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-device-copy-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(path.join(target, "data"));
  const copied = path.join(target, "data", "Config.json");
  fs.copyFileSync(f.config, copied);
  const before = fs.readFileSync(copied);
  const owner = new DeviceIdentityOwner(target, { machineIdentity: () => "os-id-pc-b" });
  assert.throws(() => owner.assertStartup(), /identity_foreign_machine/);
  assert.throws(() => owner.ensureBound(), /identity_foreign_machine/);
  assert.deepEqual(fs.readFileSync(copied), before);
  assert.equal(fs.existsSync(path.join(target, "data", "rabilink", "tunnel-identity.json")), false);
});

test("whole bound identity copy rejects a different OS owner; matching owner can recreate a missing local marker", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const bytes = fs.readFileSync(f.config);
  assert.throws(() => new DeviceIdentityOwner(f.root, { machineIdentity: () => "os-id-pc-b" }).assertStartup(), /identity_foreign_machine/);
  assert.deepEqual(fs.readFileSync(f.config), bytes);
  fs.unlinkSync(f.marker);
  f.owner.ensureBound();
  assert.deepEqual(parse(f.config)[deviceIdentityConfigField], parse(f.marker));
});

test("bound identity cannot silently rotate a missing, corrupt or replaced tunnel key", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const configBytes = fs.readFileSync(f.config);
  fs.unlinkSync(f.key);
  assert.throws(() => f.owner.ensureBound(), /identity_tunnel_key_missing/);
  assert.equal(fs.existsSync(f.key), false);
  fs.writeFileSync(f.key, "corrupt-key");
  assert.throws(() => f.owner.assertStartup(), /identity_tunnel_key_invalid/);
  fs.unlinkSync(f.key);
  loadTunnelIdentity(f.key, "pc-a", "new-generation");
  assert.throws(() => f.owner.assertStartup(), /identity_tunnel_key_mismatch/);
  assert.deepEqual(fs.readFileSync(f.config), configBytes);
});

test("GUID/binding tampering and missing bound config fail before normalization", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const saved = parse(f.config);
  fs.writeFileSync(f.config, JSON.stringify({ ...saved, rabiGuid: "replaced-guid" }));
  assert.throws(() => f.owner.assertStartup(), /identity_guid_mismatch/);
  fs.writeFileSync(f.config, JSON.stringify({ ...saved, [deviceIdentityConfigField]: {} }));
  assert.throws(() => f.owner.assertStartup(), /identity_binding_invalid/);
  fs.writeFileSync(f.config, "malformed-json");
  assert.throws(() => f.owner.assertStartup(), /identity_invalid_record/);
  assert.equal(fs.readFileSync(f.config, "utf8"), "malformed-json");
  fs.unlinkSync(f.config);
  assert.throws(() => f.owner.assertStartup(), /identity_config_missing/);
});

test("read-only startup neither adopts legacy config nor creates tunnel credentials", t => {
  const f = fixture(t);
  const bytes = fs.readFileSync(f.config);
  f.owner.ensureBound(true);
  assert.deepEqual(fs.readFileSync(f.config), bytes);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(f.key), false);
});

test("offline reset rotates GUID and key together, backs up exact old identity and preserves business data and grants", t => {
  const f = fixture(t);
  const configured = f.store.patch({ rabiName: "PC A", rabiLinkRelay: { enabled: true, token: "private-test-token", deviceId: "pc-a", url: "https://relay.example.test" } });
  f.owner.ensureBound();
  const oldConfig = fs.readFileSync(f.config), oldKey = fs.readFileSync(f.key);
  const tunnelConfig = path.join(f.tunnel, "tunnel.json");
  const business = path.join(f.root, "data", "keep.json");
  fs.writeFileSync(tunnelConfig, '{"trustedDevices":[{"deviceId":"peer-b","services":["manager"]}]}');
  fs.writeFileSync(business, '{"routes":["route-a"],"personas":["persona-a"],"plans":["plan-a"]}');
  const grants = fs.readFileSync(tunnelConfig), data = fs.readFileSync(business);
  const audits: RecordedDataMutationAudit[] = [];
  const release = installDataMutationAuditSink(value => audits.push(value));
  t.after(release);
  const receipt = f.owner.resetOffline({ expectedGuid: configured.rabiGuid, name: "PC B", deviceId: "pc-b", lease: f.lease });
  assert.equal(receipt.outcome, "committed");
  assert.notEqual(receipt.newGuid, configured.rabiGuid);
  assert.equal(receipt.oldGuid, configured.rabiGuid);
  assert.deepEqual(fs.readFileSync(path.join(receipt.backupDirectory, "config.before")), oldConfig);
  assert.deepEqual(fs.readFileSync(path.join(receipt.backupDirectory, "key.before")), oldKey);
  assert.notDeepEqual(fs.readFileSync(f.key), oldKey);
  const raw = parse(f.config);
  assert.equal(raw.rabiGuid, receipt.newGuid);
  assert.equal(raw.rabiName, "PC B");
  assert.deepEqual(raw.rabiLinkRelay, { ...configured.rabiLinkRelay, deviceId: "pc-b" });
  assert.deepEqual(fs.readFileSync(tunnelConfig), grants);
  assert.deepEqual(fs.readFileSync(business), data);
  assert.equal(fs.existsSync(f.pending), false);
  f.owner.assertStartup();
  const entries = audits.filter(value => value.owner === "DeviceIdentityOwner");
  assert.deepEqual(entries.map(value => value.outcome), ["started", "committed"]);
  assert.equal(JSON.stringify(audits).includes("os-id-pc-a"), false);
  assert.equal(JSON.stringify(audits).includes(raw[deviceIdentityConfigField].machineOwner), false);
  assert.equal(JSON.stringify(audits).includes("private-test-token"), false);
  assert.equal(JSON.stringify(receipt).includes("PRIVATE KEY"), false);
});

test("wrong expected GUID or absent/currently unrelated offline owner refuses without mutations", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.config);
  assert.throws(() => f.owner.resetOffline({ expectedGuid: "wrong-guid", lease: f.lease }), /identity_expected_guid_mismatch/);
  assert.throws(() => f.owner.resetOffline({ expectedGuid: f.store.read().rabiGuid, lease: { ...f.lease, pid: process.pid } }), /identity_offline_lease_invalid/);
  assert.throws(() => f.owner.resetOffline({ expectedGuid: f.store.read().rabiGuid, lease: { ...f.lease, nonce: "short" } }), /identity_offline_lease_invalid/);
  assert.equal(fs.existsSync(f.pending), false);
  assert.equal(fs.existsSync(f.key), false);
  assert.deepEqual(fs.readFileSync(f.config), before);
});

test("interrupted identity transaction blocks startup and explicit recovery restores exact prior files", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const originals = [f.config, f.key, f.marker].map(file => fs.readFileSync(file));
  const interrupted = new DeviceIdentityOwner(f.root, { machineIdentity: () => "os-id-pc-a", afterReplace: file => {
    if (file === "key") throw new Error("injected interruption");
  } });
  assert.throws(() => interrupted.resetOffline({ expectedGuid: f.store.read().rabiGuid, lease: f.lease }), /injected interruption/);
  assert.throws(() => f.owner.assertStartup(), /identity_reset_pending/);
  const journal = parse(f.pending);
  const receipt = f.owner.recoverOffline({ operationId: journal.operationId, lease: f.lease });
  assert.equal(receipt.outcome, "rolled_back");
  assert.equal(fs.existsSync(f.pending), false);
  for (const [index, file] of [f.config, f.key, f.marker].entries()) assert.deepEqual(fs.readFileSync(file), originals[index]);
  f.owner.assertStartup();
});

test("rollback refuses external edits before restoring any file", t => {
  const f = fixture(t);
  const interrupted = new DeviceIdentityOwner(f.root, { machineIdentity: () => "os-id-pc-a", afterReplace: () => { throw new Error("interrupted"); } });
  assert.throws(() => interrupted.resetOffline({ expectedGuid: f.store.read().rabiGuid, lease: f.lease }), /interrupted/);
  const changedConfig = fs.readFileSync(f.config);
  fs.writeFileSync(f.key, "independent edit");
  const journal = parse(f.pending);
  assert.throws(() => f.owner.recoverOffline({ operationId: journal.operationId, lease: f.lease }), /identity_recovery_external_change/);
  assert.deepEqual(fs.readFileSync(f.config), changedConfig);
  assert.equal(fs.readFileSync(f.key, "utf8"), "independent edit");
  assert.equal(fs.existsSync(f.pending), true);
});

test("public CLI requires the direct offline parent lease and emits only a receipt", t => {
  const f = fixture(t);
  const leaseFile = path.join(f.root, "offline-lease.json");
  fs.writeFileSync(leaseFile, JSON.stringify({ ...f.lease, pid: process.pid }));
  const entry = fileURLToPath(new URL("./deviceIdentityCli.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", entry, "reset", "--state-root", f.root,
    "--expected-guid", f.store.read().rabiGuid, "--operation-id", randomUUID(), "--offline-lease", leaseFile], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.receipt.outcome, "committed");
  assert.equal(response.receipt.newGuid, parse(f.config).rabiGuid);
  assert.equal(result.stdout.includes("machineOwner"), false);
  assert.equal(result.stdout.includes("PRIVATE KEY"), false);
  const persistedReceipt = parse(path.join(response.receipt.backupDirectory, "receipt.json"));
  assert.equal("backupDirectory" in persistedReceipt, false);
  assert.equal(persistedReceipt.schemaVersion, 1);
  assert.equal(persistedReceipt.completedAt, response.receipt.completedAt);
  new DeviceIdentityOwner(f.root).assertStartup();
  const invalid = spawnSync(process.execPath, ["--import", "tsx", entry, "reset", "--state-root", f.root,
    "--expected-guid", response.receipt.newGuid, "--offline-lease", leaseFile, "--state-root", f.root], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), { ok: false, error: "identity_arguments_invalid" });
});

test("Host-precreated operation directories and repeated reset use one committed identity", t => {
  const f = fixture(t);
  const operationId = randomUUID();
  const directory = path.join(f.tunnel, "identity-resets", operationId);
  fs.mkdirSync(directory, { recursive: true });
  const status = path.join(directory, "host-status.json");
  fs.writeFileSync(status, JSON.stringify({ schemaVersion: 1, operationId, state: "queued" }));
  const input = { expectedGuid: f.store.read().rabiGuid, operationId, lease: f.lease };
  const receipt = f.owner.resetOffline(input);
  const key = fs.readFileSync(f.key), config = fs.readFileSync(f.config);
  assert.deepEqual(f.owner.resetOffline(input), receipt);
  assert.deepEqual(f.owner.recoverOffline({ ...input }), receipt);
  assert.deepEqual(fs.readFileSync(f.key), key);
  assert.deepEqual(fs.readFileSync(f.config), config);
  assert.equal(parse(status).state, "queued");
  assert.throws(() => f.owner.resetOffline({ ...input, expectedGuid: receipt.newGuid }), /identity_operation_conflict/);
});

test("commit receipt written before pending clear can complete recovery without a second key rotation", t => {
  const f = fixture(t);
  const operationId = randomUUID();
  const receipt = f.owner.resetOffline({ expectedGuid: f.store.read().rabiGuid, operationId, lease: f.lease });
  fs.copyFileSync(path.join(receipt.backupDirectory, "journal.json"), f.pending);
  const config = fs.readFileSync(f.config), key = fs.readFileSync(f.key);
  assert.throws(() => f.owner.assertStartup(), /identity_reset_pending/);
  assert.deepEqual(f.owner.recoverOffline({ operationId, expectedGuid: receipt.oldGuid, lease: f.lease }), receipt);
  assert.equal(fs.existsSync(f.pending), false);
  assert.deepEqual(fs.readFileSync(f.config), config);
  assert.deepEqual(fs.readFileSync(f.key), key);
  f.owner.assertStartup();
});

test("an early rejected operation may recover unchanged only when the expected bound identity still owns the machine", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const operationId = randomUUID();
  const config = fs.readFileSync(f.config), key = fs.readFileSync(f.key);
  const receipt = f.owner.recoverOffline({ operationId, expectedGuid: f.store.read().rabiGuid, lease: f.lease });
  assert.equal(receipt.outcome, "rolled_back");
  assert.equal(receipt.oldGuid, receipt.newGuid);
  assert.deepEqual(fs.readFileSync(f.config), config);
  assert.deepEqual(fs.readFileSync(f.key), key);
  assert.throws(() => f.owner.recoverOffline({ operationId: randomUUID(), expectedGuid: "stale-guid", lease: f.lease }), /identity_expected_guid_mismatch/);
  const foreign = new DeviceIdentityOwner(f.root, { machineIdentity: () => "os-id-pc-b" });
  assert.throws(() => foreign.recoverOffline({ operationId: randomUUID(), expectedGuid: f.store.read().rabiGuid, lease: f.lease }), /identity_foreign_machine/);
});

test("global config normalization preserves private binding while read/patch DTO never returns it", t => {
  const f = fixture(t);
  f.owner.ensureBound();
  const config = parse(f.config);
  delete config.performance;
  delete config.agentUploads;
  fs.writeFileSync(f.config, JSON.stringify(config));
  const store = new RabiGlobalConfigStore(f.root);
  assert.deepEqual(parse(f.config)[deviceIdentityConfigField], config[deviceIdentityConfigField]);
  assert.equal(deviceIdentityConfigField in store.read(), false);
  assert.equal(deviceIdentityConfigField in store.patch({ rabiName: "PC renamed" }), false);
  assert.deepEqual(parse(f.config)[deviceIdentityConfigField], config[deviceIdentityConfigField]);
  f.owner.assertStartup();
});
