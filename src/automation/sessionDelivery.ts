import type { AgentSessionDestination } from "../shared/agentDeliveryTarget.js";
import type { RabiDeliveryEnvelope } from "../shared/rabiMessage.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const inFlight = new Map<string, { target: string; promise: Promise<void> }>();

export function deliverSessionOnce(
  statePath: string, target: AgentSessionDestination, envelope: RabiDeliveryEnvelope, deliveryId: string,
  request: (payload: Record<string, unknown>) => Promise<Record<string, any>>,
  options: { remote?: boolean; imagePaths?: string[]; model?: string } = {}
): Promise<void> {
  const running = inFlight.get(statePath);
  const targetKey = JSON.stringify([deliveryId, target]);
  if (running) return running.target === targetKey ? running.promise : Promise.reject(new Error("Concurrent delivery target mismatch."));
  const run = async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const existing = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : undefined;
    if (existing && (existing.deliveryId !== deliveryId || JSON.stringify(existing.target) !== JSON.stringify(target))) {
      throw new Error("Original delivery target does not match; refusing to redirect the message.");
    }
    if (existing?.status === "delivered") return;
    const save = (status: string) => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ deliveryId, target, status }), { flag: "wx" });
      fs.renameSync(temporary, statePath);
    };
    if (existing?.status === "pending") {
      const readback = await request({ action: "read", agentAdapter: target.agentAdapter, threadId: target.sessionId,
        ...(options.remote ? {} : { agentTargetId: target.agentTargetId }), deliveryId });
      if (readback.threadId === target.sessionId && readback.delivery?.deliveryId === deliveryId && readback.delivery.state === "accepted") {
        save("delivered"); return;
      }
      throw new Error("Original delivery remains unconfirmed; no duplicate message was sent.");
    }
    const lockPath = `${statePath}.lock`;
    let lock: number;
    try { lock = fs.openSync(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another delivery owner holds this identity; reconcile the original receipt before retrying.");
      throw error;
    }
    try {
      // Another process could have completed while this process acquired the claim.
      const latest = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : undefined;
      if (latest?.status === "delivered") return;
      if (latest?.status === "pending") throw new Error("Original delivery remains unconfirmed; no duplicate message was sent.");
      save("pending");
      await sendAutomationSession(target, envelope, deliveryId, request, options);
      save("delivered");
    } catch (error) {
      if ((error as { response?: { error?: { commitState?: string } } }).response?.error?.commitState === "not_started") save("retryable");
      throw error;
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  };
  const promise = run().finally(() => inFlight.delete(statePath));
  inFlight.set(statePath, { target: targetKey, promise });
  return promise;
}

/** Both transports return the public Agent thread receipt, never mere HTTP acceptance. */
export async function sendAutomationSession(
  target: AgentSessionDestination,
  envelope: RabiDeliveryEnvelope,
  deliveryId: string,
  request: (payload: Record<string, unknown>) => Promise<Record<string, any>>,
  options: { remote?: boolean; imagePaths?: string[]; model?: string } = {}
): Promise<void> {
  const identity = { agentAdapter: target.agentAdapter, threadId: target.sessionId,
    ...(options.remote ? {} : { agentTargetId: target.agentTargetId }), deliveryId };
  const confirmed = (result: Record<string, any>) => result.delivery?.status === "delivered"
    && result.delivery.targetThreadId === target.sessionId && result.delivery.deliveryId === deliveryId;
  try {
    const result = await request({ ...identity, action: "send", cwd: target.workspace, createIfMissing: false,
      prompt: envelope.messageContent, messageSource: envelope.messageSource,
      contextBlocks: envelope.contextBlocks, controlBlocks: envelope.controlBlocks,
      imagePaths: options.imagePaths ?? [], model: options.model, responsePolicy: "none" });
    if (!confirmed(result)) throw new Error("Agent delivery has no confirmed receipt for the selected session.");
  } catch (error) {
    // A timeout may follow successful acceptance. Reconcile the same identity; never resend here.
    try {
      const result = await request({ ...identity, action: "reconcile_delivery" });
      if (confirmed(result) || (result.threadId === target.sessionId && result.ok === true
        && ["receipt_recovered", "already_recorded"].includes(result.status)
        && result.communication?.deliveryId === deliveryId)) return;
    } catch { /* Preserve the original error, including owner/transport failures. */ }
    throw error;
  }
}
