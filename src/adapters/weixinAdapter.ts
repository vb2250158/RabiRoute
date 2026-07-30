import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { config } from "../config.js";
import { forwardMessage, recordMessageContextOnly } from "../forwarding.js";
import { appendAdapterLog, appendWeixinMessage, type WeixinMessageRecord } from "../history.js";
import type { ForwardTemplateValues } from "../routing/types.js";
import {
  pollWeixinQrSession,
  pollWeixinUpdates,
  downloadWeixinImages,
  readWeixinState,
  requestWeixinQrSession,
  textFromWeixinItems,
  WEIXIN_SESSION_TIMEOUT_ERRCODE,
  weixinApiError,
  weixinApiSucceeded,
  writeWeixinState,
  type WeixinInboundMessage,
  type WeixinOpenClawState,
  type WeixinQrSession
} from "../weixinOpenClaw.js";
import type { MessageAdapter } from "./messageAdapter.js";

type GatewayStatus = { messageAdapters?: Record<string, Record<string, unknown>> };
const statusPath = path.join(config.dataDir, "gateway-status.json");
const messagePath = path.join(config.memoryDataDir, "weixin-messages.jsonl");
const recentMessageIds = new Set<string>();
const MAX_RECENT_IDS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readGatewayStatus(): GatewayStatus {
  if (!fs.existsSync(statusPath)) return {};
  try { return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus; } catch { return {}; }
}

function patchWeixinStatus(patch: Record<string, unknown>): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const status = readGatewayStatus();
  const current = status.messageAdapters?.weixin ?? {};
  const next = { ...current, ...patch, type: "weixin", maturity: "experimental", updatedAt: new Date().toISOString() };
  fs.writeFileSync(statusPath, JSON.stringify({
    ...status,
    messageAdapters: { ...status.messageAdapters, weixin: next }
  }, null, 2), "utf8");
}

function rememberMessageId(messageId: string): void {
  recentMessageIds.add(messageId);
  if (recentMessageIds.size <= MAX_RECENT_IDS) return;
  const oldest = recentMessageIds.values().next().value as string | undefined;
  if (oldest) recentMessageIds.delete(oldest);
}

function loadRecentMessageIds(): void {
  if (!fs.existsSync(messagePath)) return;
  for (const line of fs.readFileSync(messagePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_RECENT_IDS)) {
    try {
      const parsed = JSON.parse(line) as { messageId?: unknown };
      const messageId = String(parsed.messageId || "").trim();
      if (messageId) rememberMessageId(messageId);
    } catch { /* keep starting after a malformed historic line */ }
  }
}

export type WeixinRecordDisposition = "forwarded" | "record_only";

export function dispatchWeixinRecord(
  record: WeixinMessageRecord,
  values: ForwardTemplateValues,
  handlers: { forward?: typeof forwardMessage; recordOnly?: typeof recordMessageContextOnly } = {}
): WeixinRecordDisposition {
  if (record.messageType !== "text" && !record.attachments?.length) {
    (handlers.recordOnly ?? recordMessageContextOnly)("weixin_message", record);
    return "record_only";
  }
  (handlers.forward ?? forwardMessage)("weixin_message", record, values);
  return "forwarded";
}

async function recordFromInbound(message: WeixinInboundMessage): Promise<WeixinMessageRecord | null> {
  const sessionId = String(message.from_user_id || "").trim();
  if (!sessionId) return null;
  const parsed = textFromWeixinItems(message.item_list);
  const messageId = String(message.message_id || message.msg_id || randomUUID()).trim();
  const rawTime = Number(message.create_time_ms || message.create_time || 0);
  const time = rawTime > 1_000_000_000_000 ? Math.floor(rawTime / 1000) : rawTime > 0 ? Math.floor(rawTime) : Math.floor(Date.now() / 1000);
  const attachments = await downloadWeixinImages(message.item_list, config.memoryDataDir, messageId);
  const attachmentHint = attachments.length
    ? `\n[图片附件：${attachments.map((attachment) => attachment.path).join(", ")}]`
    : "";
  return {
    time,
    adapterType: "weixin",
    sessionId,
    userId: sessionId,
    senderName: sessionId,
    messageId,
    messageType: parsed.messageType,
    rawMessage: `${parsed.text || `[${parsed.messageType}]`}${attachmentHint}`,
    quotedText: parsed.quotedText,
    repliedMessageId: parsed.repliedMessageId,
    attachments: attachments.length ? attachments : undefined,
    segments: Array.isArray(message.item_list) ? message.item_list.slice(0, 50) : undefined
  };
}

function clearLoginState(state: WeixinOpenClawState): WeixinOpenClawState {
  return { baseUrl: state.baseUrl, contextTokens: {}, updatedAt: new Date().toISOString() };
}

