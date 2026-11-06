import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DshConnectionStore, dshConnectionFile } from "./dshConnectionStore.js";
import type { LocalSecretProtector } from "../../../shared/localSecretProtection.js";

const protector: LocalSecretProtector = {
  scheme: "test-only",
  protect: value => Buffer.from(value).toString("base64"),
  unprotect: value => Buffer.from(value, "base64").toString("utf8")
};

test("DSH connections persist protected, origin-bound credentials with revision fencing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connection-"));
  const file = path.join(root, "connections.json");
  try {
    const store = new DshConnectionStore(file, protector);
    const origin = "http://127.0.0.1:39270";
    assert.equal(store.readMetadata().revision, 0);
    const expiresAt = Date.now() + 60_000;
    store.connect(origin, { cookie: "dsh-auth-fixture=private-fixture", expiresAt }, 0);
    const reopened = new DshConnectionStore(file, protector);
    assert.equal(reopened.resolve(origin)?.cookie, "dsh-auth-fixture=private-fixture");
    assert.equal(reopened.resolve("http://127.0.0.1:39271"), undefined);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /private-fixture/);
    assert.doesNotMatch(JSON.stringify(reopened.readMetadata()), /private-fixture|protectedCredential|test-only/);
    reopened.invalidate(origin, "dsh-auth-fixture=stale-cookie");
    assert.equal(reopened.readMetadata().revision, 1);
    assert.throws(() => reopened.disconnect(origin, 0), /changed/);
    reopened.disconnect(origin, 1);
    assert.deepEqual(reopened.resolve(origin), { state: "disconnected" });
    assert.equal(reopened.readMetadata().revision, 2);
    assert.equal(reopened.readMetadata().connections[0]?.state, "disconnected");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH protected connection corruption and expiry do not enable legacy fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connection-negative-"));
  const file = path.join(root, "connections.json");
  try {
    const store = new DshConnectionStore(file, protector);
    const origin = "http://127.0.0.1:39270";
    store.connect(origin, { cookie: "dsh-auth-fixture=fixture", expiresAt: Date.now() + 60_000 }, 0);
    assert.equal(store.resolve(origin, Date.now() + 120_000)?.state, "expired");
    store.invalidate(origin, "dsh-auth-fixture=fixture");
    assert.equal(store.resolve(origin)?.state, "expired");
    assert.equal(store.readMetadata().revision, 2);
    fs.writeFileSync(file, "{broken");
    assert.throws(() => store.resolve(origin), /unreadable/);
    assert.throws(() => store.connect(origin, { cookie: "dsh-auth-fixture=fixture", expiresAt: Date.now() + 60_000 }, 1), /unreadable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one corrupt connection stays local and healthy writes preserve its original raw row", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connection-rows-")), file = path.join(root, "connections.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DshConnectionStore(file, protector), first = "http://127.0.0.1:39270", second = "http://127.0.0.1:39271";
  const credential = { cookie: "dsh-auth-fixture=original", expiresAt: Date.now() + 60_000 };
  store.connect(first, credential, 0);
  store.connect(second, credential, 1);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.connections[0].state = "broken";
  saved.connections.push(null);
  fs.writeFileSync(file, JSON.stringify(saved));
  const reopened = new DshConnectionStore(file, protector), metadata = reopened.readMetadata();
  assert.equal(metadata.partial, true);
  assert.deepEqual(metadata.connections.map(row => row.baseUrl), [second]);
  assert.deepEqual(metadata.diagnostics.map(row => [row.rowIndex, row.baseUrl]), [[0, first], [2, undefined]]);
  assert.equal(reopened.resolve(second)?.cookie, credential.cookie);
  assert.throws(() => reopened.resolve(first), /unreadable/);
  reopened.connect(second, { ...credential, cookie: "dsh-auth-fixture=updated" }, metadata.revision);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.connections[0], saved.connections[0]);
  assert.equal(after.connections[2], null);
  reopened.connect(first, credential, after.revision);
  assert.equal(reopened.resolve(first)?.cookie, credential.cookie, "Explicit reconnect repairs only its identified entry.");
});

test("duplicate connection identities stay ambiguous without rejecting an independent origin", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connection-duplicates-")), file = path.join(root, "connections.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DshConnectionStore(file, protector), first = "http://127.0.0.1:39270", second = "http://127.0.0.1:39271";
  const credential = { cookie: "dsh-auth-fixture=original", expiresAt: Date.now() + 60_000 };
  store.connect(first, credential, 0); store.connect(second, credential, 1);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")); saved.connections.push({ ...saved.connections[0] });
  const raw = JSON.stringify(saved); fs.writeFileSync(file, raw);
  assert.equal(store.resolve(second)?.cookie, credential.cookie);
  assert.throws(() => store.resolve(first), /unreadable/);
  assert.throws(() => store.connect(first, credential, saved.revision), /duplicate/);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
});

test("default DSH state remains under the application root after source ownership moves", t => {
  const original = { packageRoot: process.env.RABIROUTE_PACKAGE_ROOT, stateRoot: process.env.RABIROUTE_STATE_ROOT };
  t.after(() => {
    if (original.packageRoot === undefined) delete process.env.RABIROUTE_PACKAGE_ROOT; else process.env.RABIROUTE_PACKAGE_ROOT = original.packageRoot;
    if (original.stateRoot === undefined) delete process.env.RABIROUTE_STATE_ROOT; else process.env.RABIROUTE_STATE_ROOT = original.stateRoot;
  });
  delete process.env.RABIROUTE_PACKAGE_ROOT; delete process.env.RABIROUTE_STATE_ROOT;
  assert.equal(dshConnectionFile(), path.join(process.cwd(), "data", "plugins", "io.rabiroute.agent.dsh", "credentials", "connections.json"));
});
