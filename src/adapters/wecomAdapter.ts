import fs from "node:fs";
import path from "node:path";
import type { BaseMessage, WsFrame } from "@wecom/aibot-node-sdk";
import { config } from "../config.js";
import { forwardMessage, recordMessageContextOnly } from "../forwarding.js";
import { appendAdapterLogToDir, appendWeComMessageToDir, type WeComMessageRecord } from "../history.js";
import type { ForwardTemplateValues } from "../routing/types.js";
import {
  createWeComClient,
  normalizeWeComError,
  quoteTextFromWeComMessage,
  textFromWeComMessage,
  type WeComClientLike,
  type WeComEndpoint
} from "../wecom.js";
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";

type GatewayStatus = {
  messageAdapters?: Record<string, Record<string, unknown>>;
  wecom?: Record<string, unknown>;
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

function patchWeComStatus(
  patch: Record<string, unknown>,
  dataDir = config.dataDir,
  now = new Date()
): void {
  const status = readGatewayStatus(dataDir);
  const current = status.messageAdapters?.wecom ?? {};
  const next = {
    ...current,
    ...patch,
    type: "wecom",
    updatedAt: now.toISOString()
  };
  writeGatewayStatus({
    ...status,
    wecom: {
      ...status.wecom,
      ...next
    },
    messageAdapters: {
      ...status.messageAdapters,
      wecom: next
    }
  }, dataDir);
}

function segmentsFromMessage(message: BaseMessage): unknown[] {
  if (message.msgtype === "mixed") {
    return message.mixed?.msg_item ?? [];
  }
  if (message.msgtype === "text") {
    return [{ type: "text", data: message.text }];
  }
  if (message.msgtype === "image") {
    return [{ type: "image", data: message.image }];
  }
  if (message.msgtype === "voice") {
    return [{ type: "voice", data: message.voice }];
  }
  if (message.msgtype === "file") {
    return [{ type: "file", data: message.file }];
  }
  if (message.msgtype === "video") {
    return [{ type: "video", data: message.video }];
  }
  return [];
}

function recordFromFrame(frame: WsFrame<BaseMessage>): WeComMessageRecord | null {
  const body = frame.body;
  if (!body) {
    return null;
  }
  const chatId = body.chatid || body.conversation_id || body.conversationId;
  const rawMessage = textFromWeComMessage(body).trim();
  const from = body.from as { userid?: string; name?: string } | undefined;
  const quote = body.quote as { msgid?: string } | undefined;
  const senderId = from?.userid ? String(from.userid) : "";
  return {
    time: body.create_time ?? Math.floor(Date.now() / 1000),
    adapterType: "wecom",
    rawMessage: rawMessage || `[${body.msgtype}]`,
    messageId: body.msgid || frame.headers?.req_id || `wecom-${Date.now()}`,
    reqId: frame.headers?.req_id,
    conversationId: body.conversation_id || body.conversationId || chatId,
    chatId,
    groupId: chatId,
    userId: senderId,
    senderId,
    identityNamespace: config.wecomBotId ? `bot:${config.wecomBotId}` : undefined,
    senderName: from?.name || senderId,
    messageType: body.msgtype,
    repliedMessageId: quote?.msgid,
    isSelf: Boolean(config.botUserId && senderId === config.botUserId),
    segments: segmentsFromMessage(body),
    raw: frame
  };
}

function shouldRoute(record: WeComMessageRecord): boolean {
  if (record.isSelf) return false;
  return ["text", "mixed", "voice", "image", "file"].includes(record.messageType || "");
}

export type WeComRecordDisposition = "forwarded" | "record_only";

/**
 * Keeps endpoint recording independent from Agent delivery. Self echoes and
 * unsupported message kinds remain conversation evidence without waking an
 * Agent; ordinary user messages continue through the normal forwarding path.
 */
export function dispatchWeComRecord(
  record: WeComMessageRecord,
  values: ForwardTemplateValues,
  handlers: {
    forward?: typeof forwardMessage;
    recordOnly?: typeof recordMessageContextOnly;
  } = {}
): WeComRecordDisposition {
  if (!shouldRoute(record)) {
    (handlers.recordOnly ?? recordMessageContextOnly)("wecom_message", record);
    return "record_only";
  }
  (handlers.forward ?? forwardMessage)("wecom_message", record, values);
  return "forwarded";
}

export type WeComAdapterDependencies = {
  endpoint?: () => WeComEndpoint;
  dataDir?: () => string;
  memoryDataDir?: () => string;
  now?: () => Date;
  createClient?: typeof createWeComClient;
};

type WeComLifecycle = {
  active: boolean;
  dataDir(): string;
  memoryDataDir(): string;
  now(): Date;
};

function appendWeComRuntimeLog(
  lifecycle: Pick<WeComLifecycle, "dataDir">,
  record: Parameters<typeof appendAdapterLogToDir>[1]
): void {
  appendAdapterLogToDir("wecom", record, lifecycle.dataDir());
}

export function createWeComAdapter(
  dependencies: WeComAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "wecom",
    start() {
      const endpoint = dependencies.endpoint?.() ?? {
        botId: config.wecomBotId,
        secret: config.wecomBotSecret,
        wsUrl: config.wecomWsUrl
      };
      const lifecycle: WeComLifecycle = {
        active: true,
        dataDir: dependencies.dataDir ?? (() => config.dataDir),
        memoryDataDir: dependencies.memoryDataDir ?? (() => config.memoryDataDir),
        now: dependencies.now ?? (() => new Date())
      };
      if (!endpoint.botId || !endpoint.secret) {
        lifecycle.active = false;
        const message = "企业微信消息端缺少 WECOM_BOT_ID / WECOM_BOT_SECRET。";
        patchWeComStatus({ status: "error", connected: false, authenticated: false, message, lastError: message }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { level: "error", event: "missing_config", message });
        console.error(message);
        return () => {};
      }

      const client = (dependencies.createClient ?? createWeComClient)(endpoint, {
        logger: {
          debug: (message, ...args) => appendWeComRuntimeLog(lifecycle, { event: "sdk_debug", message, data: args }),
          info: (message, ...args) => appendWeComRuntimeLog(lifecycle, { event: "sdk_info", message, data: args }),
          warn: (message, ...args) => appendWeComRuntimeLog(lifecycle, { level: "warning", event: "sdk_warning", message, data: args }),
          error: (message, ...args) => appendWeComRuntimeLog(lifecycle, { level: "error", event: "sdk_error", message, data: args })
        }
      });
      client.on("connected", () => {
        if (!lifecycle.active) return;
        patchWeComStatus({ status: "running", connected: true, message: "企业微信 WebSocket 已连接。", lastError: "" }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { event: "connected", message: "WeCom WebSocket connected" });
      });
      client.on("authenticated", () => {
        if (!lifecycle.active) return;
        patchWeComStatus({ status: "running", connected: true, authenticated: true, message: "企业微信智能机器人已认证。", lastError: "" }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { event: "authenticated", message: "WeCom bot authenticated" });
      });
      client.on("disconnected", (reason) => {
        if (!lifecycle.active) return;
        patchWeComStatus({ status: "running", connected: false, authenticated: false, message: `企业微信 WebSocket 已断开：${reason}` }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { level: "warning", event: "disconnected", message: reason });
      });
      client.on("reconnecting", (attempt) => {
        if (!lifecycle.active) return;
        patchWeComStatus({ status: "running", connected: false, reconnectAttempt: attempt, message: `企业微信 WebSocket 重连中：${attempt}` }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { level: "warning", event: "reconnecting", message: String(attempt) });
      });
      client.on("error", (error) => {
        if (!lifecycle.active) return;
        const message = normalizeWeComError(error);
        patchWeComStatus({ status: "error", lastError: message, message }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { level: "error", event: "error", message });
      });
      client.on("event", (frame) => {
        if (!lifecycle.active) return;
        appendWeComRuntimeLog(lifecycle, {
          event: "inbound_event",
          message: frame.body?.event?.eventtype,
          data: frame
        });
      });
      client.on("message", (frame) => {
        if (!lifecycle.active) return;
        const record = recordFromFrame(frame);
        if (!record) return;
        appendWeComRuntimeLog(lifecycle, {
          event: "inbound_message",
          message: record.rawMessage.slice(0, 500),
          data: {
            messageId: record.messageId,
            reqId: record.reqId,
            chatId: record.chatId,
            userId: record.userId,
            messageType: record.messageType
          }
        });
        appendWeComMessageToDir(record, lifecycle.memoryDataDir());
        const current = readGatewayStatus(lifecycle.dataDir()).messageAdapters?.wecom as Record<string, unknown> | undefined;
        patchWeComStatus({
          status: "running",
          lastMessageAt: lifecycle.now().toISOString(),
          messageCount: Number(current?.messageCount ?? 0) + 1,
          connected: client.isConnected
        }, lifecycle.dataDir(), lifecycle.now());
        dispatchWeComRecord(record, {
          wecomReqId: record.reqId,
          wecomConversationId: record.conversationId,
          wecomChatId: record.chatId,
          wecomSenderId: record.senderId,
          wecomMessageType: record.messageType,
          repliedMessageId: record.repliedMessageId,
          repliedMessage: frame.body ? quoteTextFromWeComMessage(frame.body) : undefined
        });
      });

      const dispose: MessageAdapterDispose = () => {
        if (!lifecycle.active) return;
        lifecycle.active = false;
        try {
          client.disconnect();
        } catch (error) {
          const message = normalizeWeComError(error);
          patchWeComStatus({ status: "error", connected: false, authenticated: false, lastError: message, message }, lifecycle.dataDir(), lifecycle.now());
          appendWeComRuntimeLog(lifecycle, { level: "error", event: "disconnect_error", message });
          throw error;
        }
        patchWeComStatus({
          status: "disabled",
          connected: false,
          authenticated: false,
          message: "企业微信消息端已停止。"
        }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { event: "disabled", message: "WeCom adapter disabled" });
      };

      patchWeComStatus({ status: "running", connected: false, authenticated: false, message: "企业微信消息端启动中。" }, lifecycle.dataDir(), lifecycle.now());
      appendWeComRuntimeLog(lifecycle, { event: "starting", message: "Starting WeCom adapter" });
      try {
        client.connect();
        return dispose;
      } catch (error) {
        lifecycle.active = false;
        try {
          client.disconnect();
        } catch {
          // The original connection failure remains the activation result.
        }
        const message = normalizeWeComError(error);
        patchWeComStatus({ status: "error", connected: false, authenticated: false, lastError: message, message }, lifecycle.dataDir(), lifecycle.now());
        appendWeComRuntimeLog(lifecycle, { level: "error", event: "activation_failed", message });
        throw error;
      }
    }
  };
}
