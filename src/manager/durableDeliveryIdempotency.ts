import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";

export type DurableDeliveryReceiptState = "reserved" | "sending" | "completed" | "uncertain";

export type DurableDeliveryReceipt<TResult> = {
  version: 1;
  deliveryId: string;
  requestDigest: string;
  state: DurableDeliveryReceiptState;
  createdAt: string;
  updatedAt: string;
  audit?: unknown;
  result?: TResult;
  error?: string;
  executionId?: string;
  ownerHost?: string;
  ownerPid?: number;
  leaseExpiresAt?: string;
  leaseDurationMs?: number;
  renewal?: "mtime";
};

export type DurableDeliveryOutcome<TResult> =
  | { state: "completed"; deliveryId: string; duplicate: boolean; result: TResult }
  | { state: "in_progress" | "uncertain" | "conflict"; deliveryId: string; duplicate: boolean; reason: string };

export type DurableDeliveryOptions<TResult> = {
  rootDir: string;
  namespace: string;
  deliveryId: unknown;
  payload: unknown;
  audit?: unknown;
  deliver: () => Promise<TResult>;
  recover?: (error: unknown) => Promise<
    | { state: "completed"; result: TResult }
    | { state: "retry" }
    | { state: "in_progress" | "uncertain"; reason: string }
  >;
  /** Mutation-only escape hatch: an owning replacement may prove an existing
   * uncertain receipt before deciding whether one retry is safe. Ordinary
   * message delivery deliberately leaves this disabled. */
  recoverExistingUncertain?: boolean;
  /** A proven, non-committing rejection (for example an optimistic CAS miss)
   * must not become a terminal idempotency receipt. */
  retryableRejection?: (result: TResult) => boolean;
  waitForCompletionMs?: number;
  executionLeaseMs?: number;
};

const RECEIPT_VERSION = 1;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_EXECUTION_LEASE_MS = 15 * 60_000;
const RECEIPT_HEARTBEAT_STOP_INDEX = 0;
const RECEIPT_HEARTBEAT_STATUS_INDEX = 1;
const RECEIPT_HEARTBEAT_FAILURE_INDEX = 2;
const RECEIPT_HEARTBEAT_STARTING = 0;
const RECEIPT_HEARTBEAT_ACTIVE = 1;
const RECEIPT_HEARTBEAT_STOPPED = 3;
const RECEIPT_HEARTBEAT_CONTROL_WORDS = 4;
const RECEIPT_HEARTBEAT_WAIT_TIMEOUT_MS = 10_000;

const RECEIPT_HEARTBEAT_WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const STOP_INDEX = 0;
const STATUS_INDEX = 1;
const FAILURE_INDEX = 2;
const COUNT_INDEX = 3;
const STARTING = 0;
const ACTIVE = 1;
const FAILED = 2;
const STOPPED = 3;
const FAILURE_MISSING = 1;
const FAILURE_INVALID = 2;
const FAILURE_OWNER_CHANGED = 3;
const FAILURE_FENCED = 4;
const FAILURE_EXPIRED = 5;
const FAILURE_IO = 6;
const FAILURE_MUTATION_LOCKED = 7;

function publishStatus(status) {
  Atomics.store(control, STATUS_INDEX, status);
  Atomics.notify(control, STATUS_INDEX);
}

function fail(code) {
  if (Atomics.load(control, STATUS_INDEX) === FAILED) return false;
  Atomics.store(control, FAILURE_INDEX, code);
  publishStatus(FAILED);
  return false;
}

function heartbeatFailure(code) {
  const error = new Error("durable delivery heartbeat failed");
  error.heartbeatFailure = code;
  throw error;
}

