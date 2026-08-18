import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";

export type DurableDeliveryReceiptState = "reserved" | "sending" | "completed" | "uncertain";

export type DurableDeliveryReceipt<TResult> = {
  version: 1;
  deliveryId: string;
  requestDigest: string;
  state: DurableDeliveryReceiptState;
  createdAt: string;
  updatedAt: string;
  result?: TResult;
  error?: string;
};

export type DurableDeliveryOutcome<TResult> =
  | { state: "completed"; deliveryId: string; duplicate: boolean; result: TResult }
  | { state: "in_progress" | "uncertain" | "conflict"; deliveryId: string; duplicate: boolean; reason: string };

export type DurableDeliveryOptions<TResult> = {
  rootDir: string;
  namespace: string;
  deliveryId: unknown;
  payload: unknown;
  deliver: () => Promise<TResult>;
  recover?: (error: unknown) => Promise<
    | { state: "completed"; result: TResult }
    | { state: "retry" }
    | { state: "in_progress" | "uncertain"; reason: string }
  >;
  waitForCompletionMs?: number;
};

const RECEIPT_VERSION = 1;
const DEFAULT_WAIT_MS = 5_000;

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
  return parseReceipt<TResult>(durableDeliveryReceiptPath(rootDir, namespace, deliveryId));
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
  digest: string
): { created: boolean; receipt: DurableDeliveryReceipt<TResult> | null } {
  const filePath = durableDeliveryReceiptPath(rootDir, namespace, deliveryId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = new Date().toISOString();
  const receipt: DurableDeliveryReceipt<TResult> = {
    version: RECEIPT_VERSION,
    deliveryId,
    requestDigest: digest,
    state: "reserved",
    createdAt: now,
    updatedAt: now
  };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    return { created: true, receipt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { created: false, receipt: parseReceipt<TResult>(filePath) };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
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

export async function executeDurableDelivery<TResult>(
  options: DurableDeliveryOptions<TResult>
): Promise<DurableDeliveryOutcome<TResult>> {
  const deliveryId = normalizeDurableDeliveryId(options.deliveryId);
  const digest = requestDigest(options.payload);
  const reservation = reserveReceipt<TResult>(options.rootDir, options.namespace, deliveryId, digest);
  if (!reservation.created) {
    const existing = reservation.receipt;
    if (!existing) return pendingOutcome(deliveryId, "uncertain", "The delivery receipt is unreadable; do not resend automatically.");
    if (existing.requestDigest !== digest) return pendingOutcome(deliveryId, "conflict", "The deliveryId is already reserved for a different payload.");
    if (existing.state === "completed" && existing.result !== undefined) {
      return { state: "completed", deliveryId, duplicate: true, result: existing.result };
    }
    if (existing.state === "uncertain") {
      return pendingOutcome(deliveryId, "uncertain", existing.error || "The earlier delivery result is uncertain; do not resend automatically.");
    }
    const settled = await waitForTerminal<TResult>(
      options.rootDir,
      options.namespace,
      deliveryId,
      options.waitForCompletionMs ?? DEFAULT_WAIT_MS
    );
    if (settled?.state === "completed" && settled.result !== undefined) {
      return { state: "completed", deliveryId, duplicate: true, result: settled.result };
    }
    if (settled?.state === "uncertain") {
      return pendingOutcome(deliveryId, "uncertain", settled.error || "The earlier delivery result is uncertain; do not resend automatically.");
    }
    if (options.recover) {
      const recovery = await options.recover(new Error("Desktop request timed out while the earlier delivery receipt remained sending."));
      if (recovery.state === "completed") {
        const completed = { ...(settled || existing), state: "completed" as const, updatedAt: new Date().toISOString(), result: recovery.result };
        writeReceipt(options.rootDir, options.namespace, completed);
        return { state: "completed", deliveryId, duplicate: true, result: recovery.result };
      }
      if (recovery.state === "retry") {
        try {
          const result = await options.deliver();
          const completed = { ...(settled || existing), state: "completed" as const, updatedAt: new Date().toISOString(), result };
          writeReceipt(options.rootDir, options.namespace, completed);
          return { state: "completed", deliveryId, duplicate: false, result };
        } catch (retryError) {
          const reason = retryError instanceof Error ? retryError.message : String(retryError);
          writeReceipt(options.rootDir, options.namespace, {
            ...(settled || existing),
            state: "uncertain",
            updatedAt: new Date().toISOString(),
            error: reason
          });
          return pendingOutcome(deliveryId, "uncertain", `${reason} The one authorized recovery retry did not produce a terminal receipt; do not resend automatically.`, false);
        }
      }
      if (recovery.state === "in_progress") {
        return pendingOutcome(deliveryId, "in_progress", recovery.reason);
      }
      if (recovery.state === "uncertain") {
        writeReceipt(options.rootDir, options.namespace, { ...(settled || existing), state: "uncertain", updatedAt: new Date().toISOString(), error: recovery.reason });
        return pendingOutcome(deliveryId, "uncertain", recovery.reason);
      }
    }
    return pendingOutcome(deliveryId, "in_progress", "The delivery is already reserved or sending; query its receipt before retrying.");
  }

  const reserved = reservation.receipt as DurableDeliveryReceipt<TResult>;
  writeReceipt(options.rootDir, options.namespace, { ...reserved, state: "sending", updatedAt: new Date().toISOString() });
  try {
    const result = await options.deliver();
    writeReceipt(options.rootDir, options.namespace, {
      ...reserved,
      state: "completed",
      updatedAt: new Date().toISOString(),
      result
    });
    return { state: "completed", deliveryId, duplicate: false, result };
  } catch (error) {
    if (options.recover) {
      const recovery = await options.recover(error);
      if (recovery.state === "completed") {
        writeReceipt(options.rootDir, options.namespace, { ...reserved, state: "completed", updatedAt: new Date().toISOString(), result: recovery.result });
        return { state: "completed", deliveryId, duplicate: false, result: recovery.result };
      }
      if (recovery.state === "retry") {
        try {
          const result = await options.deliver();
          writeReceipt(options.rootDir, options.namespace, { ...reserved, state: "completed", updatedAt: new Date().toISOString(), result });
          return { state: "completed", deliveryId, duplicate: false, result };
        } catch (retryError) {
          error = retryError;
        }
      } else if (recovery.state === "in_progress") {
        return pendingOutcome(deliveryId, "in_progress", recovery.reason, false);
      } else {
        writeReceipt(options.rootDir, options.namespace, { ...reserved, state: "uncertain", updatedAt: new Date().toISOString(), error: recovery.reason });
        return pendingOutcome(deliveryId, "uncertain", recovery.reason, false);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    writeReceipt(options.rootDir, options.namespace, {
      ...reserved,
      state: "uncertain",
      updatedAt: new Date().toISOString(),
      error: message
    });
    return pendingOutcome(deliveryId, "uncertain", `${message} The send result is uncertain; do not resend automatically.`, false);
  }
}
