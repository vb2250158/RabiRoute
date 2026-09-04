import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { config } from "../config.js";
import { forwardMessage, recordMessageContextOnly } from "../forwarding.js";
import {
  appendAdapterLogToDir,
  appendWeixinMessageToDir,
  type WeixinMessageRecord
} from "../history.js";
import type { ForwardTemplateValues } from "../routing/types.js";
import {
  pollWeixinQrSession,
  pollWeixinUpdates,
  downloadWeixinImages,
  readWeixinState,
  requestWeixinQrSession,
  textFromWeixinItems,
  weixinApiError,
  weixinApiSucceeded,
  writeWeixinState,
  type WeixinInboundMessage,
  type WeixinOpenClawState,
  type WeixinQrSession
} from "../weixinOpenClaw.js";
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";
import {
  applyWeixinPollFailure,
  applyWeixinPollSuccess,
  describeWeixinStartup,
  type WeixinSessionStatus
} from "./weixinSessionLifecycle.js";
import {
  clearWeixinLoginRequest,
  hasActiveWeixinLoginRequest
} from "../weixinLoginRequest.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

type GatewayStatus = { messageAdapters?: Record<string, Record<string, unknown>> };
const MAX_RECENT_IDS = 5000;

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function gatewayStatusPath(dataDir: string): string {
  return path.join(dataDir, "gateway-status.json");
}

function messageHistoryPath(memoryDataDir: string): string {
  return path.join(memoryDataDir, "weixin-messages.jsonl");
}

function readGatewayStatus(dataDir: string): GatewayStatus {
  const statusPath = gatewayStatusPath(dataDir);
  if (!fs.existsSync(statusPath)) return {};
  try { return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus; } catch { return {}; }
}

function patchWeixinStatus(dataDir: string, patch: Record<string, unknown>, now = new Date()): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const statusPath = gatewayStatusPath(dataDir);
  const status = readGatewayStatus(dataDir);
  const current = status.messageAdapters?.weixin ?? {};
  const next = {
    ...current,
    ...patch,
    type: "weixin",
    maturity: "experimental",
    updatedAt: now.toISOString()
  };
  try {
    fs.writeFileSync(statusPath, JSON.stringify({
      ...status,
      messageAdapters: { ...status.messageAdapters, weixin: next }
    }, null, 2), "utf8");
    recordDataMutationAudit({
      group: "gateway",
      event: "weixin_adapter_status_committed",
      owner: "weixin-adapter",
      action: "patch-runtime-status",
      target: { type: "message-adapter", id: "weixin" },
      dataSource: { kind: "runtime", id: "gateway-status" },
      outcome: "committed",
      changes: Object.keys(patch).sort().map(field => ({ field }))
    });
  } catch (error) {
    recordDataMutationAudit({ level: "error", group: "gateway", event: "weixin_adapter_status_write_failed", owner: "weixin-adapter", action: "patch-runtime-status", target: { type: "message-adapter", id: "weixin" }, dataSource: { kind: "runtime", id: "gateway-status" }, outcome: "failed", error });
    throw error;
  }
}

function rememberMessageId(recentMessageIds: Set<string>, messageId: string): void {
  recentMessageIds.add(messageId);
  if (recentMessageIds.size <= MAX_RECENT_IDS) return;
  const oldest = recentMessageIds.values().next().value as string | undefined;
  if (oldest) recentMessageIds.delete(oldest);
}

