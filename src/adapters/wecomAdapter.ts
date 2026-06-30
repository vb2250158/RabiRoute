import fs from "node:fs";
import path from "node:path";
import type { BaseMessage, WsFrame } from "@wecom/aibot-node-sdk";
import { config } from "../config.js";
import { forwardMessage } from "../forwarding.js";
import { appendAdapterLog, appendWeComMessage, type WeComMessageRecord } from "../history.js";
import {
  createWeComClient,
  normalizeWeComError,
  quoteTextFromWeComMessage,
  textFromWeComMessage
} from "../wecom.js";
import type { MessageAdapter } from "./messageAdapter.js";

type GatewayStatus = {
  messageAdapters?: Record<string, Record<string, unknown>>;
  wecom?: Record<string, unknown>;
};

const statusPath = path.join(config.dataDir, "gateway-status.json");

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

function patchWeComStatus(patch: Record<string, unknown>): void {
  const status = readGatewayStatus();
  const current = status.messageAdapters?.wecom ?? {};
  const next = {
    ...current,
    ...patch,
    type: "wecom",
    updatedAt: new Date().toISOString()
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
  });
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

export function createWeComAdapter(): MessageAdapter {
  return {
    type: "wecom",
    start() {
      const endpoint = {
        botId: config.wecomBotId,
        secret: config.wecomBotSecret,
        wsUrl: config.wecomWsUrl
      };
      if (!endpoint.botId || !endpoint.secret) {
        const message = "企业微信消息端缺少 WECOM_BOT_ID / WECOM_BOT_SECRET。";
        patchWeComStatus({ status: "error", connected: false, authenticated: false, message, lastError: message });
        appendAdapterLog("wecom", { level: "error", event: "missing_config", message });
        console.error(message);
        return;
      }

      const client = createWeComClient(endpoint, {
        logger: {
          debug: (message, ...args) => appendAdapterLog("wecom", { event: "sdk_debug", message, data: args }),
          info: (message, ...args) => appendAdapterLog("wecom", { event: "sdk_info", message, data: args }),
          warn: (message, ...args) => appendAdapterLog("wecom", { level: "warning", event: "sdk_warning", message, data: args }),
          error: (message, ...args) => appendAdapterLog("wecom", { level: "error", event: "sdk_error", message, data: args })
        }
      });

      client.on("connected", () => {
        patchWeComStatus({ status: "running", connected: true, message: "企业微信 WebSocket 已连接。", lastError: "" });
        appendAdapterLog("wecom", { event: "connected", message: "WeCom WebSocket connected" });
      });
      client.on("authenticated", () => {
        patchWeComStatus({ status: "running", connected: true, authenticated: true, message: "企业微信智能机器人已认证。", lastError: "" });
        appendAdapterLog("wecom", { event: "authenticated", message: "WeCom bot authenticated" });
      });
      client.on("disconnected", (reason) => {
        patchWeComStatus({ status: "running", connected: false, authenticated: false, message: `企业微信 WebSocket 已断开：${reason}` });
        appendAdapterLog("wecom", { level: "warning", event: "disconnected", message: reason });
      });
      client.on("reconnecting", (attempt) => {
        patchWeComStatus({ status: "running", connected: false, reconnectAttempt: attempt, message: `企业微信 WebSocket 重连中：${attempt}` });
        appendAdapterLog("wecom", { level: "warning", event: "reconnecting", message: String(attempt) });
      });
      client.on("error", (error) => {
        const message = normalizeWeComError(error);
        patchWeComStatus({ status: "error", lastError: message, message });
        appendAdapterLog("wecom", { level: "error", event: "error", message });
      });
      client.on("event", (frame) => {
        appendAdapterLog("wecom", {
          event: "inbound_event",
          message: frame.body?.event?.eventtype,
          data: frame
        });
      });
      client.on("message", (frame) => {
        const record = recordFromFrame(frame);
        if (!record) return;
        appendAdapterLog("wecom", {
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
        appendWeComMessage(record);
        const current = readGatewayStatus().messageAdapters?.wecom as Record<string, unknown> | undefined;
        patchWeComStatus({
          status: "running",
          lastMessageAt: new Date().toISOString(),
          messageCount: Number(current?.messageCount ?? 0) + 1,
          connected: client.isConnected
        });
        if (!shouldRoute(record)) return;
        forwardMessage("wecom_message", record, {
          wecomReqId: record.reqId,
          wecomConversationId: record.conversationId,
          wecomChatId: record.chatId,
          wecomSenderId: record.senderId,
          wecomMessageType: record.messageType,
          repliedMessageId: record.repliedMessageId,
          repliedMessage: frame.body ? quoteTextFromWeComMessage(frame.body) : undefined
        });
      });

      patchWeComStatus({ status: "running", connected: false, authenticated: false, message: "企业微信消息端启动中。" });
      appendAdapterLog("wecom", { event: "starting", message: "Starting WeCom adapter" });
      client.connect();
    }
  };
}
