import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type ServerOptions, type WebSocket } from "ws";
import { buildReply } from "../commands.js";
import { config, setBotProfile, type NapCatInstanceConfig } from "../config.js";
import { forwardMessage, recordMessageContextOnly, type ForwardRouteKind } from "../forwarding.js";
import { appendAdapterLog, appendAdapterLogToDir, appendGroupMessage, appendPrivateMessage, readGroupMessages, type GroupMessageRecord, type PrivateMessageRecord } from "../history.js";
import { getLoginInfo, getStatus, sendGroupMessage, sendPrivateMessage, type NapCatEndpoint } from "../napcat.js";
import { enrichNapCatMessage } from "../napcatForwardMessages.js";
import { materializeNapCatAttachments } from "../napcatMedia.js";
import { resolveNapCatReplyChain } from "../napcatReplyMessages.js";
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";

type OneBotEvent = {
  post_type?: string;
  message_type?: string;
  group_id?: number;
  user_id?: number;
  time?: number;
  message_id?: number | string;
  raw_message?: string;
  message?: unknown;
  self_id?: number;
  sender?: {
    nickname?: string;
    card?: string;
  };
};

type OneBotMessageSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

type GroupRoute = {
  kind: Extract<ForwardRouteKind, "direct_at" | "direct_reply" | "indirect_reply">;
};

type GatewayStatus = {
  messageAdapter?: {
    type?: "napcat";
    status?: "running" | "disabled" | "error";
    message?: string;
    updatedAt?: string;
  };
  messageAdapters?: Record<string, {
    type?: "napcat";
    status?: "running" | "disabled" | "error";
    message?: string;
    updatedAt?: string;
  }>;
  napcat?: {
    connected?: boolean;
    activeConnections?: number;
    connectionCount?: number;
    messageCount?: number;
    remoteAddress?: string;
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    lastMessageAt?: string;
    botUserId?: string;
    botNickname?: string;
    online?: boolean;
    good?: boolean;
    lastLoginInfoAt?: string;
    loginInfoError?: string;
    loginInfoErrorAt?: string;
  };
  napcatInstances?: Record<string, NonNullable<GatewayStatus["napcat"]> & {
    id?: string;
    name?: string;
    gatewayPort?: number;
    httpUrl?: string;
    webuiUrl?: string;
  }>;
};

function gatewayStatusPath(dataDir: string): string {
  return path.join(dataDir, "gateway-status.json");
}

function readGatewayStatus(dataDir = config.dataDir): GatewayStatus {
  const statusPath = gatewayStatusPath(dataDir);
  if (!fs.existsSync(statusPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
  } catch {
    return {};
  }
}

function writeGatewayStatus(nextStatus: GatewayStatus, dataDir = config.dataDir): void {
  const statusPath = gatewayStatusPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), "utf8");
}

function configuredNapcatInstanceIds(instances = config.napcatInstances): Set<string> {
  return new Set(instances.map((instance) => instance.id));
}

