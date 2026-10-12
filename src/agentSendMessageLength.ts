import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "./agentSend.js";
import { resolveAgentSendRoute } from "./agentSendRoute.js";
import type { AgentReplyOptions } from "./outbox.js";
import { normalizeMessageAdapterPolicy } from "./shared/gatewayConfigModel.js";

const CONFIRMATION_LIFETIME_MS = 10 * 60 * 1000;

/** One Manager lifetime owns the confirmation signer. It never authorizes a target or creates an Outbox item. */
export class AgentSendMessageLengthGuard {
  private readonly secret = randomBytes(32);

  evaluate(request: AgentSendRequest, options: Pick<AgentReplyOptions, "runtimes">, now = Date.now()): {
    blocked: boolean; metadata?: NonNullable<AgentSendResult["messageLengthValidation"]>;
  } {
    const prepared = prepareAgentSendRequest(request);
    if (prepared.channel !== "napcat") return { blocked: false };
    const route = resolveAgentSendRoute(options.runtimes, prepared.routeId);
    if (!route) return { blocked: false }; // The existing delivery owner rejects unavailable/ambiguous routes.
    const policy = route.runtime.messageAdapterPolicies?.napcat;
    const threshold = normalizeMessageAdapterPolicy(policy, "napcat").textConfirmationThreshold;
    if (!threshold) return { blocked: false };
    const text = String(prepared.internal.text ?? "").replace(/\[CQ:[^\]]*\]/g, "").trim();
    const characterCount = Array.from(text).length;
    const metadata = { characterCount, threshold, confirmed: false };
    if (characterCount <= threshold) return { blocked: false, metadata };
    // Bind the full normalized send, not just its text: a confirmation cannot move to a different sender,
    // delivery ID, destination, attachment, or configured threshold. Style review remains independent.
    const fingerprint = JSON.stringify({ deliveryId: prepared.deliveryId, sender: prepared.sender,
      routeId: prepared.routeId, channel: prepared.channel, internal: prepared.internal, threshold });
    const signature = (expires: number) => createHmac("sha256", this.secret).update(`${expires}:${fingerprint}`).digest();
    const token = prepared.messageLengthConfirmation;
    if (token) {
      const [expires, hex] = token.split(".");
      const expiry = Number(expires);
      const supplied = Buffer.from(hex!, "hex");
      if (expiry > now && expiry <= now + CONFIRMATION_LIFETIME_MS && timingSafeEqual(supplied, signature(expiry))) {
        return { blocked: false, metadata: { ...metadata, confirmed: true } };
      }
    }
    const expiry = now + CONFIRMATION_LIFETIME_MS;
    return { blocked: true, metadata: { ...metadata,
      confirmationToken: `${expiry}.${signature(expiry).toString("hex")}`, expiresAt: new Date(expiry).toISOString() } };
  }
}
