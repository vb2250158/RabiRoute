import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DshConnectionStore } from "./dshConnectionStore.js";
import type { LocalSecretProtector } from "./shared/localSecretProtection.js";

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