function pruneNapcatInstanceStatus(
  statuses: GatewayStatus["napcatInstances"] | undefined,
  configuredInstances = config.napcatInstances
): GatewayStatus["napcatInstances"] | undefined {
  if (!statuses) {
    return undefined;
  }

  const configuredIds = configuredNapcatInstanceIds(configuredInstances);
  const kept = Object.fromEntries(
    Object.entries(statuses).filter(([id]) => configuredIds.has(id))
  ) as NonNullable<GatewayStatus["napcatInstances"]>;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function patchNapcatStatus(
  patch: NonNullable<GatewayStatus["napcat"]>,
  dataDir = config.dataDir,
  configuredInstances = config.napcatInstances
): void {
  const status = readGatewayStatus(dataDir);
  writeGatewayStatus({
    ...status,
    napcatInstances: pruneNapcatInstanceStatus(status.napcatInstances, configuredInstances),
    napcat: {
      ...status.napcat,
      ...patch
    }
  }, dataDir);
}

function patchNapcatInstanceStatus(
  instance: NapCatInstanceConfig,
  patch: NonNullable<GatewayStatus["napcat"]>,
  dataDir = config.dataDir,
  configuredInstances = config.napcatInstances
): void {
  const status = readGatewayStatus(dataDir);
  const current = status.napcatInstances?.[instance.id] ?? {};
  const next = {
    ...current,
    ...patch,
    id: instance.id,
    name: instance.name,
    gatewayPort: instance.gatewayPort,
    httpUrl: instance.httpUrl,
    webuiUrl: instance.webuiUrl
  };
  writeGatewayStatus({
    ...status,
    napcat: instance.id === "default" ? { ...status.napcat, ...patch } : status.napcat,
    napcatInstances: {
      ...pruneNapcatInstanceStatus(status.napcatInstances, configuredInstances),
      [instance.id]: next
    }
  }, dataDir);
}

function patchMessageAdapterStatus(
  patch: NonNullable<GatewayStatus["messageAdapter"]>,
  dataDir = config.dataDir,
  now = new Date()
): void {
  const status = readGatewayStatus(dataDir);
  const next = {
    ...status.messageAdapters?.napcat,
    ...status.messageAdapter,
    ...patch,
    updatedAt: now.toISOString()
  };
  writeGatewayStatus({
    ...status,
    messageAdapter: next,
    messageAdapters: {
      ...status.messageAdapters,
      napcat: next
    }
  }, dataDir);
}

function textFromEvent(event: OneBotEvent): string {
  if (typeof event.raw_message === "string") {
    return event.raw_message;
  }

  if (typeof event.message === "string") {
    return event.message;
  }

  return "";
}

function messageSegments(event: OneBotEvent): OneBotMessageSegment[] {
  return Array.isArray(event.message) ? event.message as OneBotMessageSegment[] : [];
}

function segmentValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function hasStructuredAtSelf(event: OneBotEvent): boolean {
  const segments = messageSegments(event);
  if (segments.length === 0) {
    return false;
  }

  return segments.some((segment) => {
    if (segment.type !== "at") {
      return false;
    }

    const qq = segmentValue(segment.data?.qq);
    return !event.self_id || qq === String(event.self_id) || qq === "all";
  });
}

function hasReplySegment(event: OneBotEvent): boolean {
  return messageSegments(event).some((segment) => segment.type === "reply") || textFromEvent(event).includes("[回复消息]");
}

function replyMessageId(event: OneBotEvent): string | null {
  const replySegment = messageSegments(event).find((segment) => segment.type === "reply");
  const structuredId = segmentValue(replySegment?.data?.id);
  if (structuredId) {
    return structuredId;
  }

  const match = textFromEvent(event).match(/\[CQ:reply,id=([^\],]+)[^\]]*\]/);
  return match?.[1] ?? null;
}

function contentMentionsBot(content: string, selfId?: number): boolean {
  if (selfId && content.includes(`[CQ:at,qq=${selfId}]`)) {
    return true;
  }

  if (content.includes(`@${config.botNickname}`)) {
    return true;
  }

  return !selfId && content.includes("[CQ:at,");
}

function findRepliedGroupMessage(event: OneBotEvent): GroupMessageRecord | null {
  if (!event.group_id) {
    return null;
  }

  const id = replyMessageId(event);
  if (!id) {
    return null;
  }

  return readGroupMessages()
    .slice()
    .reverse()
    .find((message) => message.groupId === event.group_id && String(message.messageId) === id) ?? null;
}

function endpointFor(instance: NapCatInstanceConfig): NapCatEndpoint {
  return {
    httpUrl: instance.httpUrl,
    accessToken: instance.accessToken
  };
}

