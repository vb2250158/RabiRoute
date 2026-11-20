import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentSendRequestTemplateForSource } from "../agentSendTemplate.js";
import type { NativeOwnerDelivery } from "../agentRequests/nativeOwnerDelivery.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import type { PlanBindingSourceInstance } from "../shared/planBindingOwner.js";
import type { AgentThreadRemoteSource } from "../agentThreads.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { agentDeliveryPromptHash } from "../agentRequests/state.js";
import { deliveryIdFromPrompt, withoutLegacyTransportSuffix } from "../shared/deliveryIdentity.js";

type ChatChannel = "napcat" | "qqbot" | "weixin" | "wecom" | "feishu";
export type OriginalChat = {
  gatewayId: string;
  routeId: string;
  roleId: string;
  channel: ChatChannel;
  account: string;
  conversationId: string;
  senderId: string;
  messageId: string;
  params: Record<string, string>;
};

export function assertOriginalChatRoute(chat: OriginalChat, current: {
  gatewayId: string; routeId: string; roleId: string; account: string;
} | undefined): void {
  if (!current || current.gatewayId !== chat.gatewayId || current.routeId !== chat.routeId || current.roleId !== chat.roleId) {
    throw new Error("原消息路线已变更。");
  }
  if (current.account !== chat.account) throw new Error("原消息端账号当前不可用或已切换。");
}

type NativeSession = { agentType: string; sessionId: string; instance?: AgentInstanceBinding };
type NativeTurn = { agentType?: string; sessionId: string; turnId?: string; sourceInstance?: PlanBindingSourceInstance;
  trustedRemoteSource?: AgentThreadRemoteSource; peerEndpoint?: AgentRequestEndpoint };
type ChatAdmission = { chat: OriginalChat; target: NativeSession; nonce: string };
type TurnAdmission = { callerDeliveryId: string; receiptId: string; turnKey: string };
type PeerAdmission = { sourceDeviceId: string; receiptId: string; generation: string; promptHash: string; endpoint: AgentRequestEndpoint };
export type PeerOriginalChatCompletion = {
  receiptId: string; generation: string; promptHash: string; turnId: string; message: string; cwd?: string;
};

function value(input: unknown): string {
  return typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
}

/** The context and endpoint identity are taken from the Gateway's accepted inbound record. */
export function originalChatFromIngress(context: Record<string, unknown>, accountHint: unknown): OriginalChat | undefined {
  const request = agentSendRequestTemplateForSource({ ...context, replyToSource: false });
  const channel = request?.channel;
  if (channel !== "napcat" && channel !== "qqbot" && channel !== "weixin" && channel !== "wecom" && channel !== "feishu") return;
  const raw = request?.params as Record<string, unknown>;
  const params = Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, value(item)]).filter(([, item]) => item));
  const gatewayId = value(context.gatewayId);
  const routeId = value(request?.routeId);
  const roleId = value(context.roleId);
  const messageId = value(context.messageId);
  const senderId = value(context.wecomSenderId ?? context.weixinUserId ?? context.userId);
  const account = value(channel === "napcat" ? context.botUserId : channel === "qqbot" ? context.instanceId : accountHint);
  if (!gatewayId || !routeId || !roleId || !messageId || !senderId || !account) return;
  if (channel === "napcat" && !params.instanceId) return;
  if (channel === "qqbot" && !params.sourceMessageId?.startsWith("qqbot-")) return;
  const conversationId = params.groupId || params.chatId || params.sessionId
    || (channel === "qqbot" ? value(context.qqbotDmGuildId ?? context.qqbotChannelId ?? context.groupId ?? context.userId) : params.userId);
  if (!conversationId) return;
  return { gatewayId, routeId, roleId, channel, account, conversationId, senderId, messageId, params };
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function turnKey(turn: NativeTurn): string | undefined {
  if (!turn.sessionId?.trim() || !turn.turnId?.trim()) return;
  const owner = turn.peerEndpoint ?? (turn.sourceInstance ? turn.trustedRemoteSource : "local");
  if (!owner || typeof owner !== "string" && !owner.authorizationIncarnation) return;
  const identity = typeof owner === "string" ? ["local"] : "kind" in owner
    ? ["peer", owner.managerInstanceId, owner.ownerDeviceId, owner.instanceId, owner.nodeId, owner.agentId, owner.authorizationIncarnation]
    : ["lan", owner.nodeId, owner.agentId ?? turn.sourceInstance?.agentId, owner.authorizationIncarnation];
  return digest(JSON.stringify([identity, turn.agentType || "codex", turn.sessionId, turn.turnId]));
}

