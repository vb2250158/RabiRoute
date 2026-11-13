import { validateAgentDeliveryTarget, type AgentSessionDestination, type AgentDsBotDestination } from "../shared/agentDeliveryTarget.js";
import type { RabiDeliveryEnvelope } from "../shared/rabiMessage.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const inFlight = new Map<string, { target: string; promise: Promise<void> }>();

export function deliverSessionOnce(
  statePath: string, target: AgentSessionDestination | AgentDsBotDestination, envelope: RabiDeliveryEnvelope, deliveryId: string,
  request: (payload: Record<string, unknown>) => Promise<Record<string, any>>,
  options: { remote?: boolean; imagePaths?: string[]; model?: string } = {}
): Promise<void> {
  const running = inFlight.get(statePath);
  const messageHash = target.kind === "ds_bot" ? createHash("sha256").update(envelope.messageContent).digest("hex") : undefined;
  const targetKey = JSON.stringify([deliveryId, target, ...(messageHash ? [messageHash] : [])]);
  if (running) return running.target === targetKey ? running.promise : Promise.reject(new Error("Concurrent delivery target mismatch."));
  const run = async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const existing = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : undefined;
    if (existing && (existing.deliveryId !== deliveryId || JSON.stringify(existing.target) !== JSON.stringify(target) || messageHash !== undefined && existing.messageHash !== messageHash)) {
      throw new Error("Original delivery target does not match; refusing to redirect the message.");
    }
    if (existing?.status === "delivered") return;
    const save = (status: string) => {
      const id = createHash("sha256").update(path.resolve(statePath)).digest("hex");
      const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
        group: "agent-delivery", event: "session_delivery_state", owner: "session-delivery", action: "save", outcome,
        target: { type: "delivery", id }, dataSource: { kind: "file", id }, result: status
      });
      audit("started");
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ deliveryId, target, status, ...(messageHash ? { messageHash } : {}) }), { flag: "wx" });
        fs.renameSync(temporary, statePath);
        audit("committed");
      } catch (error) {
        audit("failed");
        throw error;
      }
    };
    if (existing?.status === "pending") {
      if (target.kind === "ds_bot") {
        const readback = await request(dsBotRequest(target, envelope, deliveryId, "ds_bot_reconcile", options.remote));
        if (acceptedDsBot(readback, target, deliveryId)) { save("delivered"); return; }
        throw new Error("Original DSBot delivery remains unconfirmed; no duplicate message was sent.");
      }
      const readback = await request({ action: target.deliveryType ? "reconcile_delivery" : "read", agentAdapter: target.agentAdapter, threadId: target.sessionId,
        ...(target.deliveryType ? { grokBotDelivery: { deliveryType: target.deliveryType, sendMode: target.sendMode,
          ...(target.sendMode === "identity" ? { senderAgentId: target.senderAgentId } : {}) } } : {}),
        ...(options.remote ? {} : { agentTargetId: target.agentTargetId }), deliveryId });
      if (readback.threadId === target.sessionId && readback.delivery?.deliveryId === deliveryId
        && (readback.delivery.state === "accepted" || readback.delivery.status === "delivered")) {
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
  target: AgentSessionDestination | AgentDsBotDestination,
  envelope: RabiDeliveryEnvelope,
  deliveryId: string,
  request: (payload: Record<string, unknown>) => Promise<Record<string, any>>,
  options: { remote?: boolean; imagePaths?: string[]; model?: string } = {}
): Promise<void> {
  if (target.kind === "ds_bot") {
    validateAgentDeliveryTarget(target);
    if (options.imagePaths?.length || options.model) throw new Error("DSBot automation cannot apply ordinary Session attachment paths or model options.");
    try {
      const result = await request(dsBotRequest(target, envelope, deliveryId, "ds_bot_deliver", options.remote));
      if (!acceptedDsBot(result, target, deliveryId)) throw new Error("DSBot delivery has no confirmed native admission receipt.");
    } catch (error) {
      try {
        const readback = await request(dsBotRequest(target, envelope, deliveryId, "ds_bot_reconcile", options.remote));
        if (acceptedDsBot(readback, target, deliveryId)) return;
      } catch { /* Preserve the original unknown result; no send replay occurs. */ }
      throw error;
    }
    return;
  }
  const identity = { agentAdapter: target.agentAdapter, threadId: target.sessionId,
    ...(options.remote ? {} : { agentTargetId: target.agentTargetId }), deliveryId,
    ...(target.agentAdapter === "grokBot" && target.deliveryType ? { grokBotDelivery: {
      deliveryType: target.deliveryType, sendMode: target.sendMode,
      ...(target.sendMode === "identity" ? { senderAgentId: target.senderAgentId } : {})
    } } : {}) };
  const confirmed = (result: Record<string, any>) => result.delivery?.status === "delivered"
    && result.delivery.targetThreadId === target.sessionId && result.delivery.deliveryId === deliveryId;
  try {
    const result = await request({ ...identity, action: "send", ...(target.agentAdapter === "grokBot" ? {} : { cwd: target.workspace }), createIfMissing: false,
      prompt: envelope.messageContent, messageSource: envelope.messageSource,
      contextBlocks: envelope.contextBlocks, controlBlocks: envelope.controlBlocks,
      imagePaths: options.imagePaths ?? [], ...(target.agentAdapter === "grokBot" ? {} : { model: options.model }), responsePolicy: "none" });
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

function dsBotRequest(target: AgentDsBotDestination, envelope: RabiDeliveryEnvelope, deliveryId: string,
  action: "ds_bot_deliver" | "ds_bot_reconcile", remote = false): Record<string, unknown> {
  return { action, agentAdapter: "dsh", ...(remote ? {} : { agentTargetId: target.agentTargetId }),
    dsBot: { botScopeId: target.botScopeId, botId: target.botId }, ...(remote ? {} : { dshBaseUrl: target.dshBaseUrl }), deliveryId, prompt: envelope.messageContent };
}
function acceptedDsBot(result: Record<string, any>, target: AgentDsBotDestination, deliveryId: string): boolean {
  const receipt = result.dsBot;
  return receipt?.schemaVersion === 1 && receipt.state === "accepted" && receipt.botScopeId === target.botScopeId
    && receipt.botId === target.botId && receipt.deliveryId === deliveryId && receipt.requestId === deliveryId
    && typeof receipt.sessionId === "string" && Boolean(receipt.sessionId);
}
