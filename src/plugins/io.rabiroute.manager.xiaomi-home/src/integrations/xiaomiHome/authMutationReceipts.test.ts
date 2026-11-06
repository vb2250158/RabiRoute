import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { XiaomiHomeAuthMutationReceipts } from "./authMutationReceipts.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-xiaomi-auth-receipts-"));
}

const snapshot = Object.freeze({
  schemaVersion: 1 as const,
  state: "ready" as const,
  configured: true,
  credentialSource: "protected" as const,
  removable: true,
  baseUrl: "http://127.0.0.1:8123",
  revision: "authorization-current"
});

test("Xiaomi Home auth receipt replays a matching committed mutation and rejects changed intent", async () => {
  const runtimeDir = temporaryDirectory();
  try {
    const receipts = new XiaomiHomeAuthMutationReceipts(runtimeDir);
    let calls = 0;
    const operation = async () => { calls += 1; return snapshot; };
    assert.deepEqual(await receipts.execute("xiaomi-home-connect-test-0001", { operation: "connect", tokenHash: "a" }, operation), snapshot);
    assert.deepEqual(await receipts.execute("xiaomi-home-connect-test-0001", { operation: "connect", tokenHash: "a" }, operation), snapshot);
    assert.equal(calls, 1);
    await assert.rejects(
      () => receipts.execute("xiaomi-home-connect-test-0001", { operation: "connect", tokenHash: "b" }, operation),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_home_idempotency_conflict"
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Xiaomi Home auth receipt releases deterministic rejections and preserves uncertain effects", async () => {
  const runtimeDir = temporaryDirectory();
  try {
    const receipts = new XiaomiHomeAuthMutationReceipts(runtimeDir);
    const key = "xiaomi-home-connect-test-0002";
    const intent = { operation: "connect", tokenHash: "a" };
    await assert.rejects(
      () => receipts.execute(key, intent, async () => { throw new XiaomiHomeManagerApiError(401, "xiaomi_home_unauthorized", "Rejected."); }),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.status === 401
    );
    assert.deepEqual(await receipts.execute(key, intent, async () => snapshot), snapshot);

    const uncertainKey = "xiaomi-home-connect-test-0003";
    await assert.rejects(() => receipts.execute(uncertainKey, intent, async () => { throw new Error("connection lost"); }));
    await assert.rejects(
      () => new XiaomiHomeAuthMutationReceipts(runtimeDir).execute(uncertainKey, intent, async () => snapshot),
      (error: unknown) => error instanceof XiaomiHomeManagerApiError && error.code === "xiaomi_home_auth_result_uncertain"
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