function endpointMatchesTurn(endpoint: AgentRequestEndpoint, turn: NativeTurn): boolean {
  if (endpoint.provider !== (turn.agentType || "codex") || endpoint.sessionId !== turn.sessionId) return false;
  if (turn.peerEndpoint) {
    const peer = turn.peerEndpoint;
    return endpoint.kind === "instance" && Boolean(endpoint.ownerDeviceId) && endpoint.ownerDeviceId === peer.ownerDeviceId
      && endpoint.instanceId === peer.instanceId && endpoint.agentId === peer.agentId
      && endpoint.authorizationIncarnation === peer.authorizationIncarnation;
  }
  if (!turn.sourceInstance) return endpoint.kind === "local";
  const source = turn.trustedRemoteSource;
  return endpoint.kind === "instance" && !endpoint.ownerDeviceId && !!source
    && source.provider === endpoint.provider && source.sessionId === endpoint.sessionId
    && source.nodeId === endpoint.nodeId && source.nodeId === endpoint.instanceId && source.nodeId === turn.sourceInstance.instanceId
    && source.authorizationIncarnation === endpoint.authorizationIncarnation;
}

function endpointMatchesAdmission(endpoint: AgentRequestEndpoint, target: NativeSession): boolean {
  return endpoint.provider === target.agentType && endpoint.sessionId === target.sessionId
    && (target.instance ? endpoint.kind === "instance" && target.instance.instanceId === endpoint.instanceId
      && target.instance.agentId === endpoint.agentId && target.instance.ownerDeviceId === endpoint.ownerDeviceId : endpoint.kind === "local");
}

function read<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Publish a complete record and leave the original intact under concurrent input or replay. */
function writeOnce<T>(file: string, entry: T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(entry), { flag: "wx" });
  try {
    fs.linkSync(temporary, file);
    return entry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return read<T>(file)!;
  } finally {
    fs.unlinkSync(temporary);
  }
}

function admissionPath(root: string, callerId: string): string {
  return path.join(root, "deliveries", digest(callerId) + ".json");
}

function controlBlock(nonce: string): string {
  return "[原聊天回传凭据]\n" + nonce;
}

export function registerOriginalChat(root: string, callerId: string, chat: OriginalChat | undefined, target: NativeSession, replay = false): string | undefined {
  const file = admissionPath(root, callerId);
  const original = read<ChatAdmission>(file) ?? (!replay && chat ? writeOnce<ChatAdmission>(file, { chat, target, nonce: randomUUID() }) : undefined);
  if (!original) return;
  if (JSON.stringify(original.target) !== JSON.stringify(target) || !replay && chat && JSON.stringify(original.chat) !== JSON.stringify(chat)) {
    throw new Error("Original chat delivery identity changed.");
  }
  return controlBlock(original.nonce);
}

export function savePeerOriginalChatAdmission(root: string, sourceDeviceId: string, delivery: NativeOwnerDelivery): void {
  if (!delivery.prompt.includes("[原聊天回传凭据]\n")) return;
  const admission = { sourceDeviceId, receiptId: delivery.deliveryId, generation: delivery.generation,
    promptHash: delivery.promptHash, endpoint: delivery.target };
  const original = writeOnce(path.join(root, "peer-admissions", digest(delivery.deliveryId) + ".json"), admission);
  if (JSON.stringify(original) !== JSON.stringify(admission)) throw new Error("Original peer delivery changed.");
}

function bindPeerOwnerTurn(root: string, turn: NativeTurn, receiptId: string, promptHash: string): void {
  if (turn.sourceInstance || turn.peerEndpoint) return;
  const admission = read<PeerAdmission>(path.join(root, "peer-admissions", digest(receiptId) + ".json"));
  if (!admission || admission.promptHash !== promptHash || admission.endpoint.sessionId !== turn.sessionId
    || admission.endpoint.provider !== (turn.agentType || "codex")) return;
  const key = turnKey(turn)!;
  const claim = writeOnce(path.join(root, "peer-claims", digest(receiptId) + ".json"), { key });
  if (claim.key === key) writeOnce(path.join(root, "peer-turns", key + ".json"), admission);
}

