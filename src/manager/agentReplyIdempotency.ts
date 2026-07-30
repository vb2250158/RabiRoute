import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import type { AgentReplyRequest, AgentReplyResult } from "../outbox.js";

type AgentReplyReceiptState = "reserved" | "sending" | "completed" | "uncertain";

export type AgentReplyReceipt = {
  version: 1;
  deliveryId: string;
  requestDigest: string;
  state: AgentReplyReceiptState;
  createdAt: string;
  updatedAt: string;
  result?: AgentReplyResult;
  error?: string;
};

export type AgentReplyIdempotencyInfo = {
  deliveryId: string;
  state: "completed" | "in_progress" | "uncertain" | "conflict";
  duplicate: boolean;
};

export type IdempotentAgentReplyBody = AgentReplyResult & {
  idempotency: AgentReplyIdempotencyInfo;
};

export type IdempotentAgentReplyResponse = {
  statusCode: number;
  body: IdempotentAgentReplyBody;
};

type ExecuteOptions = {
  rootDir: string;
  deliver: () => Promise<AgentReplyResult>;
  waitForCompletionMs?: number;
};

const RECEIPT_VERSION = 1;
const DEFAULT_WAIT_MS = 5_000;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestDigest(request: AgentReplyRequest): string {
  const { deliveryId: _deliveryId, ...payload } = request;
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

function normalizedDeliveryId(value: unknown): string {
  const deliveryId = String(value || "").trim();
  if (!deliveryId) throw new Error("Missing deliveryId for idempotent Agent reply.");
  if (deliveryId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(deliveryId)) {
    throw new Error("Invalid deliveryId for idempotent Agent reply.");
  }
  return deliveryId;
}

function receiptDirectory(rootDir: string): string {
  return path.join(path.resolve(rootDir), "data", "agent-reply-idempotency");
}

export function agentReplyReceiptPath(rootDir: string, deliveryId: string): string {
  const normalized = normalizedDeliveryId(deliveryId);
  const fileName = `${createHash("sha256").update(normalized, "utf8").digest("hex")}.json`;
  return path.join(receiptDirectory(rootDir), fileName);
}

function parseReceipt(filePath: string): AgentReplyReceipt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AgentReplyReceipt>;
    if (
      parsed.version !== RECEIPT_VERSION
      || !parsed.deliveryId
      || !parsed.requestDigest
      || !["reserved", "sending", "completed", "uncertain"].includes(String(parsed.state))
    ) return null;
    return parsed as AgentReplyReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export function readAgentReplyReceipt(rootDir: string, deliveryId: string): AgentReplyReceipt | null {
  return parseReceipt(agentReplyReceiptPath(rootDir, deliveryId));
}

function writeReceipt(rootDir: string, receipt: AgentReplyReceipt): AgentReplyReceipt {
  atomicWriteFileSync(agentReplyReceiptPath(rootDir, receipt.deliveryId), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function reserveReceipt(rootDir: string, deliveryId: string, digest: string): { created: boolean; receipt: AgentReplyReceipt | null } {
  const filePath = agentReplyReceiptPath(rootDir, deliveryId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = new Date().toISOString();
  const receipt: AgentReplyReceipt = {
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
    return { created: false, receipt: parseReceipt(filePath) };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function statusCodeFor(result: AgentReplyResult): number {
  if (result.status === "sent") return 202;
  if (result.status === "draft") return 200;
  if (result.status === "failed") return 502;
  return 403;
}

function completedResponse(receipt: AgentReplyReceipt, duplicate: boolean): IdempotentAgentReplyResponse {
  const result = receipt.result ?? { ok: false, status: "failed", reason: "Completed idempotency receipt has no result." };
  return {
    statusCode: statusCodeFor(result),
    body: {
      ...result,
      idempotency: { deliveryId: receipt.deliveryId, state: "completed", duplicate }
    }
  };
}

function nonTerminalResponse(
  deliveryId: string,
  state: "in_progress" | "uncertain" | "conflict",
  reason: string,
  statusCode: number
): IdempotentAgentReplyResponse {
  return {
    statusCode,
    body: {
      ok: false,
      status: "failed",
      reason,
      idempotency: { deliveryId, state, duplicate: true }
    }
  };
}

async function waitForTerminal(rootDir: string, deliveryId: string, timeoutMs: number): Promise<AgentReplyReceipt | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const receipt = readAgentReplyReceipt(rootDir, deliveryId);
    if (!receipt || receipt.state === "completed" || receipt.state === "uncertain") return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readAgentReplyReceipt(rootDir, deliveryId);
}

export async function executeIdempotentAgentReply(
  request: AgentReplyRequest,
  options: ExecuteOptions
): Promise<IdempotentAgentReplyResponse> {
  const deliveryId = normalizedDeliveryId(request.deliveryId);
  const digest = requestDigest(request);
  const reservation = reserveReceipt(options.rootDir, deliveryId, digest);
  if (!reservation.created) {
    const existing = reservation.receipt;
    if (!existing) {
      return nonTerminalResponse(deliveryId, "uncertain", "The idempotency receipt is unreadable; do not resend automatically.", 409);
    }
    if (existing.requestDigest !== digest) {
      return nonTerminalResponse(deliveryId, "conflict", "The deliveryId is already reserved for a different reply payload.", 409);
    }
    if (existing.state === "completed") return completedResponse(existing, true);
    if (existing.state === "uncertain") {
      return nonTerminalResponse(deliveryId, "uncertain", existing.error || "The earlier reply result is uncertain; do not resend automatically.", 409);
    }
    const settled = await waitForTerminal(options.rootDir, deliveryId, options.waitForCompletionMs ?? DEFAULT_WAIT_MS);
    if (settled?.state === "completed") return completedResponse(settled, true);
    if (settled?.state === "uncertain") {
      return nonTerminalResponse(deliveryId, "uncertain", settled.error || "The earlier reply result is uncertain; do not resend automatically.", 409);
    }
    return nonTerminalResponse(deliveryId, "in_progress", "The reply is already reserved or sending; query its receipt before retrying.", 409);
  }

  const reserved = reservation.receipt as AgentReplyReceipt;
  writeReceipt(options.rootDir, { ...reserved, state: "sending", updatedAt: new Date().toISOString() });
  try {
    const result = await options.deliver();
    const completed = writeReceipt(options.rootDir, {
      ...reserved,
      state: "completed",
      updatedAt: new Date().toISOString(),
      result
    });
    return completedResponse(completed, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeReceipt(options.rootDir, {
      ...reserved,
      state: "uncertain",
      updatedAt: new Date().toISOString(),
      error: message
    });
    return nonTerminalResponse(deliveryId, "uncertain", `${message} The send result is uncertain; do not resend automatically.`, 503);
  }
}

export function agentReplyReceiptResponse(rootDir: string, deliveryId: string): IdempotentAgentReplyResponse {
  const normalized = normalizedDeliveryId(deliveryId);
  const receipt = readAgentReplyReceipt(rootDir, normalized);
  if (!receipt) return nonTerminalResponse(normalized, "uncertain", "No idempotency receipt exists for this deliveryId.", 404);
  if (receipt.state === "completed") return completedResponse(receipt, true);
  if (receipt.state === "uncertain") {
    return nonTerminalResponse(normalized, "uncertain", receipt.error || "The reply result is uncertain; do not resend automatically.", 409);
  }
  return nonTerminalResponse(normalized, "in_progress", "The reply is reserved or sending; query again before any retry.", 202);
}