async function processInbound(state: WeixinOpenClawState, message: WeixinInboundMessage): Promise<boolean> {
  const sessionId = String(message.from_user_id || "").trim();
  if (!sessionId) return false;
  const contextToken = String(message.context_token || "").trim();
  if (contextToken) state.contextTokens[sessionId] = contextToken;
  const record = await recordFromInbound(message);
  if (!record || recentMessageIds.has(String(record.messageId))) return Boolean(contextToken);
  rememberMessageId(String(record.messageId));
  appendWeixinMessage(record);
  const disposition = dispatchWeixinRecord(record, {
    weixinSessionId: record.sessionId,
    weixinUserId: record.userId,
    weixinMessageType: record.messageType,
    repliedMessageId: record.repliedMessageId,
    repliedMessage: record.quotedText
  });
  const current = readGatewayStatus().messageAdapters?.weixin;
  patchWeixinStatus({
    status: "running",
    loggedIn: true,
    lastError: "",
    lastMessageAt: new Date().toISOString(),
    messageCount: Number(current?.messageCount || 0) + 1,
    message: disposition === "forwarded" ? "个人微信消息已交给 RabiRoute。" : "个人微信媒体消息已记录；无可读取附件。"
  });
  appendAdapterLog("weixin", {
    event: "inbound_message",
    message: disposition,
    data: { messageId: record.messageId, messageType: record.messageType, hasReply: Boolean(record.repliedMessageId) }
  });
  return true;
}

function applyConfirmedLogin(state: WeixinOpenClawState, data: Record<string, unknown>): void {
  const token = String(data.bot_token || "").trim();
  if (!token) throw new Error("微信扫码已确认，但响应没有 bot_token。 ");
  state.token = token;
  state.accountId = String(data.ilink_bot_id || "").trim() || undefined;
  state.userId = String(data.ilink_user_id || "").trim() || undefined;
  const baseUrl = String(data.baseurl || "").trim();
  if (baseUrl) state.baseUrl = baseUrl.replace(/\/$/, "");
}

async function runWeixinAdapter(): Promise<void> {
  loadRecentMessageIds();
  let state = readWeixinState(config.dataDir, config.weixinBaseUrl);
  let qrSession: WeixinQrSession | undefined;
  while (true) {
    try {
      if (!state.token) {
        if (!qrSession || Date.now() - qrSession.startedAt >= 5 * 60 * 1000) {
          qrSession = await requestWeixinQrSession(state.baseUrl, config.weixinBotType);
          const qrCodeDataUrl = await QRCode.toDataURL(qrSession.qrcodeImageContent, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 320
          });
          patchWeixinStatus({
            status: "running",
            loggedIn: false,
            qrStatus: qrSession.status,
            qrCode: qrSession.qrcode,
            qrCodeImageContent: qrSession.qrcodeImageContent,
            qrCodeDataUrl,
            qrExpiresAt: new Date(qrSession.startedAt + 5 * 60 * 1000).toISOString(),
            lastError: "",
            message: "请使用手机微信扫码登录个人微信消息端。"
          });
          appendAdapterLog("weixin", { event: "qr_ready", message: "Weixin login QR is ready." });
        }
        const login = await pollWeixinQrSession(state.baseUrl, qrSession);
        const status = String(login.status || "wait").trim();
        qrSession.status = status;
        patchWeixinStatus({ qrStatus: status, loggedIn: false });
        if (status === "confirmed") {
          applyConfirmedLogin(state, login);
          writeWeixinState(config.dataDir, state);
          qrSession = undefined;
          patchWeixinStatus({
            status: "running",
            loggedIn: true,
            qrStatus: "confirmed",
            qrCode: "",
            qrCodeImageContent: "",
            qrCodeDataUrl: "",
            accountId: state.accountId,
            lastError: "",
            message: "个人微信已登录，正在接收消息。"
          });
          appendAdapterLog("weixin", { event: "login_confirmed", message: "Weixin login confirmed." });
        } else if (status === "expired") {
          qrSession = undefined;
        } else {
          await sleep(1000);
        }
        continue;
      }

      const updates = await pollWeixinUpdates(state);
      if (!weixinApiSucceeded(updates)) {
        const error = weixinApiError(updates);
        if (Number(updates.errcode || 0) === WEIXIN_SESSION_TIMEOUT_ERRCODE) {
          state = clearLoginState(state);
          writeWeixinState(config.dataDir, state);
          qrSession = undefined;
          patchWeixinStatus({ status: "running", loggedIn: false, lastError: error, message: "个人微信登录已过期，请重新扫码。" });
          continue;
        }
        throw new Error(error);
      }
      if (updates.get_updates_buf != null) state.syncBuf = String(updates.get_updates_buf);
      let changed = updates.get_updates_buf != null;
      const messages = Array.isArray(updates.msgs) ? updates.msgs : [];
      for (const item of messages) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        changed = await processInbound(state, item as WeixinInboundMessage) || changed;
      }
      if (changed) writeWeixinState(config.dataDir, state);
      patchWeixinStatus({ status: "running", loggedIn: true, polling: true, lastPollAt: new Date().toISOString(), lastError: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchWeixinStatus({ status: "error", loggedIn: Boolean(state.token), polling: false, lastError: message, message });
      appendAdapterLog("weixin", { level: "error", event: "poll_failed", message });
      await sleep(5000);
    }
  }
}

export function createWeixinAdapter(): MessageAdapter {
  return {
    type: "weixin",
    start() {
      patchWeixinStatus({ status: "running", maturity: "experimental", loggedIn: false, message: "个人微信消息端启动中。" });
      void runWeixinAdapter();
    }
  };
}
