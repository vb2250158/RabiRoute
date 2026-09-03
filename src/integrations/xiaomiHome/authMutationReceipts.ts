import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import type { XiaomiHomeAuthorizationSnapshot } from "../../shared/xiaomiHomeAuthContract.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";

type Receipt = Readonly<{
  schemaVersion: 1;
  requestHash: string;
  state: "pending" | "committed" | "uncertain";
  result?: XiaomiHomeAuthorizationSnapshot;
  updatedAt: string;
}>;

function requestHash(intent: unknown): string {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export class XiaomiHomeAuthMutationReceipts {
  private readonly root: string;
  private readonly inFlight = new Map<string, Readonly<{ hash: string; promise: Promise<XiaomiHomeAuthorizationSnapshot> }>>();

  constructor(runtimeDir: string) {
    this.root = path.join(runtimeDir, "auth-mutation-receipts");
  }

  execute(
    key: string,
    intent: unknown,
    operation: () => Promise<XiaomiHomeAuthorizationSnapshot>
  ): Promise<XiaomiHomeAuthorizationSnapshot> {
    const hash = requestHash(intent);
    const active = this.inFlight.get(key);
    if (active) {
      if (active.hash !== hash) return Promise.reject(this.conflict());
      return active.promise;
    }
    let replay: XiaomiHomeAuthorizationSnapshot | undefined;
    try {
      replay = this.reserve(key, hash);
    } catch (error) {
      return Promise.reject(error);
    }
    if (replay) return Promise.resolve(replay);
    const promise = operation().then(result => {
      this.commit(key, hash, result);
      return result;
    }).catch(error => {
      // Validation, lifecycle and revision conflicts have no external commit.
      // Release their reservation so the caller can retry with corrected input.
      // All other failures stay fail-closed because the provider effect may exist.
      if (error instanceof XiaomiHomeManagerApiError && error.status >= 400 && error.status < 500) this.release(key, hash);
      else this.markUncertain(key, hash);
      throw error;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { hash, promise });
    return promise;
  }

  private receiptPath(key: string): string {
    return path.join(this.root, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  private read(filePath: string): Receipt | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Receipt;
      if (value?.schemaVersion !== 1 || !value.requestHash || !["pending", "committed", "uncertain"].includes(value.state)) throw new Error("schema");
      return value;
    } catch {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_auth_receipt_corrupt", "A Xiaomi Home authorization receipt is corrupt.");
    }
  }

  private reserve(key: string, hash: string): XiaomiHomeAuthorizationSnapshot | undefined {
    const filePath = this.receiptPath(key);
    return withFileLockSync(`${filePath}.lock`, () => {
      const current = this.read(filePath);
      if (current) {
        if (current.requestHash !== hash) throw this.conflict();
        if (current.state === "committed" && current.result) return current.result;
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_auth_result_uncertain", "This authorization mutation is pending or uncertain; inspect current authorization state before choosing a new operation.");
      }
      atomicWriteFileSync(filePath, `${JSON.stringify({
        schemaVersion: 1,
        requestHash: hash,
        state: "pending",
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`, { mode: 0o600 });
      return undefined;
    });
  }

  private commit(key: string, hash: string, result: XiaomiHomeAuthorizationSnapshot): void {
    const filePath = this.receiptPath(key);
    withFileLockSync(`${filePath}.lock`, () => {
      const current = this.read(filePath);
      if (!current || current.requestHash !== hash || current.state !== "pending") {
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_auth_result_uncertain", "Authorization completed but its receipt could not be committed safely.");
      }
      atomicWriteFileSync(filePath, `${JSON.stringify({
        schemaVersion: 1,
        requestHash: hash,
        state: "committed",
        result,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`, { mode: 0o600 });
    });
  }

  private release(key: string, hash: string): void {
    const filePath = this.receiptPath(key);
    withFileLockSync(`${filePath}.lock`, () => {
      const current = this.read(filePath);
      if (current?.requestHash === hash && current.state === "pending") fs.unlinkSync(filePath);
    });
  }

  private markUncertain(key: string, hash: string): void {
    const filePath = this.receiptPath(key);
    try {
      withFileLockSync(`${filePath}.lock`, () => {
        const current = this.read(filePath);
        if (!current || current.requestHash !== hash || current.state !== "pending") return;
        atomicWriteFileSync(filePath, `${JSON.stringify({
          ...current,
          state: "uncertain",
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`, { mode: 0o600 });
      });
    } catch {
      // Preserve the pending receipt as fail-closed evidence when settlement cannot be recorded.
    }
  }

  private conflict(): XiaomiHomeManagerApiError {
    return new XiaomiHomeManagerApiError(409, "xiaomi_home_idempotency_conflict", "Idempotency-Key was already used for another authorization mutation.");
  }
}