export function originalChatPeerCompletion(root: string, turn: NativeTurn & { lastAssistantMessage?: string; cwd?: string }):
  { deviceId: string; proof: PeerOriginalChatCompletion } | undefined {
  if (turn.sourceInstance || turn.peerEndpoint || !turn.lastAssistantMessage?.trim()) return;
  const key = turnKey(turn);
  if (!key) return;
  const admission = read<PeerAdmission>(path.join(root, "peer-turns", key + ".json"));
  if (!admission) return;
  return { deviceId: admission.sourceDeviceId, proof: { receiptId: admission.receiptId, generation: admission.generation,
    promptHash: admission.promptHash, turnId: turn.turnId!, message: turn.lastAssistantMessage, cwd: turn.cwd } };
}

export async function bindPeerOriginalChatCompletion(root: string, deviceId: string, proof: PeerOriginalChatCompletion,
  readDelivery: (id: string) => Promise<PreparedEndpointDelivery | undefined>):
  Promise<{ turn: NativeTurn; chat: OriginalChat } | undefined> {
  const receipt = await readDelivery(proof.receiptId);
  const endpoint = receipt?.target;
  if (!receipt || !endpoint || endpoint.kind !== "instance" || endpoint.ownerDeviceId !== deviceId
    || receipt.generation !== proof.generation || receipt.promptHash !== proof.promptHash || !receipt.callerDeliveryId) return;
  const turn = { agentType: endpoint.provider, sessionId: endpoint.sessionId, turnId: proof.turnId, peerEndpoint: endpoint,
    sourceInstance: { instanceId: endpoint.instanceId!, ownerDeviceId: endpoint.ownerDeviceId, agentId: endpoint.agentId } };
  const admission = read<ChatAdmission>(admissionPath(root, receipt.callerDeliveryId));
  if (!admission) return;
  await bindOriginalChatTurn(root, { ...turn, prompt: receipt.prompt }, async () => receipt);
  const chat = readOriginalChat(root, turn, admission.chat.roleId);
  if (chat?.receiptId === receipt.deliveryId) return { turn, chat };
}

export async function bindOriginalChatTurn(root: string, turn: NativeTurn & { prompt?: string },
  readDelivery: (id: string) => Promise<PreparedEndpointDelivery | undefined>): Promise<void> {
  const key = turnKey(turn);
  // Avoid a durable delivery read for ordinary desktop prompts.
  if (!key || !turn.prompt?.includes("[原聊天回传凭据]\n")) return;
  const receiptId = deliveryIdFromPrompt(turn.prompt);
  if (!receiptId) return;
  const nativePrompt = withoutLegacyTransportSuffix(turn.prompt) ?? turn.prompt;
  const promptHash = agentDeliveryPromptHash(nativePrompt);
  bindPeerOwnerTurn(root, turn, receiptId, promptHash);
  const receipt = await readDelivery(receiptId);
  if (!receipt?.callerDeliveryId || receipt.deliveryId !== receiptId
    || (receipt.state !== "dispatching" && receipt.state !== "committed")
    || !endpointMatchesTurn(receipt.target, turn)) return;
  if (promptHash !== receipt.promptHash) return;

  const callerDeliveryId = receipt.callerDeliveryId;
  const admission = read<ChatAdmission>(admissionPath(root, callerDeliveryId));
  if (!admission || !endpointMatchesAdmission(receipt.target, admission.target)
    || !nativePrompt.replace(/\r\n/g, "\n").includes("\n\n" + controlBlock(admission.nonce) + "\n\n")) return;

  const binding = { callerDeliveryId, receiptId, turnKey: key };
  const original = writeOnce<TurnAdmission>(path.join(root, "claims", digest(callerDeliveryId) + ".json"), binding);
  // Repeating a submitted envelope in a later turn cannot attach it again.
  if (original.turnKey === key && original.receiptId === receiptId) {
    writeOnce(path.join(root, "turns", key + ".json"), binding);
  }
}

export function readOriginalChat(root: string, turn: NativeTurn, roleId: string): (OriginalChat & { receiptId: string }) | undefined {
  const key = turnKey(turn);
  if (!key) return;
  const binding = read<TurnAdmission>(path.join(root, "turns", key + ".json"));
  if (!binding || binding.turnKey !== key) return;
  const admission = read<ChatAdmission>(admissionPath(root, binding.callerDeliveryId));
  if (admission?.chat.roleId !== roleId) return;
  return { ...admission.chat, receiptId: binding.receiptId };
}