function loadRecentMessageIds(memoryDataDir: string): Set<string> {
  const recentMessageIds = new Set<string>();
  const messagePath = messageHistoryPath(memoryDataDir);
  if (!fs.existsSync(messagePath)) return recentMessageIds;
  for (const line of fs.readFileSync(messagePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_RECENT_IDS)) {
    try {
      const parsed = JSON.parse(line) as { messageId?: unknown };
      const messageId = String(parsed.messageId || "").trim();
      if (messageId) rememberMessageId(recentMessageIds, messageId);
    } catch { /* keep starting after a malformed historic line */ }
  }
  return recentMessageIds;
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

export type WeixinAdapterDependencies = {
  dataDir?: () => string;
  memoryDataDir?: () => string;
  baseUrl?: () => string;
  botType?: () => string;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readState?: typeof readWeixinState;
  writeState?: typeof writeWeixinState;
  requestQrSession?: typeof requestWeixinQrSession;
  pollQrSession?: typeof pollWeixinQrSession;
  pollUpdates?: typeof pollWeixinUpdates;
  downloadImages?: typeof downloadWeixinImages;
  toQrDataUrl?: (content: string) => Promise<string>;
  hasLoginRequest?: typeof hasActiveWeixinLoginRequest;
  clearLoginRequest?: typeof clearWeixinLoginRequest;
  appendMessage?: typeof appendWeixinMessageToDir;
  dispatchRecord?: typeof dispatchWeixinRecord;
  randomId?: () => string;
};

type WeixinLifecycle = {
  active: boolean;
  controller: AbortController;
  dataDir: string;
  memoryDataDir: string;
  baseUrl: string;
  botType: string;
  recentMessageIds: Set<string>;
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  readState: typeof readWeixinState;
  writeState: typeof writeWeixinState;
  requestQrSession: typeof requestWeixinQrSession;
  pollQrSession: typeof pollWeixinQrSession;
  pollUpdates: typeof pollWeixinUpdates;
  downloadImages: typeof downloadWeixinImages;
  toQrDataUrl(content: string): Promise<string>;
  hasLoginRequest: typeof hasActiveWeixinLoginRequest;
  clearLoginRequest: typeof clearWeixinLoginRequest;
  appendMessage: typeof appendWeixinMessageToDir;
  dispatchRecord: typeof dispatchWeixinRecord;
  randomId(): string;
};

function appendWeixinRuntimeLog(
  lifecycle: Pick<WeixinLifecycle, "dataDir">,
  record: Parameters<typeof appendAdapterLogToDir>[1]
): void {
  appendAdapterLogToDir("weixin", record, lifecycle.dataDir);
}

function patchActiveWeixinStatus(lifecycle: WeixinLifecycle, patch: Record<string, unknown>): void {
  if (!lifecycle.active) return;
  patchWeixinStatus(lifecycle.dataDir, patch, lifecycle.now());
}

async function recordFromInbound(
  lifecycle: WeixinLifecycle,
  state: WeixinOpenClawState,
  message: WeixinInboundMessage
): Promise<WeixinMessageRecord | null> {
  const sessionId = String(message.from_user_id || "").trim();
  if (!sessionId) return null;
  const parsed = textFromWeixinItems(message.item_list);
  const messageId = String(message.message_id || message.msg_id || lifecycle.randomId()).trim();
  const rawTime = Number(message.create_time_ms || message.create_time || 0);
  const time = rawTime > 1_000_000_000_000
    ? Math.floor(rawTime / 1000)
    : rawTime > 0
      ? Math.floor(rawTime)
      : Math.floor(lifecycle.now().getTime() / 1000);
  const attachments = await lifecycle.downloadImages(
    message.item_list,
    lifecycle.memoryDataDir,
    messageId,
    fetch,
    lifecycle.controller.signal
  );
  if (!lifecycle.active) return null;
  const attachmentHint = attachments.length
    ? `\n[图片附件：${attachments.map((attachment) => attachment.path).join(", ")}]`
    : "";
  return {
    time,
    adapterType: "weixin",
    sessionId,
    userId: sessionId,
    identityNamespace: state.accountId ? `bot:${state.accountId}` : state.userId ? `user:${state.userId}` : undefined,
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

function statusPatch(status: WeixinSessionStatus): Record<string, unknown> {
  const message = status.phase === "restoring"
    ? "正在从安全存储恢复个人微信会话。"
    : status.phase === "restored"
      ? "个人微信会话已恢复，正在接收消息。"
      : status.phase === "temporarily_unreachable"
        ? "个人微信暂时不可达；会话凭据已保留，不需要重新扫码。"
        : status.phase === "invalid"
          ? "个人微信会话已由服务端判定失效，需要重新扫码。"
          : "个人微信从未登录，需要扫码后才能接收消息。";
  return {
    status: status.phase === "temporarily_unreachable" ? "degraded" : "running",
    sessionPhase: status.phase,
    loggedIn: status.loggedIn,
    credentialsRetained: status.credentialsRetained,
    loginRequired: status.loginRequired,
    polling: status.phase === "restored",
    lastError: status.error || "",
    message
  };
}

async function processInbound(
  lifecycle: WeixinLifecycle,
  state: WeixinOpenClawState,
  message: WeixinInboundMessage
): Promise<boolean> {
  if (!lifecycle.active) return false;
  const sessionId = String(message.from_user_id || "").trim();
  if (!sessionId) return false;
  const contextToken = String(message.context_token || "").trim();
  if (contextToken) state.contextTokens[sessionId] = contextToken;
  const record = await recordFromInbound(lifecycle, state, message);
  if (!lifecycle.active || !record || lifecycle.recentMessageIds.has(String(record.messageId))) {
    return lifecycle.active && Boolean(contextToken);
  }
  rememberMessageId(lifecycle.recentMessageIds, String(record.messageId));
  lifecycle.appendMessage(record, lifecycle.memoryDataDir);
  if (!lifecycle.active) return false;
  const disposition = lifecycle.dispatchRecord(record, {
    weixinSessionId: record.sessionId,
    weixinUserId: record.userId,
    weixinMessageType: record.messageType,
    repliedMessageId: record.repliedMessageId,
    repliedMessage: record.quotedText
  });
  if (!lifecycle.active) return false;
  const current = readGatewayStatus(lifecycle.dataDir).messageAdapters?.weixin;
  patchActiveWeixinStatus(lifecycle, {
    status: "running",
    loggedIn: true,
    lastError: "",
    lastMessageAt: lifecycle.now().toISOString(),
    messageCount: Number(current?.messageCount || 0) + 1,
    message: disposition === "forwarded" ? "个人微信消息已交给 RabiRoute。" : "个人微信媒体消息已记录；无可读取附件。"
  });
  appendWeixinRuntimeLog(lifecycle, {
    event: "inbound_message",
    message: disposition,
    data: { messageId: record.messageId, messageType: record.messageType, hasReply: Boolean(record.repliedMessageId) }
  });
  return true;
}

function applyConfirmedLogin(
  state: WeixinOpenClawState,
  data: Record<string, unknown>,
  now: Date
): void {
  const token = String(data.bot_token || "").trim();
  if (!token) throw new Error("微信扫码已确认，但响应没有 bot_token。 ");
  state.token = token;
  state.authState = "recoverable";
  state.credentialsRetained = true;
  state.lastConfirmedAt = now.toISOString();
  state.accountId = String(data.ilink_bot_id || "").trim() || undefined;
  state.userId = String(data.ilink_user_id || "").trim() || undefined;
  const baseUrl = String(data.baseurl || "").trim();
  if (baseUrl) state.baseUrl = baseUrl.replace(/\/$/, "");
}

async function runWeixinAdapter(lifecycle: WeixinLifecycle): Promise<void> {
  let state = lifecycle.readState(lifecycle.dataDir, lifecycle.baseUrl);
  if (state.token && state.storageFormat === "legacy_plaintext") {
    lifecycle.writeState(lifecycle.dataDir, state);
    state = lifecycle.readState(lifecycle.dataDir, lifecycle.baseUrl);
  }
  patchActiveWeixinStatus(lifecycle, statusPatch(describeWeixinStartup(state)));
  let qrSession: WeixinQrSession | undefined;
  while (lifecycle.active) {
    try {
      if (!state.token) {
        const startup = describeWeixinStartup(state);
        if (!startup.loginRequired) {
          patchActiveWeixinStatus(lifecycle, statusPatch(startup));
          await lifecycle.sleep(5000, lifecycle.controller.signal);
          if (!lifecycle.active) break;
          state = lifecycle.readState(lifecycle.dataDir, lifecycle.baseUrl);
          continue;
        }
        if (!lifecycle.hasLoginRequest(lifecycle.dataDir, lifecycle.now())) {
          patchActiveWeixinStatus(lifecycle, {
            ...statusPatch(startup),
            qrStatus: "not_requested",
            qrCode: "",
            qrCodeImageContent: "",
            qrCodeDataUrl: "",
            qrExpiresAt: "",
            message: `${String(statusPatch(startup).message)} 请在管理面明确点击“生成登录二维码”。`
          });
          await lifecycle.sleep(2000, lifecycle.controller.signal);
          continue;
        }
        if (!qrSession || lifecycle.now().getTime() - qrSession.startedAt >= 5 * 60 * 1000) {
          qrSession = await lifecycle.requestQrSession(
            state.baseUrl,
            lifecycle.botType,
            lifecycle.controller.signal
          );
          if (!lifecycle.active) break;
          const qrCodeDataUrl = await lifecycle.toQrDataUrl(qrSession.qrcodeImageContent);
          if (!lifecycle.active) break;
          patchActiveWeixinStatus(lifecycle, {
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
          appendWeixinRuntimeLog(lifecycle, { event: "qr_ready", message: "Weixin login QR is ready." });
        }
        const login = await lifecycle.pollQrSession(
          state.baseUrl,
          qrSession,
          lifecycle.controller.signal
        );
        if (!lifecycle.active) break;
        const qrStatus = String(login.status || "wait").trim();
        qrSession.status = qrStatus;
        patchActiveWeixinStatus(lifecycle, { qrStatus, loggedIn: false });
        if (qrStatus === "confirmed") {
          applyConfirmedLogin(state, login, lifecycle.now());
          lifecycle.writeState(lifecycle.dataDir, state);
          lifecycle.clearLoginRequest(lifecycle.dataDir);
          qrSession = undefined;
          patchActiveWeixinStatus(lifecycle, {
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
          appendWeixinRuntimeLog(lifecycle, { event: "login_confirmed", message: "Weixin login confirmed." });
        } else if (qrStatus === "expired") {
          qrSession = undefined;
          lifecycle.clearLoginRequest(lifecycle.dataDir);
        } else {
          await lifecycle.sleep(1000, lifecycle.controller.signal);
        }
        continue;
      }

      const updates = await lifecycle.pollUpdates(state, lifecycle.controller.signal);
      if (!lifecycle.active) break;
      if (!weixinApiSucceeded(updates)) {
        const failure = applyWeixinPollFailure(state, updates, lifecycle.now());
        state = failure.state;
        if (failure.status.phase === "invalid") {
          lifecycle.writeState(lifecycle.dataDir, state);
          qrSession = undefined;
          patchActiveWeixinStatus(lifecycle, statusPatch(failure.status));
          continue;
        }
        throw new Error(failure.status.error || weixinApiError(updates));
      }
      const restored = applyWeixinPollSuccess(state, lifecycle.now());
      state = restored.state;
      if (updates.get_updates_buf != null) state.syncBuf = String(updates.get_updates_buf);
      let changed = updates.get_updates_buf != null;
      const messages = Array.isArray(updates.msgs) ? updates.msgs : [];
      for (const item of messages) {
        if (!lifecycle.active) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        changed = await processInbound(lifecycle, state, item as WeixinInboundMessage) || changed;
      }
      if (!lifecycle.active) break;
      if (changed || restored.status.phase === "restored") lifecycle.writeState(lifecycle.dataDir, state);
      patchActiveWeixinStatus(lifecycle, {
        ...statusPatch(restored.status),
        lastPollAt: lifecycle.now().toISOString()
      });
    } catch (error) {
      if (!lifecycle.active) break;
      const failure = applyWeixinPollFailure(state, error, lifecycle.now());
      state = failure.state;
      const message = failure.status.error || (error instanceof Error ? error.message : String(error));
      patchActiveWeixinStatus(lifecycle, statusPatch(failure.status));
      appendWeixinRuntimeLog(lifecycle, { level: "error", event: "poll_failed", message });
      await lifecycle.sleep(5000, lifecycle.controller.signal);
    }
  }
}

export function createWeixinAdapter(
  dependencies: WeixinAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "weixin",
    start() {
      const lifecycle: WeixinLifecycle = {
        active: true,
        controller: new AbortController(),
        dataDir: dependencies.dataDir?.() ?? config.dataDir,
        memoryDataDir: dependencies.memoryDataDir?.() ?? config.memoryDataDir,
        baseUrl: dependencies.baseUrl?.() ?? config.weixinBaseUrl,
        botType: dependencies.botType?.() ?? config.weixinBotType,
        recentMessageIds: new Set<string>(),
        now: dependencies.now ?? (() => new Date()),
        sleep: dependencies.sleep ?? waitForDelay,
        readState: dependencies.readState ?? readWeixinState,
        writeState: dependencies.writeState ?? writeWeixinState,
        requestQrSession: dependencies.requestQrSession ?? requestWeixinQrSession,
        pollQrSession: dependencies.pollQrSession ?? pollWeixinQrSession,
        pollUpdates: dependencies.pollUpdates ?? pollWeixinUpdates,
        downloadImages: dependencies.downloadImages ?? downloadWeixinImages,
        toQrDataUrl: dependencies.toQrDataUrl ?? ((content) => QRCode.toDataURL(content, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320
        })),
        hasLoginRequest: dependencies.hasLoginRequest ?? hasActiveWeixinLoginRequest,
        clearLoginRequest: dependencies.clearLoginRequest ?? clearWeixinLoginRequest,
        appendMessage: dependencies.appendMessage ?? appendWeixinMessageToDir,
        dispatchRecord: dependencies.dispatchRecord ?? dispatchWeixinRecord,
        randomId: dependencies.randomId ?? randomUUID
      };
      lifecycle.recentMessageIds = loadRecentMessageIds(lifecycle.memoryDataDir);
      const state = lifecycle.readState(lifecycle.dataDir, lifecycle.baseUrl);
      patchWeixinStatus(lifecycle.dataDir, {
        ...statusPatch(describeWeixinStartup(state)),
        maturity: "experimental"
      }, lifecycle.now());
      const runPromise = runWeixinAdapter(lifecycle).catch((error) => {
        if (!lifecycle.active) return;
        const message = error instanceof Error ? error.message : String(error);
        patchWeixinStatus(lifecycle.dataDir, {
          status: "error",
          polling: false,
          loggedIn: false,
          lastError: message,
          message
        }, lifecycle.now());
        appendWeixinRuntimeLog(lifecycle, { level: "error", event: "runtime_failed", message });
      });
      const dispose: MessageAdapterDispose = async () => {
        if (!lifecycle.active) {
          await runPromise;
          return;
        }
        lifecycle.active = false;
        lifecycle.controller.abort();
        await runPromise;
        patchWeixinStatus(lifecycle.dataDir, {
          status: "disabled",
          polling: false,
          loggedIn: false,
          qrStatus: "disabled",
          qrCode: "",
          qrCodeImageContent: "",
          qrCodeDataUrl: "",
          qrExpiresAt: "",
          message: "个人微信消息端已停止。"
        }, lifecycle.now());
        appendWeixinRuntimeLog(lifecycle, { event: "disabled", message: "Weixin adapter disabled" });
      };
      return dispose;
    }
  };
}
