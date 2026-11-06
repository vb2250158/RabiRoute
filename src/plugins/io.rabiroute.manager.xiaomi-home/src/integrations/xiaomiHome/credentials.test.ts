import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LocalSecretProtector } from "../../../../../shared/localSecretProtection.js";
import { XiaomiHomeCredentialStore } from "./credentials.js";

const protector: LocalSecretProtector = {
  scheme: "test-protector-v1",
  protect: plaintext => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64"),
  unprotect: value => Buffer.from(value, "base64").toString("utf8").replace(/^protected:/, "")
};

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-xiaomi-credentials-"));
}

test("Xiaomi Home credential store persists only protected material and returns stable metadata", () => {
  const runtimeDir = temporaryDirectory();
  try {
    const store = new XiaomiHomeCredentialStore(runtimeDir, protector);
    const first = store.write("candidate-secret", "http://127.0.0.1:8123", { providerName: "Home", providerVersion: "2026.8" });
    assert.equal(first.source, "protected");
    assert.equal(first.token, "candidate-secret");
    assert.ok(first.metadata?.endpointAccountId);
    const persisted = fs.readFileSync(store.credentialPath, "utf8");
    assert.doesNotMatch(persisted, /candidate-secret|accessToken/);

    const restarted = new XiaomiHomeCredentialStore(runtimeDir, protector).resolve();
    assert.equal(restarted.token, "candidate-secret");
    assert.equal(restarted.metadata?.endpointAccountId, first.metadata?.endpointAccountId);
    assert.equal(restarted.metadata?.providerName, "Home");

    const replaced = store.write("replacement-secret", "http://127.0.0.1:8123", { providerName: "Home 2" });
    assert.equal(replaced.token, "replacement-secret");
    assert.equal(replaced.metadata?.endpointAccountId, first.metadata?.endpointAccountId);
    assert.doesNotMatch(fs.readFileSync(store.credentialPath, "utf8"), /candidate-secret|replacement-secret/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home credential store has one protected source and clear returns it to none", () => {
  const runtimeDir = temporaryDirectory();
  try {
    const store = new XiaomiHomeCredentialStore(runtimeDir, protector);
    assert.deepEqual(store.resolve(), { source: "none", removable: false });
    store.write("protected-secret", "http://127.0.0.1:8123", {});
    assert.equal(store.resolve().token, "protected-secret");
    assert.equal(store.clear(), true);
    assert.deepEqual(store.resolve(), { source: "none", removable: false });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("verified legacy VM binding preserves encrypted credential and fences stale and mismatched evidence", () => {
  const runtimeDir = temporaryDirectory();
  const vmId = "a0000000-0000-0000-0000-000000000001";
  const otherVmId = "a0000000-0000-0000-0000-000000000002";
  try {
    const store = new XiaomiHomeCredentialStore(runtimeDir, protector);
    const original = store.write("migration-secret", "http://127.0.0.1:8123", {});
    const before = JSON.parse(fs.readFileSync(store.credentialPath, "utf8"));
    const request = { expectedRevision: original.metadata!.revision, managedVmId: vmId,
      verifiedLegacyForward: { baseUrl: "http://127.0.0.1:8123", vmId } };
    assert.throws(() => store.bindVerifiedLegacyManagedVm({ ...request, verifiedLegacyForward: { ...request.verifiedLegacyForward, vmId: otherVmId } }));
    assert.throws(() => store.bindVerifiedLegacyManagedVm({ ...request, verifiedLegacyForward: undefined! }));
    assert.throws(() => store.bindVerifiedLegacyManagedVm({ ...request, expectedRevision: "stale" }));
    assert.equal(fs.readFileSync(store.credentialPath, "utf8"), `${JSON.stringify(before, null, 2)}\n`);
    const migrated = store.bindVerifiedLegacyManagedVm(request);
    const after = JSON.parse(fs.readFileSync(store.credentialPath, "utf8"));
    assert.equal(migrated.metadata?.managedVmId, vmId);
    assert.equal(migrated.token, "migration-secret");
    assert.equal(after.protectedCredential, before.protectedCredential);
    assert.doesNotMatch(fs.readFileSync(store.credentialPath, "utf8"), /migration-secret/);
    assert.throws(() => store.bindVerifiedLegacyManagedVm(request));
    const currentRequest = { ...request, expectedRevision: migrated.metadata!.revision };
    assert.equal(store.bindVerifiedLegacyManagedVm(currentRequest).metadata?.revision, migrated.metadata!.revision);
    assert.throws(() => store.bindVerifiedLegacyManagedVm({ ...currentRequest, managedVmId: otherVmId, verifiedLegacyForward: { baseUrl: request.verifiedLegacyForward.baseUrl, vmId: otherVmId } }));
    store.write("replacement-secret", "http://127.0.0.1:8123", {});
    assert.throws(() => store.bindVerifiedLegacyManagedVm(currentRequest));
    const elsewhere = store.write("other-secret", "http://192.168.1.2:8123", {});
    assert.throws(() => store.bindVerifiedLegacyManagedVm({ ...request, expectedRevision: elsewhere.metadata!.revision }));
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});

test("new verified authorization can bind a VM, while ordinary replacement clears the binding", () => {
  const runtimeDir = temporaryDirectory();
  try {
    const store = new XiaomiHomeCredentialStore(runtimeDir, protector);
    const vmId = "A0000000-0000-0000-0000-000000000001";
    assert.throws(() => store.write("secret", "http://127.0.0.1:8123", { managedVmId: "invalid" }));
    const bound = store.write("secret", "http://127.0.0.1:8123", { managedVmId: vmId });
    assert.equal(bound.metadata?.managedVmId, vmId.toLowerCase());
    assert.equal(new XiaomiHomeCredentialStore(runtimeDir, protector).resolve().metadata?.managedVmId, vmId.toLowerCase());
    assert.equal(store.write("new-secret", "http://127.0.0.1:8123", {}).metadata?.managedVmId, undefined);
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});