function sameStat(left, right) {
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseRecord(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function ownedRecord(record) {
  return record
    && record.version === workerData.version
    && record.deliveryId === workerData.deliveryId
    && record.requestDigest === workerData.digest
    && record.state === "sending"
    && record.executionId === workerData.executionId
    && typeof record.ownerHost === "string"
    && record.ownerHost.toLowerCase() === workerData.ownerHost.toLowerCase()
    && record.ownerPid === workerData.ownerPid
    && record.renewal === "mtime"
    && record.leaseDurationMs === workerData.leaseMs;
}

function renew(allowExpired) {
  let descriptor;
  let failure = 0;
  try {
    // Claim and terminal mutations linearize under this lock. If it already
    // exists, a contender may have read an expired receipt and decided to
    // replace it, so this owner must not revive the old execution.
    if (fs.existsSync(workerData.mutationLockPath)) {
      heartbeatFailure(FAILURE_MUTATION_LOCKED);
    }
    descriptor = fs.openSync(workerData.receiptPath, "r+");
    const before = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (!sameStat(before, after)) heartbeatFailure(FAILURE_INVALID);
    const record = parseRecord(raw);
    if (!ownedRecord(record)) heartbeatFailure(FAILURE_FENCED);
    if (!Number.isFinite(record.leaseDurationMs) || record.leaseDurationMs <= 0) {
      heartbeatFailure(FAILURE_INVALID);
    }
    if (!allowExpired && after.mtimeMs + record.leaseDurationMs <= Date.now()) {
      heartbeatFailure(FAILURE_EXPIRED);
    }
    const currentBefore = fs.statSync(workerData.receiptPath);
    if (!sameIdentity(after, currentBefore)) heartbeatFailure(FAILURE_OWNER_CHANGED);
    if (!ownedRecord(parseRecord(fs.readFileSync(workerData.receiptPath, "utf8")))) {
      heartbeatFailure(FAILURE_OWNER_CHANGED);
    }
    const renewedAt = new Date(Math.max(Date.now(), Math.ceil(after.mtimeMs) + 1));
    fs.futimesSync(descriptor, renewedAt, renewedAt);
    const renewed = fs.fstatSync(descriptor);
    if (!(renewed.mtimeMs > after.mtimeMs)) heartbeatFailure(FAILURE_INVALID);
    if (renewed.mtimeMs + record.leaseDurationMs <= Date.now()) heartbeatFailure(FAILURE_EXPIRED);
    const currentAfter = fs.statSync(workerData.receiptPath);
    if (!sameIdentity(renewed, currentAfter)) heartbeatFailure(FAILURE_OWNER_CHANGED);
    if (!ownedRecord(parseRecord(fs.readFileSync(workerData.receiptPath, "utf8")))) {
      heartbeatFailure(FAILURE_OWNER_CHANGED);
    }
    // This second check closes acquisition during renewal: a claimant that
    // acquires after this point must read the mtime we just advanced, while a
    // claimant that acquired earlier fences publication of this renewal.
    if (fs.existsSync(workerData.mutationLockPath)) {
      heartbeatFailure(FAILURE_MUTATION_LOCKED);
    }
    Atomics.add(control, COUNT_INDEX, 1);
  } catch (error) {
    failure = error && Number.isInteger(error.heartbeatFailure)
      ? Number(error.heartbeatFailure)
      : error && error.code === "ENOENT" ? FAILURE_MISSING : FAILURE_IO;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { failure ||= FAILURE_IO; }
    }
  }
  return failure ? fail(failure) : true;
}

try {
  // No delivery side effect begins until this first ownership proof succeeds.
  // It may renew a still-current receipt after a slow Worker startup; the
  // before/after path identity checks fence any contender that claimed first.
  if (renew(true)) {
    publishStatus(ACTIVE);
    while (Atomics.load(control, STOP_INDEX) === 0) {
      Atomics.wait(control, STOP_INDEX, 0, workerData.intervalMs);
      if (Atomics.load(control, STOP_INDEX) !== 0) break;
      if (!renew(false)) break;
    }
    if (Atomics.load(control, STATUS_INDEX) === ACTIVE) publishStatus(STOPPED);
  }
} catch {
  fail(FAILURE_IO);
}
`;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestDigest(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

export function normalizeDurableDeliveryId(value: unknown): string {
  const deliveryId = String(value || "").trim();
  if (!deliveryId) throw new Error("Missing deliveryId.");
  if (deliveryId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(deliveryId)) throw new Error("Invalid deliveryId.");
  return deliveryId;
}

function normalizedNamespace(value: string): string {
  const namespace = String(value || "").trim();
  if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error("Invalid durable delivery namespace.");
  return namespace;
}

export function durableDeliveryReceiptPath(rootDir: string, namespace: string, deliveryId: string): string {
  const normalizedId = normalizeDurableDeliveryId(deliveryId);
  const fileName = `${createHash("sha256").update(normalizedId, "utf8").digest("hex")}.json`;
  return path.join(path.resolve(rootDir), "data", normalizedNamespace(namespace), fileName);
}

function parseReceipt<TResult>(filePath: string): DurableDeliveryReceipt<TResult> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DurableDeliveryReceipt<TResult>>;
    if (
      parsed.version !== RECEIPT_VERSION
      || !parsed.deliveryId
      || !parsed.requestDigest
      || !["reserved", "sending", "completed", "uncertain"].includes(String(parsed.state))
    ) return null;
    if (parsed.state === "sending" && parsed.renewal === "mtime"
      && Number.isFinite(parsed.leaseDurationMs) && Number(parsed.leaseDurationMs) > 0) {
      parsed.leaseExpiresAt = new Date(
        fs.statSync(filePath).mtimeMs + Number(parsed.leaseDurationMs)
      ).toISOString();
    }
    return parsed as DurableDeliveryReceipt<TResult>;
  } catch {
    return null;
  }
}

export function readDurableDeliveryReceipt<TResult>(
  rootDir: string,
  namespace: string,
  deliveryId: string
): DurableDeliveryReceipt<TResult> | null {
  const normalizedId = normalizeDurableDeliveryId(deliveryId);
  const receipt = parseReceipt<TResult>(durableDeliveryReceiptPath(rootDir, namespace, normalizedId));
  return receipt?.deliveryId === normalizedId ? receipt : null;
}

function writeReceipt<TResult>(
  rootDir: string,
  namespace: string,
  receipt: DurableDeliveryReceipt<TResult>
): DurableDeliveryReceipt<TResult> {
  atomicWriteFileSync(
    durableDeliveryReceiptPath(rootDir, namespace, receipt.deliveryId),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  return receipt;
}

function reserveReceipt<TResult>(
  rootDir: string,
  namespace: string,
  deliveryId: string,
  digest: string,
  executionId: string,
  leaseMs: number,
  audit?: unknown
): { created: boolean; receipt: DurableDeliveryReceipt<TResult> | null } {
  const filePath = durableDeliveryReceiptPath(rootDir, namespace, deliveryId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = new Date().toISOString();
  const receipt: DurableDeliveryReceipt<TResult> = {
    version: RECEIPT_VERSION,
    deliveryId,
    requestDigest: digest,
    state: "sending",
    createdAt: now,
    updatedAt: now,
    executionId,
    ownerHost: os.hostname(),
    ownerPid: process.pid,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    leaseDurationMs: leaseMs,
    renewal: "mtime",
    ...(audit === undefined ? {} : { audit })
  };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    return { created: true, receipt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { created: false, receipt: readDurableDeliveryReceipt<TResult>(rootDir, namespace, deliveryId) };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

type DurableDeliveryClaim<TResult> = Readonly<{
  claimed: boolean;
  receipt: DurableDeliveryReceipt<TResult> | null;
}>;

function receiptMutationLockPath(rootDir: string, namespace: string, deliveryId: string): string {
  return `${durableDeliveryReceiptPath(rootDir, namespace, deliveryId)}.mutation.lock`;
}

function withReceiptMutationLock<T>(
  rootDir: string,
  namespace: string,
  deliveryId: string,
  action: () => T
): T {
  return withFileLockSync(
    receiptMutationLockPath(rootDir, namespace, deliveryId),
    action,
    { timeoutMs: 1_000, staleMs: 5_000 }
  );
}

function sameHostOwnerAlive(receipt: DurableDeliveryReceipt<unknown>): boolean {
  if (!receipt.ownerHost || receipt.ownerHost.toLowerCase() !== os.hostname().toLowerCase()
    || !Number.isInteger(receipt.ownerPid) || Number(receipt.ownerPid) <= 0) return false;
  try {
    process.kill(Number(receipt.ownerPid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function receiptExecutionActive(receipt: DurableDeliveryReceipt<unknown>): boolean {
  if (receipt.state !== "sending" || !receipt.executionId) return false;
  if (sameHostOwnerAlive(receipt)) return true;
  const leaseExpiresAt = Date.parse(String(receipt.leaseExpiresAt || ""));
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

function claimReceipt<TResult>(input: Readonly<{
  rootDir: string;
  namespace: string;
  deliveryId: string;
  digest: string;
  executionId: string;
  leaseMs: number;
  allowUncertain: boolean;
}>): DurableDeliveryClaim<TResult> {
  return withReceiptMutationLock(input.rootDir, input.namespace, input.deliveryId, () => {
    const current = readDurableDeliveryReceipt<TResult>(input.rootDir, input.namespace, input.deliveryId);
    if (!current || current.requestDigest !== input.digest) return { claimed: false, receipt: current };
    if (current.state === "completed") return { claimed: false, receipt: current };
    if (current.state === "uncertain" && !input.allowUncertain) return { claimed: false, receipt: current };
    if (receiptExecutionActive(current)) return { claimed: false, receipt: current };
    const now = new Date().toISOString();
    const claimed = writeReceipt(input.rootDir, input.namespace, {
      ...current,
      state: "sending",
      updatedAt: now,
      error: undefined,
      executionId: input.executionId,
      ownerHost: os.hostname(),
      ownerPid: process.pid,
      leaseExpiresAt: new Date(Date.now() + input.leaseMs).toISOString(),
      leaseDurationMs: input.leaseMs,
      renewal: "mtime"
    });
    return { claimed: true, receipt: claimed };
  });
}

function mutateOwnedReceipt<TResult>(input: Readonly<{
  rootDir: string;
  namespace: string;
  deliveryId: string;
  digest: string;
  executionId: string;
  mutate: (current: DurableDeliveryReceipt<TResult>) => DurableDeliveryReceipt<TResult> | null;
}>): DurableDeliveryReceipt<TResult> | null {
  return withReceiptMutationLock(input.rootDir, input.namespace, input.deliveryId, () => {
    const current = readDurableDeliveryReceipt<TResult>(input.rootDir, input.namespace, input.deliveryId);
    if (!current
      || current.requestDigest !== input.digest
      || current.executionId !== input.executionId
      || current.state !== "sending") return null;
    const next = input.mutate(current);
    if (!next) {
      fs.unlinkSync(durableDeliveryReceiptPath(input.rootDir, input.namespace, input.deliveryId));
      return current;
    }
    return writeReceipt(input.rootDir, input.namespace, next);
  });
}

function heartbeatFailure(failure: number, phase: string): Error & { code: string } {
  const detail = new Map<number, string>([
    [1, "receipt disappeared"],
    [2, "receipt became invalid or unstable"],
    [3, "receipt inode changed"],
    [4, "receipt ownership or fencing token changed"],
    [5, "receipt lease expired before renewal"],
    [6, "heartbeat I/O failed"],
    [7, "receipt mutation is already being decided"]
  ]).get(failure) ?? "heartbeat worker did not confirm receipt ownership";
  return Object.assign(new Error(`Durable delivery lease lost during ${phase}: ${detail}.`), {
    code: "DURABLE_DELIVERY_LEASE_LOST"
  });
}

function waitForReceiptHeartbeatTransition(control: Int32Array, expected: number): number {
  const deadline = Date.now() + RECEIPT_HEARTBEAT_WAIT_TIMEOUT_MS;
  let status = Atomics.load(control, RECEIPT_HEARTBEAT_STATUS_INDEX);
  while (status === expected) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return status;
    Atomics.wait(control, RECEIPT_HEARTBEAT_STATUS_INDEX, expected, Math.min(remaining, 250));
    status = Atomics.load(control, RECEIPT_HEARTBEAT_STATUS_INDEX);
  }
  return status;
}

function startReceiptHeartbeat(input: Readonly<{
  rootDir: string;
  namespace: string;
  deliveryId: string;
  digest: string;
  executionId: string;
  ownerHost: string;
  ownerPid: number;
  leaseMs: number;
}>): () => void {
  const receiptPath = durableDeliveryReceiptPath(input.rootDir, input.namespace, input.deliveryId);
  const intervalMs = Math.max(50, Math.floor(input.leaseMs / 3));
  const control = new Int32Array(new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * RECEIPT_HEARTBEAT_CONTROL_WORDS
  ));
  const worker = new Worker(RECEIPT_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: {
      control: control.buffer,
      deliveryId: input.deliveryId,
      digest: input.digest,
      executionId: input.executionId,
      intervalMs,
      leaseMs: input.leaseMs,
      mutationLockPath: receiptMutationLockPath(input.rootDir, input.namespace, input.deliveryId),
      ownerHost: input.ownerHost,
      ownerPid: input.ownerPid,
      receiptPath,
      version: RECEIPT_VERSION
    }
  });
  worker.unref();
  worker.on("error", () => undefined);

  const startupStatus = waitForReceiptHeartbeatTransition(control, RECEIPT_HEARTBEAT_STARTING);
  if (startupStatus !== RECEIPT_HEARTBEAT_ACTIVE) {
    Atomics.store(control, RECEIPT_HEARTBEAT_STOP_INDEX, 1);
    Atomics.notify(control, RECEIPT_HEARTBEAT_STOP_INDEX);
    void worker.terminate().catch(() => undefined);
    throw heartbeatFailure(
      Atomics.load(control, RECEIPT_HEARTBEAT_FAILURE_INDEX),
      startupStatus === RECEIPT_HEARTBEAT_STARTING ? "heartbeat startup" : "initial renewal"
    );
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    Atomics.store(control, RECEIPT_HEARTBEAT_STOP_INDEX, 1);
    Atomics.notify(control, RECEIPT_HEARTBEAT_STOP_INDEX);
    const status = waitForReceiptHeartbeatTransition(control, RECEIPT_HEARTBEAT_ACTIVE);
    if (status !== RECEIPT_HEARTBEAT_STOPPED) {
      void worker.terminate().catch(() => undefined);
    }
  };
}

async function waitForTerminal<TResult>(
  rootDir: string,
  namespace: string,
  deliveryId: string,
  timeoutMs: number
): Promise<DurableDeliveryReceipt<TResult> | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const receipt = readDurableDeliveryReceipt<TResult>(rootDir, namespace, deliveryId);
    if (!receipt || receipt.state === "completed" || receipt.state === "uncertain") return receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return readDurableDeliveryReceipt<TResult>(rootDir, namespace, deliveryId);
}

function pendingOutcome<TResult>(
  deliveryId: string,
  state: "in_progress" | "uncertain" | "conflict",
  reason: string,
  duplicate = true
): DurableDeliveryOutcome<TResult> {
  return { state, deliveryId, duplicate, reason };
}

function settleOwnedResult<TResult>(
  options: DurableDeliveryOptions<TResult>,
  receipt: DurableDeliveryReceipt<TResult>,
  digest: string,
  executionId: string,
  result: TResult,
  duplicate: boolean
): DurableDeliveryOutcome<TResult> {
  const retryable = options.retryableRejection?.(result) === true;
  const settled = mutateOwnedReceipt<TResult>({
    rootDir: options.rootDir,
    namespace: options.namespace,
    deliveryId: receipt.deliveryId,
    digest,
    executionId,
    mutate: current => retryable ? null : ({
      ...current,
      state: "completed",
      updatedAt: new Date().toISOString(),
      result,
      error: undefined,
      executionId: undefined,
      ownerHost: undefined,
      ownerPid: undefined,
      leaseExpiresAt: undefined,
      leaseDurationMs: undefined,
      renewal: undefined
    })
  });
  if (!settled) {
    return pendingOutcome(
      receipt.deliveryId,
      "uncertain",
      retryable
        ? "The non-committing rejection receipt could not be released safely."
        : "The delivery execution lost ownership before its completed receipt was committed.",
      duplicate
    );
  }
  return { state: "completed", deliveryId: receipt.deliveryId, duplicate, result };
}

function markOwnedUncertain<TResult>(
  options: DurableDeliveryOptions<TResult>,
  receipt: DurableDeliveryReceipt<TResult>,
  digest: string,
  executionId: string,
  reason: string
): boolean {
  return Boolean(mutateOwnedReceipt<TResult>({
    rootDir: options.rootDir,
    namespace: options.namespace,
    deliveryId: receipt.deliveryId,
    digest,
    executionId,
    mutate: current => ({
      ...current,
      state: "uncertain",
      updatedAt: new Date().toISOString(),
      error: reason,
      executionId: undefined,
      ownerHost: undefined,
      ownerPid: undefined,
      leaseExpiresAt: undefined,
      leaseDurationMs: undefined,
      renewal: undefined
    })
  }));
}

function releaseOwnedSending<TResult>(
  options: DurableDeliveryOptions<TResult>,
  receipt: DurableDeliveryReceipt<TResult>,
  digest: string,
  executionId: string
): boolean {
  return Boolean(mutateOwnedReceipt<TResult>({
    rootDir: options.rootDir,
    namespace: options.namespace,
    deliveryId: receipt.deliveryId,
    digest,
    executionId,
    mutate: current => ({
      ...current,
      updatedAt: new Date().toISOString(),
      executionId: undefined,
      ownerHost: undefined,
      ownerPid: undefined,
      leaseExpiresAt: undefined,
      leaseDurationMs: undefined,
      renewal: undefined
    })
  }));
}

async function executeClaimedDelivery<TResult>(input: Readonly<{
  options: DurableDeliveryOptions<TResult>;
  receipt: DurableDeliveryReceipt<TResult>;
  digest: string;
  executionId: string;
  leaseMs: number;
  recoverFirst: boolean;
  recoveryError?: unknown;
}>): Promise<DurableDeliveryOutcome<TResult>> {
  const { options, receipt, digest, executionId } = input;
  let stopHeartbeat: () => void;
  try {
    const ownerHost = String(receipt.ownerHost || "");
    const ownerPid = Number(receipt.ownerPid);
    if (!ownerHost || !Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error("Durable delivery receipt has no valid execution owner.");
    }
    stopHeartbeat = startReceiptHeartbeat({
      rootDir: options.rootDir,
      namespace: options.namespace,
      deliveryId: receipt.deliveryId,
      digest,
      executionId,
      ownerHost,
      ownerPid,
      leaseMs: input.leaseMs
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retained = markOwnedUncertain(options, receipt, digest, executionId, reason);
    return pendingOutcome(
      receipt.deliveryId,
      "uncertain",
      retained ? reason : "The delivery execution lost ownership before its heartbeat started.",
      input.recoverFirst
    );
  }
  const uncertain = (reason: string, duplicate: boolean): DurableDeliveryOutcome<TResult> => {
    const retained = markOwnedUncertain(options, receipt, digest, executionId, reason);
    return pendingOutcome(
      receipt.deliveryId,
      "uncertain",
      retained ? reason : "The delivery execution lost ownership before its uncertain receipt was committed.",
      duplicate
    );
  };
  const inProgress = (reason: string, duplicate: boolean): DurableDeliveryOutcome<TResult> => {
    releaseOwnedSending(options, receipt, digest, executionId);
    return pendingOutcome(receipt.deliveryId, "in_progress", reason, duplicate);
  };
  const deliverOnce = async (duplicate: boolean): Promise<DurableDeliveryOutcome<TResult>> => {
    try {
      const result = await options.deliver();
      return settleOwnedResult(options, receipt, digest, executionId, result, duplicate);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return uncertain(
        `${reason} The one authorized recovery retry did not produce a terminal receipt; do not resend automatically.`,
        duplicate
      );
    }
  };

  try {
    if (input.recoverFirst) {
      if (!options.recover) {
        return inProgress("The delivery is already reserved or sending; query its receipt before retrying.", true);
      }
      let recovery: Awaited<ReturnType<NonNullable<DurableDeliveryOptions<TResult>["recover"]>>>;
      try {
        recovery = await options.recover(input.recoveryError);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return uncertain(`${reason} Recovery could not determine the earlier delivery result.`, true);
      }
      if (recovery.state === "completed") {
        return settleOwnedResult(options, receipt, digest, executionId, recovery.result, true);
      }
      if (recovery.state === "retry") return deliverOnce(false);
      if (recovery.state === "in_progress") return inProgress(recovery.reason, true);
      return uncertain(recovery.reason, true);
    }

    try {
      const result = await options.deliver();
      return settleOwnedResult(options, receipt, digest, executionId, result, false);
    } catch (error) {
      if (!options.recover) {
        const message = error instanceof Error ? error.message : String(error);
        return uncertain(`${message} The send result is uncertain; do not resend automatically.`, false);
      }
      let recovery: Awaited<ReturnType<NonNullable<DurableDeliveryOptions<TResult>["recover"]>>>;
      try {
        recovery = await options.recover(error);
      } catch (recoveryError) {
        const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        return uncertain(`${reason} Recovery could not determine the delivery result.`, false);
      }
      if (recovery.state === "completed") {
        return settleOwnedResult(options, receipt, digest, executionId, recovery.result, false);
      }
      if (recovery.state === "retry") return deliverOnce(false);
      if (recovery.state === "in_progress") return inProgress(recovery.reason, false);
      return uncertain(recovery.reason, false);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return uncertain(`${reason} The delivery owner failed before committing a terminal receipt.`, input.recoverFirst);
  } finally {
    stopHeartbeat();
  }
}

export async function executeDurableDelivery<TResult>(
  options: DurableDeliveryOptions<TResult>
): Promise<DurableDeliveryOutcome<TResult>> {
  const deliveryId = normalizeDurableDeliveryId(options.deliveryId);
  const digest = requestDigest(options.payload);
  const executionId = randomUUID();
  const leaseMs = Math.max(100, Math.floor(options.executionLeaseMs ?? DEFAULT_EXECUTION_LEASE_MS));
  const reservation = reserveReceipt<TResult>(
    options.rootDir,
    options.namespace,
    deliveryId,
    digest,
    executionId,
    leaseMs,
    options.audit
  );
  if (reservation.created) {
    return executeClaimedDelivery({
      options,
      receipt: reservation.receipt as DurableDeliveryReceipt<TResult>,
      digest,
      executionId,
      leaseMs,
      recoverFirst: false
    });
  }

  let existing = reservation.receipt;
  if (!existing) return pendingOutcome(deliveryId, "uncertain", "The delivery receipt is unreadable; do not resend automatically.");
  if (existing.requestDigest !== digest) return pendingOutcome(deliveryId, "conflict", "The deliveryId is already reserved for a different payload.");
  if (existing.state === "completed" && existing.result !== undefined) {
    return { state: "completed", deliveryId, duplicate: true, result: existing.result };
  }
  if (existing.state !== "uncertain") {
    existing = await waitForTerminal<TResult>(
      options.rootDir,
      options.namespace,
      deliveryId,
      options.waitForCompletionMs ?? DEFAULT_WAIT_MS
    ) || existing;
    if (existing.requestDigest !== digest) {
      return pendingOutcome(deliveryId, "conflict", "The deliveryId is already reserved for a different payload.");
    }
    if (existing.state === "completed" && existing.result !== undefined) {
      return { state: "completed", deliveryId, duplicate: true, result: existing.result };
    }
  }
  if (existing.state === "uncertain" && (!options.recoverExistingUncertain || !options.recover)) {
    return pendingOutcome(deliveryId, "uncertain", existing.error || "The earlier delivery result is uncertain; do not resend automatically.");
  }
  if (existing.state !== "uncertain" && !options.recover) {
    return pendingOutcome(deliveryId, "in_progress", "The delivery is already reserved or sending; query its receipt before retrying.");
  }

  const claim = claimReceipt<TResult>({
    rootDir: options.rootDir,
    namespace: options.namespace,
    deliveryId,
    digest,
    executionId,
    leaseMs,
    allowUncertain: existing.state === "uncertain" && options.recoverExistingUncertain === true
  });
  if (!claim.claimed || !claim.receipt) {
    const current = claim.receipt;
    if (!current) return pendingOutcome(deliveryId, "uncertain", "The delivery receipt became unreadable while acquiring execution ownership.");
    if (current.requestDigest !== digest) return pendingOutcome(deliveryId, "conflict", "The deliveryId is already reserved for a different payload.");
    if (current.state === "completed" && current.result !== undefined) {
      return { state: "completed", deliveryId, duplicate: true, result: current.result };
    }
    if (current.state === "uncertain") {
      return pendingOutcome(deliveryId, "uncertain", current.error || "The earlier delivery result is uncertain; do not resend automatically.");
    }
    return pendingOutcome(deliveryId, "in_progress", "Another execution still owns this delivery; do not resend automatically.");
  }
  return executeClaimedDelivery({
    options,
    receipt: claim.receipt,
    digest,
    executionId,
    leaseMs,
    recoverFirst: true,
    recoveryError: new Error(existing.error || "The earlier delivery receipt requires authoritative recovery.")
  });
}
