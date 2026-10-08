import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  durableDeliveryReceiptPath,
  readDurableDeliveryReceiptSnapshot,
  reconcileDurableDelivery,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

function fixture(t: test.TestContext, state: "sending" | "uncertain" | "completed" = "sending") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-reconcile-test-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const namespace = "isolated-delivery";
  const deliveryId = "example-delivery-001";
  const payload = { content: "example" };
  const file = durableDeliveryReceiptPath(rootDir, namespace, deliveryId);
  const receipt: DurableDeliveryReceipt<{ accepted: string }> = {
    version: 1, deliveryId,
    requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    state, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z",
    executionId: "example-execution", ownerHost: "example-remote-owner", ownerPid: 1,
    renewal: "mtime", leaseDurationMs: 100,
    audit: { source: "example" },
    ...(state === "completed" ? { result: { accepted: "original" } } : {})
  };
  const save = (value = receipt) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    fs.utimesSync(file, new Date(0), new Date(0));
  };
  save();
  return { rootDir, namespace, deliveryId, payload, file, receipt, save };
}

for (const state of ["sending", "uncertain"] as const) {
  test(`authoritative historical success reconciles ${state} without sending`, async t => {
    const f = fixture(t, state);
    const result = await reconcileDurableDelivery({ ...f, verify: async original => {
      assert.equal(original.deliveryId, f.deliveryId);
      assert.equal(original.requestDigest, f.receipt.requestDigest);
      return { state: "completed", result: { accepted: "historical-proof" } };
    } });
    assert.equal(result.state, "completed");
    if (result.state === "completed") assert.equal(result.settlement, "committed");
    const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
    assert.equal(saved.deliveryId, f.deliveryId);
    assert.equal(saved.requestDigest, f.receipt.requestDigest);
    assert.equal(saved.createdAt, f.receipt.createdAt);
    assert.deepEqual(saved.audit, f.receipt.audit);
    assert.deepEqual(saved.result, { accepted: "historical-proof" });
    assert.equal(saved.executionId, undefined);
  });
}

test("uncertain proof and verification exception leave receipt unchanged", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, "utf8");
  for (const verify of [
    async () => ({ state: "uncertain" as const, reason: "insufficient evidence" }),
    async () => { throw new Error("verification failed"); }
  ]) {
    assert.equal((await reconcileDurableDelivery({ ...f, verify })).state, "uncertain");
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
});

test("digest conflict refuses verification", async t => {
  const f = fixture(t);
  assert.equal((await reconcileDurableDelivery({ ...f, payload: { content: "other" },
    verify: async () => { assert.fail("must not verify"); }
  })).state, "conflict");
});

test("active same-host owner is readable but reconciliation refuses verification", async t => {
  const f = fixture(t);
  f.save({ ...f.receipt, ownerHost: os.hostname(), ownerPid: process.pid });
  assert.ok(readDurableDeliveryReceiptSnapshot(f.rootDir, f.namespace, f.deliveryId));
  assert.equal((await reconcileDurableDelivery({ ...f,
    verify: async () => { assert.fail("must not verify active owner"); }
  })).state, "in_progress");
});

for (const change of ["content", "heartbeat", "active", "missing", "digest", "completed"] as const) {
  test(`verification-time ${change} fences settlement`, async t => {
    const f = fixture(t);
    const outcome = await reconcileDurableDelivery({ ...f, verify: async () => {
      if (change === "content") f.save({ ...f.receipt, audit: { source: "changed" } });
      if (change === "heartbeat") fs.utimesSync(f.file, new Date(1000), new Date(1000));
      if (change === "active") f.save({ ...f.receipt, ownerHost: os.hostname(), ownerPid: process.pid });
      if (change === "missing") fs.unlinkSync(f.file);
      if (change === "digest") f.save({ ...f.receipt, requestDigest: "other-digest" });
      if (change === "completed") f.save({ ...f.receipt, state: "completed", result: { accepted: "concurrent" } });
      return { state: "completed", result: { accepted: "stale-proof" } };
    } });
    assert.equal(outcome.state, change === "active" ? "in_progress" : change === "digest" ? "conflict"
      : change === "completed" ? "completed" : "uncertain");
    if (change === "missing") assert.equal(fs.existsSync(f.file), false);
    else assert.notDeepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")).result, { accepted: "stale-proof" });
    if (outcome.state === "completed") {
      assert.deepEqual(outcome.result, { accepted: "concurrent" });
      assert.equal(outcome.settlement, "not_attempted");
    }
  });
}

test("missing or corrupt receipt never creates a receipt or invokes verification", async t => {
  const f = fixture(t);
  for (const corrupt of [false, true]) {
    if (corrupt) fs.writeFileSync(f.file, "invalid-json");
    else fs.unlinkSync(f.file);
    assert.equal((await reconcileDurableDelivery({ ...f, verify: async () => { assert.fail("must not verify"); } })).state, "uncertain");
    assert.equal(fs.existsSync(f.file), corrupt);
    if (corrupt) assert.equal(fs.readFileSync(f.file, "utf8"), "invalid-json");
  }
});

test("completed receipts replay only original result without verification", async t => {
  const f = fixture(t, "completed");
  const before = fs.readFileSync(f.file, "utf8");
  const outcome = await reconcileDurableDelivery({ ...f, verify: async () => { assert.fail("must not verify completed"); } });
  assert.equal(outcome.state, "completed");
  if (outcome.state === "completed") {
    assert.deepEqual(outcome.result, { accepted: "original" });
    assert.equal(outcome.settlement, "not_attempted");
  }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("post-write readback failure never reports completed", async t => {
  const f = fixture(t);
  const originalRename = fs.renameSync;
  const originalRead = fs.readFileSync;
  let committed = false;
  try {
    fs.renameSync = (source, destination) => {
      originalRename(source, destination);
      committed = true;
    };
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (committed && String(args[0]) === f.file) throw new Error("isolated readback failure");
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync;
    assert.equal((await reconcileDurableDelivery({ ...f,
      verify: async () => ({ state: "completed", result: { accepted: "proof" } })
    })).state, "uncertain");
  } finally {
    fs.renameSync = originalRename;
    fs.readFileSync = originalRead;
  }
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).state, "completed");
});

test("snapshot never associates ABA intermediate receipt with original raw revision", t => {
  const f = fixture(t);
  const originalRead = fs.readFileSync;
  const raw = originalRead(f.file, "utf8");
  let reads = 0;
  try {
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === f.file) {
        reads += 1;
        // Model same-metadata ABA observations: A, B, A. The old snapshot
        // parsed B through a separate receipt read, then hashed A.
        return reads === 2 ? JSON.stringify({ ...f.receipt, audit: { source: "intermediate" } }) : raw;
      }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync;
    const snapshot = readDurableDeliveryReceiptSnapshot(f.rootDir, f.namespace, f.deliveryId);
    assert.equal(snapshot, null);
    assert.equal(reads, 2);
  } finally { fs.readFileSync = originalRead; }
});

test("persistence failure returns uncertain and retains original receipt", async t => {
  const f = fixture(t);
  const original = fs.renameSync;
  const before = fs.readFileSync(f.file, "utf8");
  try {
    fs.renameSync = () => { throw Object.assign(new Error("isolated write failure"), { code: "EIO" }); };
    assert.equal((await reconcileDurableDelivery({ ...f,
      verify: async () => ({ state: "completed", result: { accepted: "proof" } })
    })).state, "uncertain");
  } finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});
