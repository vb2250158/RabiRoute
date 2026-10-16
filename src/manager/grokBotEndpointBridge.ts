import { createHash } from "node:crypto";
import { GrokBotClient, GrokBotError, decodeGrokBotSessionId, encodeGrokBotSessionId, grokBotMessageId, grokBotProfilePath, isGrokBotRoom, verifyGrokBotRoomMember,
  type GrokBotClientOptions, type GrokBotNativeBot, type GrokBotNativeSession, type GrokBotSendReceipt, type GrokBotSendStatus } from "../agentAdapters/grokBotClient.js";
import type { AgentThreadRequest } from "../agentThreads.js";
import type { AgentRequestParty } from "../agentRequests/store.js";
import { sameAgentEndpoint, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { completeAgentSessionId, normalizeAgentThreadSourceType } from "../agentRequests/requestValidation.js";
import { agentIdentityForMessageSource, normalizeRabiMessageSource } from "../shared/rabiMessage.js";
import { normalizeEndpointExecutionOptions } from "../agentRequests/executionOptions.js";
import type { AgentServiceEndpointBridge, AgentServiceSourcePrincipal } from "./agentEndpointDelivery.js";

export type GrokBotEndpointConfiguration = GrokBotClientOptions;
export type GrokBotNativeOwner = { id: string; agentId: string; sessionId: string; defaultMain?: true; bot: GrokBotNativeBot; session: GrokBotNativeSession;
  accountScope: string; profileIdentity: string; authorizationIncarnation: string; client: GrokBotClient };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function profileIdentity(configuration: GrokBotEndpointConfiguration, client: GrokBotClient): string {
  return hash([grokBotProfilePath(configuration.profilePath), client.backendUrl]);
}

/** A native account, Bot roster and exact session establish ownership; request JSON supplies none of them. */
export async function readGrokBotNativeOwner(id: string, configuration: GrokBotEndpointConfiguration = {},
  client = new GrokBotClient(configuration)): Promise<GrokBotNativeOwner> {
  completeAgentSessionId(id, "threadId");
  const native = decodeGrokBotSessionId(id);
  const before = await client.profileStatus();
  if (!before.signedIn || !before.accountScope) throw new GrokBotError("GROK_BOT_NOT_SIGNED_IN");
  const roster = await client.listBots(before.accountScope);
  const aliasRoom = !native.defaultMain ? roster.bots.find(bot => bot.agentId === native.sessionId && isGrokBotRoom(bot)) : undefined;
  if (aliasRoom) verifyGrokBotRoomMember(roster, native.agentId, aliasRoom);
  const address = aliasRoom ? { agentId: aliasRoom.agentId, sessionId: "", defaultMain: true as const } : native;
  const bots = roster.bots.filter(bot => bot.agentId === address.agentId);
  if (bots.length !== 1) throw new GrokBotError(bots.length ? "GROK_BOT_DUPLICATE_OWNER_ID" : "GROK_BOT_SESSION_NOT_FOUND");
  const sessions = await client.listSessions(address.agentId, before.accountScope);
  if (sessions.some(session => session.agentId !== address.agentId)) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
  const matched = sessions.filter(session => session.sessionId === address.sessionId && session.defaultMain === address.defaultMain);
  if (matched.length !== 1) throw new GrokBotError(matched.length ? "GROK_BOT_DUPLICATE_OWNER_ID" : "GROK_BOT_SESSION_NOT_FOUND");
  const after = await client.profileStatus();
  if (after.accountScope !== before.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
  const nativeProfileBefore = (before as { profilePath?: string }).profilePath;
  const nativeProfileAfter = (after as { profilePath?: string }).profilePath;
  if (nativeProfileBefore !== nativeProfileAfter) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
  const profile = profileIdentity(configuration, client);
  return { ...address, id: encodeGrokBotSessionId(native.agentId, native.sessionId, native), bot: bots[0], session: matched[0],
    accountScope: before.accountScope, profileIdentity: profile,
    authorizationIncarnation: hash(["grokBot", profile, nativeProfileBefore ? hash(grokBotProfilePath(nativeProfileBefore)) : profile, before.accountScope]), client };
}

export function grokBotDeliveryMessageId(deliveryId: string, sessionId: string): string {
  return grokBotMessageId(deliveryId, sessionId);
}
function receipt(delivery: PreparedEndpointDelivery, action: string): EndpointDeliveryReceipt {
  return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: { ...delivery.target },
    promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true, action, transport: "native-cloud-owner-http" };
}
function validateNativeIdentity(value: GrokBotSendReceipt | GrokBotSendStatus, owner: GrokBotNativeOwner, messageId: string, required: boolean): void {
  const echoed = value as GrokBotSendStatus & Partial<GrokBotSendReceipt>;
  if ((required || echoed.agentId !== undefined) && echoed.agentId !== owner.agentId
    || (required || echoed.sessionId !== undefined) && echoed.sessionId !== owner.sessionId
    || (required || echoed.messageId !== undefined) && echoed.messageId !== messageId) {
    throw new GrokBotError("GROK_BOT_RECEIPT_OWNER_MISMATCH", { uncertain: true });
  }
}

/** Manager-owned service bridge; a cloud owner never acquires a local execution directory or Desktop identity. */
export function createGrokBotEndpointBridge(options: { managerInstanceId: string; configuration?: (canonicalSessionId?: string) => GrokBotEndpointConfiguration;
  client?: GrokBotClient }): AgentServiceEndpointBridge {
  const proofs = new Map<string, { owner: GrokBotNativeOwner; endpoint: AgentRequestEndpoint; checkedAt: number }>();
  const configuration = (canonicalSessionId?: string) => options.configuration?.(canonicalSessionId) ?? {};
  const clientFor = (value: GrokBotEndpointConfiguration) => options.client ?? new GrokBotClient(value);
  const owns = (endpoint: AgentRequestEndpoint) => endpoint.kind === "service" && endpoint.provider === "grokBot"
    && endpoint.managerInstanceId === options.managerInstanceId;
  const endpointFor = (owner: GrokBotNativeOwner): AgentRequestEndpoint => ({ kind: "service", provider: "grokBot",
    managerInstanceId: options.managerInstanceId, agentId: owner.agentId, sessionId: owner.id, authorizationIncarnation: owner.authorizationIncarnation });
  const readOwner = async (id: string) => {
    try {
      const config = { ...configuration(id) };
      const owner = await readGrokBotNativeOwner(id, config, clientFor(config));
      const endpoint = endpointFor(owner);
      proofs.set(id, { owner, endpoint, checkedAt: Date.now() });
      return owner;
    } catch (error) { proofs.delete(id); throw error; }
  };
  const authorize = (endpoint: AgentRequestEndpoint) => {
    const proof = proofs.get(endpoint.sessionId);
    const config = configuration(endpoint.sessionId);
    if (!owns(endpoint) || !proof || !sameAgentEndpoint(endpoint, proof.endpoint)
      || Date.now() - proof.checkedAt > 60_000 || profileIdentity(config, clientFor(config)) !== proof.owner.profileIdentity) {
      throw new GrokBotError("GROK_BOT_OWNER_PROOF_UNAVAILABLE");
    }
  };
  const refresh = async (endpoint: AgentRequestEndpoint) => {
    if (!owns(endpoint)) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
    const owner = await readOwner(endpoint.sessionId);
    if (!sameAgentEndpoint(endpointFor(owner), endpoint)) {
      proofs.delete(endpoint.sessionId);
      throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    }
  };
  const partyFor = (owner: GrokBotNativeOwner, agentType: string): AgentRequestParty => ({ endpoint: endpointFor(owner), agentAdapter: "grokBot",
    agentType, threadId: owner.id, threadName: owner.bot.name });
  return {
    owns, authorize, refresh,
    resolveSource: async (request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal) => {
      const identity = request.messageSource ? agentIdentityForMessageSource(normalizeRabiMessageSource(request.messageSource)) : undefined;
      if (identity?.agentAdapter !== "grokBot") return undefined;
      const id = completeAgentSessionId(request.sourceThreadId, "sourceThreadId");
      if (identity.sessionId !== id) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      const owner = await readOwner(id);
      if (principal && (principal.provider !== "grokBot" || principal.agentId !== owner.agentId || principal.sessionId !== owner.id
        || principal.authorizationIncarnation !== owner.authorizationIncarnation)) {
        throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      }
      return partyFor(owner, normalizeAgentThreadSourceType(request.sourceAgentType, true));
    },
    resolveTarget: async request => {
      if (request.agentAdapter !== "grokBot") return undefined;
      if (request.instanceBinding && request.instanceBinding.instanceId !== options.managerInstanceId) return undefined;
      const owner = await readOwner(completeAgentSessionId(request.threadId, "threadId"));
      const delivery = normalizeEndpointExecutionOptions(request.grokBotDelivery === undefined ? {} : { grokBotDelivery: request.grokBotDelivery }).grokBotDelivery;
      if (delivery && (delivery.deliveryType === "group") !== isGrokBotRoom(owner.bot)) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
      if (delivery?.sendMode === "identity" && isGrokBotRoom(owner.bot)) {
        verifyGrokBotRoomMember(await owner.client.listBots(owner.accountScope), delivery.senderAgentId!, owner.bot);
      }
      if (request.instanceBinding && request.instanceBinding.agentId !== owner.agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      if (request.agentTargetId && !["local:grokBot", "service:grokBot"].includes(request.agentTargetId)) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      return partyFor(owner, normalizeAgentThreadSourceType(request.messageProcessing?.targetAgentType));
    },
    resolveExecutionOptions: (request, target) => {
      if (request.cwd !== undefined || request.model !== undefined || request.reasoningEffort !== undefined || request.sandbox !== undefined || request.dshDeliveryMode !== undefined) {
        throw new GrokBotError("GROK_BOT_PC_EXECUTION_OPTIONS_UNSUPPORTED");
      }
      const execution = normalizeEndpointExecutionOptions(request.grokBotDelivery === undefined ? {} : { grokBotDelivery: request.grokBotDelivery });
      const owner = proofs.get(target.threadId)?.owner;
      if (!owner) throw new GrokBotError("GROK_BOT_OWNER_PROOF_UNAVAILABLE");
      const delivery = execution.grokBotDelivery;
      const native = decodeGrokBotSessionId(owner.id);
      const alias = native.agentId !== owner.agentId;
      if (alias && !delivery) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
      if (delivery && (delivery.deliveryType === "group") !== isGrokBotRoom(owner.bot)) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
      if (delivery?.sendMode === "identity" && alias && delivery.senderAgentId !== native.agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
      if (delivery?.sendMode === "identity" && isGrokBotRoom(owner.bot) && !owner.bot.memberAgentIds?.includes(delivery.senderAgentId!)) {
        throw new GrokBotError("GROK_BOT_SENDER_NOT_MEMBER");
      }
      return execution;
    },
    transport: async (delivery, guard, reconcile) => {
      await refresh(delivery.target);
      guard();
      authorize(delivery.target);
      const owner = proofs.get(delivery.target.sessionId)!.owner;
      const nativeDelivery = normalizeEndpointExecutionOptions(delivery.executionOptions).grokBotDelivery;
      if (nativeDelivery && (nativeDelivery.deliveryType === "group") !== isGrokBotRoom(owner.bot)) throw new GrokBotError("GROK_BOT_TARGET_KIND_MISMATCH");
      if (nativeDelivery?.sendMode === "identity" && isGrokBotRoom(owner.bot)) {
        verifyGrokBotRoomMember(await owner.client.listBots(owner.accountScope), nativeDelivery.senderAgentId!, owner.bot);
      }
      const messageId = grokBotDeliveryMessageId(delivery.deliveryId, delivery.target.sessionId);
      if (reconcile) {
        const status = await owner.client.getSendStatus(owner.agentId, owner.sessionId, messageId, owner.accountScope,
          owner.defaultMain ? { defaultMain: true } : undefined);
        await refresh(delivery.target); guard();
        validateNativeIdentity(status, owner, messageId, false);
        if (status.status === "accepted") return receipt(delivery, "receipt_recovered");
        if (status.status === "rejected") throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
        return undefined;
      }
      const accepted = await owner.client.sendNative({ agentId: owner.agentId, sessionId: owner.sessionId,
        ...(owner.defaultMain ? { defaultMain: true as const } : {}),
        ...(delivery.executionOptions.grokBotDelivery ? { deliveryType: delivery.executionOptions.grokBotDelivery.deliveryType,
          ...(delivery.executionOptions.grokBotDelivery.sendMode === "identity" ? { fromAgentId: delivery.executionOptions.grokBotDelivery.senderAgentId } : {}) } : {}),
        messageId, text: delivery.prompt }, owner.accountScope);
      await refresh(delivery.target); guard();
      validateNativeIdentity(accepted, owner, messageId, true);
      if (!accepted.accepted) throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
      return receipt(delivery, accepted.recovered ? "receipt_recovered" : accepted.duplicate ? "duplicate_accepted" : "accepted");
    }
  };
}