async function resolveReplyChain(
  event: OneBotEvent,
  instance: NapCatInstanceConfig,
  rawMessage: string,
  sourceMessageType: "group" | "private"
): Promise<void> {
  const botNickname = readGatewayStatus().napcatInstances?.[instance.id]?.botNickname;
  const result = await resolveNapCatReplyChain({
    rawMessage,
    message: event.message,
    currentMessageId: event.message_id,
    sourceMessageType,
    sourceGroupId: event.group_id,
    sourceUserId: event.user_id,
    selfId: event.self_id,
    botNickname,
    instanceId: instance.id,
    endpoint: endpointFor(instance)
  });

  if (result.resolvedMessageIds.length > 0) {
    appendAdapterLog("napcat", {
      event: "reply_chain_resolved",
      instanceId: instance.id,
      message: `Resolved ${result.resolvedMessageIds.length} missing replied message(s) through OneBot get_msg`,
      data: {
        currentMessageId: event.message_id,
        resolvedMessageIds: result.resolvedMessageIds
      }
    });
  }
  for (const error of result.errors) {
    appendAdapterLog("napcat", {
      level: "warning",
      event: "reply_chain_resolve_error",
      instanceId: instance.id,
      message: error.message,
      data: {
        currentMessageId: event.message_id,
        repliedMessageId: error.messageId
      }
    });
  }
}

function eventSummary(event: OneBotEvent): Record<string, unknown> {
  return {
    postType: event.post_type,
    messageType: event.message_type,
    groupId: event.group_id,
    userId: event.user_id,
    selfId: event.self_id,
    messageId: event.message_id,
    senderName: event.sender?.card || event.sender?.nickname,
    text: textFromEvent(event),
    raw: event
  };
}

