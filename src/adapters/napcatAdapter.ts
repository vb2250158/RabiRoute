import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { buildReply } from "../commands.js";
import { config, setBotProfile, type NapCatInstanceConfig } from "../config.js";
import { forwardMessage, type ForwardRouteKind } from "../forwarding.js";
import { appendAdapterLog, appendGroupMessage, appendPrivateMessage, readGroupMessages, type GroupMessageRecord, type PrivateMessageRecord } from "../history.js";
import { getLoginInfo, getStatus, sendGroupMessage, sendPrivateMessage, type NapCatEndpoint } from "../napcat.js";
import type { MessageAdapter } from "./messageAdapter.js";

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
    status?: "running" | "error";
    message?: string;
    updatedAt?: string;
  };
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

const statusPath = path.join(config.dataDir, "gateway-status.json");
const loginRefreshIntervalSeconds = Number(process.env.NAPCAT_LOGIN_REFRESH_SECONDS ?? "60");

function readGatewayStatus(): GatewayStatus {
  if (!fs.existsSync(statusPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
  } catch {
    return {};
  }
}

function writeGatewayStatus(nextStatus: GatewayStatus): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), "utf8");
}

function patchNapcatStatus(patch: NonNullable<GatewayStatus["napcat"]>): void {
  const status = readGatewayStatus();
  writeGatewayStatus({
    ...status,
    napcat: {
      ...status.napcat,
      ...patch
    }
  });
}

function patchNapcatInstanceStatus(instance: NapCatInstanceConfig, patch: NonNullable<GatewayStatus["napcat"]>): void {
  const status = readGatewayStatus();
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
      ...status.napcatInstances,
      [instance.id]: next
    }
  });
}

function patchMessageAdapterStatus(patch: NonNullable<GatewayStatus["messageAdapter"]>): void {
  const status = readGatewayStatus();
  writeGatewayStatus({
    ...status,
    messageAdapter: {
      ...status.messageAdapter,
      ...patch,
      updatedAt: new Date().toISOString()
    }
  });
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
  if (isSelfMessage(event)) {
    return;
  }

  const record: GroupMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    groupId: event.group_id,
    userId: event.user_id,
    rawMessage: textFromEvent(event),
    messageId: event.message_id,
    senderName: event.sender?.card || event.sender?.nickname,
    repliedMessageId: replyMessageId(event) ?? undefined,
    instanceId: instance.id,
    adapterType: "napcat",
    botUserId: event.self_id != null ? String(event.self_id) : undefined,
    botNickname: readGatewayStatus().napcatInstances?.[instance.id]?.botNickname
  };

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

  await sendGroupMessage({
    groupId: record.groupId,
    message: reply
  }, endpointFor(instance));
}

async function handlePrivateMessage(event: OneBotEvent, instance: NapCatInstanceConfig): Promise<void> {
  if (!event.user_id) {
    return;
  }
  if (isSelfMessage(event)) {
    return;
  }

  const record: PrivateMessageRecord = {
    time: event.time ?? Math.floor(Date.now() / 1000),
    userId: event.user_id,
    rawMessage: textFromEvent(event),
    messageId: event.message_id,
    senderName: event.sender?.nickname,
    instanceId: instance.id,
    adapterType: "napcat",
    botUserId: event.self_id != null ? String(event.self_id) : undefined,
    botNickname: readGatewayStatus().napcatInstances?.[instance.id]?.botNickname
  };

  appendPrivateMessage(record);
  forwardMessage("private", record);

  const content = record.rawMessage.trim();
  if (content === "/ping" || content === "ping") {
    await sendPrivateMessage({
      userId: record.userId,
      message: `${config.botNickname} 私聊在线`
    }, endpointFor(instance));
  }
}

export function createNapCatAdapter(): MessageAdapter {
  return {
    type: "napcat",
    start() {
      const instances = config.napcatInstances.filter((instance) => instance.enabled);
      for (const instance of instances) {
        const activeSockets = new Set<object>();
        const server = new WebSocketServer({
          host: "127.0.0.1",
          port: instance.gatewayPort
        });

      server.on("connection", (socket, request) => {
        activeSockets.add(socket);
        console.log(`[${instance.name}] NapCat connected from ${request.socket.remoteAddress}`);
        const connectedAt = new Date().toISOString();
        const currentStatus = readGatewayStatus().napcatInstances?.[instance.id] ?? readGatewayStatus().napcat;
        const patch = {
          connected: true,
          activeConnections: activeSockets.size,
          remoteAddress: request.socket.remoteAddress,
          lastConnectedAt: connectedAt,
          connectionCount: (currentStatus?.connectionCount ?? 0) + 1
        };
        patchNapcatInstanceStatus(instance, patch);
        if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
          patchNapcatStatus(patch);
        }
        appendAdapterLog("napcat", {
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

        socket.on("close", () => {
          activeSockets.delete(socket);
          const patch = {
            connected: activeSockets.size > 0,
            activeConnections: activeSockets.size,
            lastDisconnectedAt: new Date().toISOString()
          };
          patchNapcatInstanceStatus(instance, patch);
          if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
            patchNapcatStatus(patch);
          }
          appendAdapterLog("napcat", {
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
          try {
            const event = JSON.parse(data.toString()) as OneBotEvent;
            const currentMessageStatus = readGatewayStatus().napcatInstances?.[instance.id] ?? readGatewayStatus().napcat;
            const patch = {
              lastMessageAt: new Date().toISOString(),
              messageCount: (currentMessageStatus?.messageCount ?? 0) + 1
            };
            patchNapcatInstanceStatus(instance, patch);
            if (instance.id === "default" || config.napcatInstances[0]?.id === instance.id) {
              patchNapcatStatus(patch);
            }
            appendAdapterLog("napcat", {
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
            appendAdapterLog("napcat", {
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

      server.on("listening", () => {
        appendAdapterLog("napcat", {
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
        patchMessageAdapterStatus({
          type: "napcat",
          status: "running",
          message: `NapCat / OneBot 消息适配端已启动：${instances.length} 个实例。`
        });
        patchNapcatInstanceStatus(instance, {
          connected: false,
          activeConnections: 0,
          loginInfoError: ""
        });
        void refreshBotProfile(instance);
        if (Number.isFinite(loginRefreshIntervalSeconds) && loginRefreshIntervalSeconds > 0) {
          setInterval(() => {
            void refreshBotProfile(instance);
          }, loginRefreshIntervalSeconds * 1000);
        }
      });
      }
    }
  };
}