async function refreshBotProfile(instance = config.napcatInstances[0]): Promise<void> {
  try {
    let botStatus: { online?: boolean; good?: boolean } = {};
    try {
      botStatus = await getStatus(endpointFor(instance));
    } catch {
      botStatus = {};
    }
    const loginInfo = await getLoginInfo(endpointFor(instance));
    if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
      setBotProfile(loginInfo);
    }
    const offline = botStatus.online === false || botStatus.good === false;
    const patch = {
      botUserId: loginInfo.userId != null ? String(loginInfo.userId) : config.botUserId,
      botNickname: loginInfo.nickname ?? config.botNickname,
      online: botStatus.online,
      good: botStatus.good,
      lastLoginInfoAt: new Date().toISOString(),
      loginInfoError: offline ? "OneBot get_status 显示 QQ 已离线" : "",
      loginInfoErrorAt: offline ? new Date().toISOString() : ""
    };
    patchNapcatInstanceStatus(instance, patch);
    if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
      patchNapcatStatus(patch);
    }
    appendAdapterLog("napcat", {
      event: "login_info",
      instanceId: instance.id,
      message: `${loginInfo.nickname ?? config.botNickname}${loginInfo.userId ? ` (${loginInfo.userId})` : ""}`,
      data: {
        name: instance.name,
        httpUrl: instance.httpUrl,
        userId: loginInfo.userId,
        nickname: loginInfo.nickname
      }
    });
    console.log(`[${instance.name}] Bot profile: ${loginInfo.nickname ?? config.botNickname}${loginInfo.userId ? ` (${loginInfo.userId})` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const patch = {
      botNickname: config.botNickname,
      loginInfoError: message,
      loginInfoErrorAt: new Date().toISOString()
    };
    patchNapcatInstanceStatus(instance, patch);
    if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
      patchNapcatStatus(patch);
    }
    appendAdapterLog("napcat", {
      level: "error",
      event: "login_info_error",
      instanceId: instance.id,
      message,
      data: {
        name: instance.name,
        httpUrl: instance.httpUrl
      }
    });
    console.warn(`[${instance.name}] Failed to refresh bot profile: ${message}`);
  }
}

function getGroupRoute(event: OneBotEvent): GroupRoute | null {
  const content = textFromEvent(event);
  const mentionsBotByText = contentMentionsBot(content, event.self_id);
  const mentionsBotBySegment = hasStructuredAtSelf(event);
  const isReply = hasReplySegment(event);
  const repliedMessage = isReply ? findRepliedGroupMessage(event) : null;

  if (isReply && (mentionsBotBySegment || mentionsBotByText)) {
    return { kind: "direct_reply" };
  }

  if (isReply && repliedMessage && contentMentionsBot(repliedMessage.rawMessage, event.self_id)) {
    return { kind: "indirect_reply" };
  }

  if (isReply && repliedMessage?.routeKind) {
    return { kind: "indirect_reply" };
  }

  if (mentionsBotBySegment || mentionsBotByText) {
    return { kind: "direct_at" };
  }

  return null;
}

function isSelfMessage(event: OneBotEvent): boolean {
  return Boolean(event.self_id && event.user_id === event.self_id);
}

async function handleGroupMessage(event: OneBotEvent, instance: NapCatInstanceConfig): Promise<void> {
  if (!event.group_id || !event.user_id) {
    return;
  }
  const selfMessage = isSelfMessage(event);

  const enriched = await enrichNapCatMessage(event.message, textFromEvent(event), endpointFor(instance));
  const attachments = await materializeNapCatAttachments(event.message, textFromEvent(event), {
    dataDir: config.memoryDataDir,
    instanceId: instance.id,
    messageId: event.message_id ?? `${event.time ?? Math.floor(Date.now() / 1000)}-${event.user_id}`
  });
  for (const attachment of attachments.filter((item) => item.status === "unavailable")) {
    appendAdapterLog("napcat", {
      level: "warning",
      event: "message_attachment_unavailable",
      instanceId: instance.id,
      message: attachment.error || "NapCat image could not be materialized.",
      data: { messageId: event.message_id, attachmentId: attachment.id, kind: attachment.kind }
    });
  }
  for (const error of enriched.errors) {
    appendAdapterLog("napcat", {
      level: "warning",
      event: "forward_message_resolve_error",
      instanceId: instance.id,
      message: error.message,
      data: { forwardId: error.forwardId, messageId: event.message_id }
    });
  }
  if (enriched.forwardedMessages?.length) {
    appendAdapterLog("napcat", {
      event: "forward_message_resolved",
      instanceId: instance.id,
      message: `Resolved ${enriched.forwardedMessages.length} forwarded message bundle(s)`,
      data: {
        messageId: event.message_id,
        forwardIds: enriched.forwardedMessages.map((item) => item.forwardId),
        nodeCount: enriched.forwardedMessages.reduce((sum, item) => sum + item.nodes.length, 0)
      }
    });
  }

  const record: GroupMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    groupId: event.group_id,
    userId: event.user_id,
    rawMessage: enriched.rawMessage,
    originalRawMessage: enriched.originalRawMessage,
    forwardedMessages: enriched.forwardedMessages,
    messageId: event.message_id,
    senderName: selfMessage
      ? readGatewayStatus().napcatInstances?.[instance.id]?.botNickname || event.sender?.card || event.sender?.nickname
      : event.sender?.card || event.sender?.nickname,
    repliedMessageId: replyMessageId(event) ?? undefined,
    instanceId: instance.id,
    adapterType: "napcat",
    botUserId: event.self_id != null ? String(event.self_id) : undefined,
    botNickname: readGatewayStatus().napcatInstances?.[instance.id]?.botNickname,
    isSelf: selfMessage,
    attachments: attachments.length ? attachments : undefined,
    segments: messageSegments(event)
  };

  if (selfMessage) {
    appendGroupMessage(record);
    recordMessageContextOnly("group_message", record);
    return;
  }
  await resolveReplyChain(event, instance, record.rawMessage, "group");
  const route = getGroupRoute(event);
  if (route) {
    record.routeKind = route.kind;
  }
  appendGroupMessage(record);
  if (route) {
    const repliedMessage = findRepliedGroupMessage(event);
    forwardMessage(route.kind, record, {
      selfId: event.self_id,
      repliedMessageId: record.repliedMessageId,
      repliedMessage: repliedMessage?.rawMessage
    });
  } else {
    forwardMessage("group_message", record, {
      selfId: event.self_id
    });
  }

  const reply = buildReply(record);
  if (!reply) {
    return;
  }

  const sent = await sendGroupMessage({
    groupId: record.groupId,
    message: reply
  }, endpointFor(instance));
  recordMessageContextOnly("group_message", {
    time: Math.floor(Date.now() / 1000),
    groupId: record.groupId,
    userId: event.self_id ?? record.userId,
    rawMessage: reply,
    messageId: sent.messageId,
    senderName: record.botNickname || config.botNickname,
    instanceId: instance.id,
    adapterType: "napcat",
    botUserId: event.self_id != null ? String(event.self_id) : undefined,
    botNickname: record.botNickname,
    isSelf: true
  }, { appendRoleRecord: false });
}

async function handlePrivateMessage(event: OneBotEvent, instance: NapCatInstanceConfig): Promise<void> {
  if (!event.user_id) {
    return;
  }
  const selfMessage = isSelfMessage(event);

  const enriched = await enrichNapCatMessage(event.message, textFromEvent(event), endpointFor(instance));
  const attachments = await materializeNapCatAttachments(event.message, textFromEvent(event), {
    dataDir: config.memoryDataDir,
    instanceId: instance.id,
    messageId: event.message_id ?? `${event.time ?? Math.floor(Date.now() / 1000)}-${event.user_id}`
  });
  for (const attachment of attachments.filter((item) => item.status === "unavailable")) {
    appendAdapterLog("napcat", {
      level: "warning",
      event: "message_attachment_unavailable",
      instanceId: instance.id,
      message: attachment.error || "NapCat image could not be materialized.",
      data: { messageId: event.message_id, attachmentId: attachment.id, kind: attachment.kind }
    });
  }
  for (const error of enriched.errors) {
    appendAdapterLog("napcat", {
      level: "warning",
      event: "forward_message_resolve_error",
      instanceId: instance.id,
      message: error.message,
      data: { forwardId: error.forwardId, messageId: event.message_id }
    });
  }
  if (enriched.forwardedMessages?.length) {
    appendAdapterLog("napcat", {
      event: "forward_message_resolved",
      instanceId: instance.id,
      message: `Resolved ${enriched.forwardedMessages.length} forwarded message bundle(s)`,
      data: {
        messageId: event.message_id,
        forwardIds: enriched.forwardedMessages.map((item) => item.forwardId),
        nodeCount: enriched.forwardedMessages.reduce((sum, item) => sum + item.nodes.length, 0)
      }
    });
  }

  const record: PrivateMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    userId: event.user_id,
    rawMessage: enriched.rawMessage,
    originalRawMessage: enriched.originalRawMessage,
    forwardedMessages: enriched.forwardedMessages,
    messageId: event.message_id,
    senderName: selfMessage
      ? readGatewayStatus().napcatInstances?.[instance.id]?.botNickname || event.sender?.nickname
      : event.sender?.nickname,
    instanceId: instance.id,
    adapterType: "napcat",
    botUserId: event.self_id != null ? String(event.self_id) : undefined,
    botNickname: readGatewayStatus().napcatInstances?.[instance.id]?.botNickname,
    isSelf: selfMessage,
    attachments: attachments.length ? attachments : undefined,
    segments: messageSegments(event)
  };

  if (selfMessage) {
    appendPrivateMessage(record);
    recordMessageContextOnly("private", record);
    return;
  }
  await resolveReplyChain(event, instance, record.rawMessage, "private");
  appendPrivateMessage(record);
  forwardMessage("private", record);

  const content = record.rawMessage.trim();
  if (content === "/ping" || content === "ping") {
    const reply = `${config.botNickname} 私聊在线`;
    const sent = await sendPrivateMessage({
      userId: record.userId,
      message: reply
    }, endpointFor(instance));
    recordMessageContextOnly("private", {
      time: Math.floor(Date.now() / 1000),
      userId: record.userId,
      rawMessage: reply,
      messageId: sent.messageId,
      senderName: record.botNickname || config.botNickname,
      instanceId: instance.id,
      adapterType: "napcat",
      botUserId: event.self_id != null ? String(event.self_id) : undefined,
      botNickname: record.botNickname,
      isSelf: true
    }, { appendRoleRecord: false });
  }
}

export type NapCatAdapterDependencies = {
  instances?: () => NapCatInstanceConfig[];
  dataDir?: () => string;
  now?: () => Date;
  createServer?: (options: ServerOptions) => WebSocketServer;
  refreshProfile?: (instance: NapCatInstanceConfig) => void | Promise<void>;
};

type NapCatLifecycle = {
  active: boolean;
  configuredInstances: NapCatInstanceConfig[];
  instances: NapCatInstanceConfig[];
  servers: Array<{ instance: NapCatInstanceConfig; server: WebSocketServer }>;
  dataDir(): string;
  now(): Date;
  createServer(options: ServerOptions): WebSocketServer;
  refreshProfile(instance: NapCatInstanceConfig): void | Promise<void>;
};

function appendNapCatRuntimeLog(
  lifecycle: Pick<NapCatLifecycle, "dataDir">,
  record: Parameters<typeof appendAdapterLogToDir>[1]
): void {
  appendAdapterLogToDir("napcat", record, lifecycle.dataDir());
}

function isPrimaryNapCatInstance(
  instance: NapCatInstanceConfig,
  configuredInstances: NapCatInstanceConfig[]
): boolean {
  return instance.id === "default" || configuredInstances[0]?.id === instance.id;
}

function waitForNapCatListening(server: WebSocketServer): Promise<void> {
  if (server.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function closeNapCatServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function setupNapCatServer(
  lifecycle: NapCatLifecycle,
  instance: NapCatInstanceConfig,
  server: WebSocketServer
): void {
  const activeSockets = new Set<WebSocket>();
  server.on("connection", (socket, request) => {
    if (!lifecycle.active) {
      socket.terminate();
      return;
    }
    activeSockets.add(socket);
    console.log(`[${instance.name}] NapCat connected from ${request.socket.remoteAddress}`);
    const connectedAt = lifecycle.now().toISOString();
    const currentStatus = readGatewayStatus(lifecycle.dataDir()).napcatInstances?.[instance.id]
      ?? readGatewayStatus(lifecycle.dataDir()).napcat;
    const patch = {
      connected: true,
      activeConnections: activeSockets.size,
      remoteAddress: request.socket.remoteAddress,
      lastConnectedAt: connectedAt,
      connectionCount: (currentStatus?.connectionCount ?? 0) + 1
    };
    patchNapcatInstanceStatus(instance, patch, lifecycle.dataDir(), lifecycle.configuredInstances);
    if (isPrimaryNapCatInstance(instance, lifecycle.configuredInstances)) {
      patchNapcatStatus(patch, lifecycle.dataDir(), lifecycle.configuredInstances);
    }
    appendNapCatRuntimeLog(lifecycle, {
      event: "ws_connected",
      instanceId: instance.id,
      message: `${instance.name} WebSocket connected`,
      data: {
        name: instance.name,
        gatewayPort: instance.gatewayPort,
        remoteAddress: request.socket.remoteAddress,
        activeConnections: activeSockets.size
      }
    });
    void lifecycle.refreshProfile(instance);

    socket.on("close", () => {
      activeSockets.delete(socket);
      if (!lifecycle.active) return;
      const disconnectedPatch = {
        connected: activeSockets.size > 0,
        activeConnections: activeSockets.size,
        lastDisconnectedAt: lifecycle.now().toISOString()
      };
      patchNapcatInstanceStatus(
        instance,
        disconnectedPatch,
        lifecycle.dataDir(),
        lifecycle.configuredInstances
      );
      if (isPrimaryNapCatInstance(instance, lifecycle.configuredInstances)) {
        patchNapcatStatus(disconnectedPatch, lifecycle.dataDir(), lifecycle.configuredInstances);
      }
      appendNapCatRuntimeLog(lifecycle, {
        event: "ws_disconnected",
        instanceId: instance.id,
        message: `${instance.name} WebSocket disconnected`,
        data: {
          name: instance.name,
          gatewayPort: instance.gatewayPort,
          activeConnections: activeSockets.size
        }
      });
      console.log(`[${instance.name}] NapCat disconnected`);
    });

    socket.on("message", async (data) => {
      if (!lifecycle.active) return;
      try {
        const event = JSON.parse(data.toString()) as OneBotEvent;
        const currentMessageStatus = readGatewayStatus(lifecycle.dataDir()).napcatInstances?.[instance.id]
          ?? readGatewayStatus(lifecycle.dataDir()).napcat;
        const messagePatch = {
          lastMessageAt: lifecycle.now().toISOString(),
          messageCount: (currentMessageStatus?.messageCount ?? 0) + 1
        };
        patchNapcatInstanceStatus(
          instance,
          messagePatch,
          lifecycle.dataDir(),
          lifecycle.configuredInstances
        );
        if (isPrimaryNapCatInstance(instance, lifecycle.configuredInstances)) {
          patchNapcatStatus(messagePatch, lifecycle.dataDir(), lifecycle.configuredInstances);
        }
        appendNapCatRuntimeLog(lifecycle, {
          event: "inbound_event",
          instanceId: instance.id,
          message: textFromEvent(event).slice(0, 500),
          data: {
            name: instance.name,
            ...eventSummary(event)
          }
        });
        if (event.post_type === "message" && event.message_type === "group") {
          await handleGroupMessage(event, instance);
        }
        if (event.post_type === "message" && event.message_type === "private") {
          await handlePrivateMessage(event, instance);
        }
      } catch (error) {
        appendNapCatRuntimeLog(lifecycle, {
          level: "error",
          event: "inbound_error",
          instanceId: instance.id,
          message: error instanceof Error ? error.message : String(error),
          data: {
            name: instance.name,
            raw: data.toString().slice(0, 4000)
          }
        });
        console.error(`[${instance.name}] Failed to handle event`, error);
      }
    });
  });
}

export function createNapCatAdapter(
  dependencies: NapCatAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "napcat",
    async start() {
      const configuredInstances = dependencies.instances?.() ?? config.napcatInstances;
      const instances = configuredInstances.filter((instance) => instance.enabled);
      const lifecycle: NapCatLifecycle = {
        active: true,
        configuredInstances,
        instances,
        servers: [],
        dataDir: dependencies.dataDir ?? (() => config.dataDir),
        now: dependencies.now ?? (() => new Date()),
        createServer: dependencies.createServer ?? ((options) => new WebSocketServer(options)),
        refreshProfile: dependencies.refreshProfile ?? refreshBotProfile
      };
      const status = readGatewayStatus(lifecycle.dataDir());
      writeGatewayStatus({
        ...status,
        napcatInstances: pruneNapcatInstanceStatus(status.napcatInstances, configuredInstances)
      }, lifecycle.dataDir());

      const dispose: MessageAdapterDispose = async () => {
        if (!lifecycle.active) return;
        lifecycle.active = false;
        for (const item of [...lifecycle.servers].reverse()) {
          await closeNapCatServer(item.server);
          const patch = {
            connected: false,
            activeConnections: 0,
            lastDisconnectedAt: lifecycle.now().toISOString()
          };
          patchNapcatInstanceStatus(
            item.instance,
            patch,
            lifecycle.dataDir(),
            lifecycle.configuredInstances
          );
          if (isPrimaryNapCatInstance(item.instance, lifecycle.configuredInstances)) {
            patchNapcatStatus(patch, lifecycle.dataDir(), lifecycle.configuredInstances);
          }
        }
        patchMessageAdapterStatus({
          type: "napcat",
          status: "disabled",
          message: "NapCat / OneBot 消息适配端已停止。"
        }, lifecycle.dataDir(), lifecycle.now());
        appendNapCatRuntimeLog(lifecycle, {
          event: "disabled",
          message: `NapCat adapter disabled, instances=${lifecycle.servers.length}`,
          data: { instanceCount: lifecycle.servers.length }
        });
      };

      if (instances.length === 0) {
        lifecycle.active = false;
        patchMessageAdapterStatus({
          type: "napcat",
          status: "disabled",
          message: "NapCat / OneBot 没有启用的实例。"
        }, lifecycle.dataDir(), lifecycle.now());
        return () => {};
      }

      try {
        for (const instance of instances) {
          const server = lifecycle.createServer({
            host: "127.0.0.1",
            port: instance.gatewayPort
          });
          lifecycle.servers.push({ instance, server });
          setupNapCatServer(lifecycle, instance, server);
          await waitForNapCatListening(server);
          server.on("error", (error) => {
            if (!lifecycle.active) return;
            const message = `${instance.name} WebSocket listener failed: ${error.message}`;
            patchMessageAdapterStatus({
              type: "napcat",
              status: "error",
              message
            }, lifecycle.dataDir(), lifecycle.now());
            appendNapCatRuntimeLog(lifecycle, {
              event: "listener_error",
              level: "error",
              instanceId: instance.id,
              message
            });
          });
          appendNapCatRuntimeLog(lifecycle, {
            event: "listening",
            instanceId: instance.id,
            message: `${instance.name} listening on ws://127.0.0.1:${instance.gatewayPort}`,
            data: {
              name: instance.name,
              gatewayPort: instance.gatewayPort,
              wsUrl: `ws://127.0.0.1:${instance.gatewayPort}`,
              httpUrl: instance.httpUrl,
              webuiUrl: instance.webuiUrl
            }
          });
          console.log(`[${instance.name}] RabiRoute NapCat adapter listening on ws://127.0.0.1:${instance.gatewayPort}`);
          console.log(`[${instance.name}] NapCat HTTP API: ${instance.httpUrl}`);
          console.log("Target group: controlled by notification rules");
          patchNapcatInstanceStatus(instance, {
            connected: false,
            activeConnections: 0,
            loginInfoError: ""
          }, lifecycle.dataDir(), lifecycle.configuredInstances);
          void lifecycle.refreshProfile(instance);
        }
        patchMessageAdapterStatus({
          type: "napcat",
          status: "running",
          message: `NapCat / OneBot 消息适配端已启动：${instances.length} 个实例。`
        }, lifecycle.dataDir(), lifecycle.now());
        return dispose;
      } catch (error) {
        lifecycle.active = false;
        for (const item of [...lifecycle.servers].reverse()) {
          await closeNapCatServer(item.server);
          const patch = {
            connected: false,
            activeConnections: 0,
            lastDisconnectedAt: lifecycle.now().toISOString()
          };
          patchNapcatInstanceStatus(
            item.instance,
            patch,
            lifecycle.dataDir(),
            lifecycle.configuredInstances
          );
          if (isPrimaryNapCatInstance(item.instance, lifecycle.configuredInstances)) {
            patchNapcatStatus(patch, lifecycle.dataDir(), lifecycle.configuredInstances);
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        patchMessageAdapterStatus({
          type: "napcat",
          status: "error",
          message: `NapCat / OneBot 消息适配端启动失败：${message}`
        }, lifecycle.dataDir(), lifecycle.now());
        appendNapCatRuntimeLog(lifecycle, {
          event: "activation_failed",
          level: "error",
          message,
          data: { instanceCount: lifecycle.servers.length }
        });
        throw error;
      }
    }
  };
}
