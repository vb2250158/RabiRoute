import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { config } from "@rabiroute/host-api/config";
import { forwardMessage, forwardMessageWithCompletion, recordMessageContextOnly } from "@rabiroute/host-api/forwarding";
import {
  appendAdapterLogToDir,
  appendWeixinMessageToDir,
  type WeixinMessageRecord
} from "@rabiroute/host-api/history";
import type { ForwardTemplateValues } from "@rabiroute/host-api/routing/types";
import {
  pollWeixinQrSession,
  notifyWeixinConnection,
  pollWeixinRealName,
  startWeixinRealName,
  pollWeixinUpdates,
  downloadWeixinMedia,
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
import type { MessageAdapter, MessageAdapterDispose } from "@rabiroute/host-api/adapters/messageAdapter";
import {
  applyWeixinPollFailure,
  applyWeixinPollSuccess,
  describeWeixinStartup,
  type WeixinSessionStatus
} from "./weixinSessionLifecycle.js";
import {
  clearWeixinLoginRequest,
  completeWeixinLogout,
  hasActiveWeixinLoginRequest,
  hasWeixinLogoutRequest,
  readWeixinLoginMode,
  waitForWeixinPin,
  WEIXIN_LOGOUT_REQUEST_FILE
} from "../weixinLoginRequest.js";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";

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

export async function dispatchWeixinRecord(
  record: WeixinMessageRecord,
  values: ForwardTemplateValues,
  handlers: { forward?: (...args: Parameters<typeof forwardMessage>) => unknown; recordOnly?: typeof recordMessageContextOnly } = {}
): Promise<WeixinRecordDisposition> {
  if (record.messageType !== "text" && !record.attachments?.length && !textFromWeixinItems(record.segments).hasText) {
    await (handlers.recordOnly ?? recordMessageContextOnly)("weixin_message", record);
    return "record_only";
  }
  await (handlers.forward ?? forwardMessageWithCompletion ?? forwardMessage)("weixin_message", record, values);
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
  notifyConnection?: typeof notifyWeixinConnection;
  downloadImages?: typeof downloadWeixinMedia;
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
  pendingDeliveries: Set<Promise<void>>;
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  readState: typeof readWeixinState;
  writeState: typeof writeWeixinState;
  requestQrSession: typeof requestWeixinQrSession;
  pollQrSession: typeof pollWeixinQrSession;
  pollUpdates: typeof pollWeixinUpdates;
  notifyConnection: typeof notifyWeixinConnection;
  liveState?: WeixinOpenClawState;
  pollAbort?: AbortController;
  downloadImages: typeof downloadWeixinMedia;
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
  message: WeixinInboundMessage,
  sessionId: string,
  messageId: string
): Promise<WeixinMessageRecord | null> {
  const parsed = textFromWeixinItems(message.item_list);
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
    ? `\n[微信附件：${attachments.map((attachment) => attachment.path).join(", ")}]`
    : "";
  return {
    time,
    adapterType: "weixin",
    sessionId,
    userId: sessionId,
    identityNamespace: weixinIdentityNamespace(state),
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

function weixinIdentityNamespace(state: WeixinOpenClawState): string | undefined {
  return state.accountId ? `bot:${state.accountId}` : state.userId ? `user:${state.userId}` : undefined;
}

function statusPatch(status: WeixinSessionStatus): Record<string, unknown> {
  const message = status.phase === "restoring"
    ? "正在从安全存储恢复微信机器人会话。"
    : status.phase === "restored"
      ? "微信机器人会话已恢复，正在接收消息。"
      : status.phase === "temporarily_unreachable"
        ? "微信机器人暂时不可达；会话凭据已保留，不需要重新扫码。"
        : status.phase === "invalid"
          ? "微信机器人会话已由服务端判定失效，需要重新扫码。"
          : "微信机器人从未登录，需要扫码后才能接收消息。";
  return {
    status: status.phase === "temporarily_unreachable" ? "degraded" : "running",
    sessionPhase: status.phase,
    loggedIn: status.loggedIn,
    credentialsRetained: status.credentialsRetained,
    loginRequired: status.loginRequired,
    ...(status.loginRequired ? { identityNamespace: "" } : {}),
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
  if (!sessionId || Number(message.message_type) === 2) return false;
  const contextToken = String(message.context_token || "").trim();
  const messageId = String(message.message_id || message.msg_id || "").trim() || lifecycle.randomId();
  if (lifecycle.recentMessageIds.has(messageId)) {
    if (contextToken) state.contextTokens[sessionId] = contextToken;
    return Boolean(contextToken);
  }
  const record = await recordFromInbound(lifecycle, state, message, sessionId, messageId);
  if (!lifecycle.active || !record) return false;
  if (contextToken) state.contextTokens[sessionId] = contextToken;
  lifecycle.appendMessage(record, lifecycle.memoryDataDir);
  rememberMessageId(lifecycle.recentMessageIds, String(record.messageId));
  const delivery = lifecycle.dispatchRecord(record, {
    weixinSessionId: record.sessionId,
    weixinUserId: record.userId,
    weixinMessageType: record.messageType,
    repliedMessageId: record.repliedMessageId,
    repliedMessage: record.quotedText
  }).then(disposition => {
    if (lifecycle.active) {
      const current = readGatewayStatus(lifecycle.dataDir).messageAdapters?.weixin;
      patchActiveWeixinStatus(lifecycle, {
        status: "running",
        loggedIn: true,
        lastError: "",
        lastMessageAt: lifecycle.now().toISOString(),
        messageCount: Number(current?.messageCount || 0) + 1,
        message: disposition === "forwarded" ? "微信机器人消息已交给 RabiRoute。" : "微信机器人媒体消息已记录；无可读取附件。"
      });
    }
    appendWeixinRuntimeLog(lifecycle, { event: "inbound_message", message: disposition,
      data: { messageId: record.messageId, messageType: record.messageType, hasReply: Boolean(record.repliedMessageId) } });
  });
  lifecycle.pendingDeliveries.add(delivery);
  void delivery.then(() => { lifecycle.pendingDeliveries.delete(delivery); }, error => {
    lifecycle.pendingDeliveries.delete(delivery);
    const message = error instanceof Error ? error.message : String(error);
    try { appendWeixinRuntimeLog(lifecycle, { level: "error", event: "record_context_failed", message, data: { messageId: record.messageId } }); }
    catch (logError) { console.error("Failed to record the Weixin routing error", logError); }
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
  const accountId = String(data.ilink_bot_id || "").trim() || undefined;
  if (!accountId || state.accountId !== accountId) {
    state.contextTokens = {};
    state.syncBuf = undefined;
  }
  state.token = token;
  state.authState = "recoverable";
  state.credentialsRetained = true;
  state.lastConfirmedAt = now.toISOString();
  state.accountId = accountId;
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
  let attemptId = "";
  let realName: Awaited<ReturnType<typeof startWeixinRealName>> | undefined;
  let realNameApproved = false;
  let realNameAttempts = 0;
  let qrCount = 0;
  while (lifecycle.active) {
    try {
      if (hasWeixinLogoutRequest(lifecycle.dataDir)) {
        await closeWeixinConnection(lifecycle);
        state = { baseUrl: lifecycle.baseUrl, contextTokens: {}, authState: "never_logged_in", updatedAt: lifecycle.now().toISOString() };
        lifecycle.writeState(lifecycle.dataDir, state);
        lifecycle.clearLoginRequest(lifecycle.dataDir);
        completeWeixinLogout(lifecycle.dataDir);
        patchActiveWeixinStatus(lifecycle, { ...statusPatch(describeWeixinStartup(state)), accountId: "",
          qrCode: "", qrCodeImageContent: "", qrCodeDataUrl: "", qrExpiresAt: "", loginAttemptId: "" });
      }
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
          qrSession = undefined;
          realName = undefined;
          realNameApproved = false;
          realNameAttempts = 0;
          qrCount = 0;
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
        if (readWeixinLoginMode(lifecycle.dataDir, lifecycle.now()) === "other" && !realNameApproved) {
          if (!realName) {
            realNameAttempts += 1;
            realName = await startWeixinRealName(lifecycle.controller.signal);
            const qrCodeDataUrl = await lifecycle.toQrDataUrl(realName.qrContent);
            patchActiveWeixinStatus(lifecycle, { qrCodeDataUrl, qrStatus: "real_name_required",
              qrExpiresAt: new Date(realName.expiresAt).toISOString(), message: "请先用本人微信扫描实名授权码。" });
          }
          const auth = lifecycle.now().getTime() >= realName.expiresAt ? 3
            : await pollWeixinRealName(realName.ticket, lifecycle.controller.signal).catch(() => 0);
          if (auth !== 1) {
            if (auth === 3 && realNameAttempts < 2) { realName = undefined; continue; }
            if (auth !== 0) {
              lifecycle.clearLoginRequest(lifecycle.dataDir);
              patchActiveWeixinStatus(lifecycle, { qrCodeDataUrl: "", qrStatus: "real_name_failed",
                message: "微信实名授权未完成，请重新开始。" });
            }
            await lifecycle.sleep(1000, lifecycle.controller.signal);
            continue;
          }
          realNameApproved = true;
        }
        if (!qrSession || lifecycle.now().getTime() - qrSession.startedAt >= 5 * 60 * 1000) {
          if (++qrCount > 3 || (realName && realName.expiresAt - lifecycle.now().getTime() < 60000)) {
            lifecycle.clearLoginRequest(lifecycle.dataDir);
            patchActiveWeixinStatus(lifecycle, { qrCodeDataUrl: "", qrStatus: "expired", message: "微信绑定已超时，请重新开始。" });
            continue;
          }
          qrSession = await lifecycle.requestQrSession(
            state.baseUrl,
            lifecycle.botType,
            lifecycle.controller.signal,
            realName?.ticket
          );
          attemptId = lifecycle.randomId();
          if (!lifecycle.active) break;
          const qrCodeDataUrl = await lifecycle.toQrDataUrl(qrSession.qrcodeImageContent);
          if (!lifecycle.active) break;
          patchActiveWeixinStatus(lifecycle, {
            status: "running",
            loggedIn: false,
            qrStatus: qrSession.status,
            loginAttemptId: attemptId,
            qrCode: qrSession.qrcode,
            qrCodeImageContent: qrSession.qrcodeImageContent,
            qrCodeDataUrl,
            qrExpiresAt: new Date(qrSession.startedAt + 5 * 60 * 1000).toISOString(),
            lastError: "",
            message: "请使用手机微信扫码登录微信机器人消息端。"
          });
          appendWeixinRuntimeLog(lifecycle, { event: "qr_ready", message: "Weixin login QR is ready." });
        }
        const needsPin = qrSession.status.includes("need_verifycode");
        const pin = needsPin ? await waitForWeixinPin(lifecycle.dataDir, attemptId,
          qrSession.startedAt + 5 * 60 * 1000 - lifecycle.now().getTime(), lifecycle.controller.signal) : undefined;
        if (needsPin && !pin) continue;
        const login = await lifecycle.pollQrSession(
          state.baseUrl,
          qrSession,
          lifecycle.controller.signal,
          pin
        );
        if (!lifecycle.active) break;
        const qrStatus = String(login.status || "wait").trim();
        qrSession.status = qrStatus;
        patchActiveWeixinStatus(lifecycle, { qrStatus, loggedIn: false,
          ...(qrStatus.includes("need_verifycode") ? { message: "请填写手机微信显示的验证码。" } : {}) });
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
            loginAttemptId: "",
            accountId: state.accountId,
            identityNamespace: weixinIdentityNamespace(state) ?? "",
            lastError: "",
            message: "微信机器人已登录，正在接收消息。"
          });
          appendWeixinRuntimeLog(lifecycle, { event: "login_confirmed", message: "Weixin login confirmed." });
        } else if (qrStatus === "scaned_but_redirect") {
          const hostname = typeof login.redirect_host === "string" ? login.redirect_host.trim() : "";
          if (!/^[\w.-]+\.weixin\.qq\.com$/i.test(hostname)) throw new Error("微信返回的扫码接入地址无效。");
          qrSession.pollBaseUrl = "https://" + hostname;
        } else if (qrStatus === "expired" || qrStatus === "verify_code_blocked") {
          qrSession = undefined;
        } else if (qrStatus === "binded_redirect") {
          lifecycle.clearLoginRequest(lifecycle.dataDir);
          patchActiveWeixinStatus(lifecycle, { qrCodeDataUrl: "", loginAttemptId: "", message: "微信已绑定此机器人。请在微信里核对绑定状态。" });
        } else {
          await lifecycle.sleep(1000, lifecycle.controller.signal);
        }
        continue;
      }

      if (!lifecycle.liveState) {
        lifecycle.liveState = state;
        await lifecycle.notifyConnection(state, true, lifecycle.controller.signal).catch(() => undefined);
      }
      const pollAbort = new AbortController();
      lifecycle.pollAbort = pollAbort;
      if (hasWeixinLogoutRequest(lifecycle.dataDir)) continue;
      const updates = await lifecycle.pollUpdates(state, AbortSignal.any([lifecycle.controller.signal, pollAbort.signal]));
      if (!lifecycle.active) break;
      if (!weixinApiSucceeded(updates)) {
        const failure = applyWeixinPollFailure(state, updates, lifecycle.now());
        state = failure.state;
        if (failure.status.phase === "invalid") {
          await closeWeixinConnection(lifecycle);
          lifecycle.writeState(lifecycle.dataDir, state);
          qrSession = undefined;
          patchActiveWeixinStatus(lifecycle, statusPatch(failure.status));
          continue;
        }
        throw new Error(failure.status.error || weixinApiError(updates));
      }
      const restored = applyWeixinPollSuccess(state, lifecycle.now());
      state = restored.state;
      const suggestedTimeout = Number(updates.longpolling_timeout_ms);
      if (Number.isFinite(suggestedTimeout) && suggestedTimeout > 0) state.longPollingTimeoutMs = Math.min(120000, suggestedTimeout + 2000);
      let changed = false;
      const messages = Array.isArray(updates.msgs) ? updates.msgs : [];
      for (const item of messages) {
        if (!lifecycle.active) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        changed = await processInbound(lifecycle, state, item as WeixinInboundMessage) || changed;
      }
      if (!lifecycle.active) {
        // Keep context from admitted messages, but leave unfinished parts of this batch for the next activation.
        if (changed) lifecycle.writeState(lifecycle.dataDir, state);
        break;
      }
      if (typeof updates.get_updates_buf === "string" && updates.get_updates_buf) {
        const next = { ...state, syncBuf: String(updates.get_updates_buf) };
        lifecycle.writeState(lifecycle.dataDir, next);
        state = next;
      } else if (changed || restored.status.phase === "restored") {
        lifecycle.writeState(lifecycle.dataDir, state);
      }
      patchActiveWeixinStatus(lifecycle, {
        ...statusPatch(restored.status),
        lastPollAt: lifecycle.now().toISOString()
      });
    } catch (error) {
      if (!lifecycle.active) break;
      if (hasWeixinLogoutRequest(lifecycle.dataDir)) continue;
      const failure = applyWeixinPollFailure(state, error, lifecycle.now());
      state = failure.state;
      const message = failure.status.error || (error instanceof Error ? error.message : String(error));
      patchActiveWeixinStatus(lifecycle, statusPatch(failure.status));
      appendWeixinRuntimeLog(lifecycle, { level: "error", event: "poll_failed", message });
      await lifecycle.sleep(5000, lifecycle.controller.signal);
    }
  }
}

async function closeWeixinConnection(lifecycle: WeixinLifecycle): Promise<void> {
  const state = lifecycle.liveState;
  lifecycle.liveState = undefined;
  if (state) await lifecycle.notifyConnection(state, false).catch(() => undefined);
}

export function createWeixinAdapter(
  dependencies: WeixinAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "weixin",
    start(startup?: { onFailure(cleanup: MessageAdapterDispose): void }) {
      const lifecycle: WeixinLifecycle = {
        active: true,
        controller: new AbortController(),
        dataDir: dependencies.dataDir?.() ?? config.dataDir,
        memoryDataDir: dependencies.memoryDataDir?.() ?? config.memoryDataDir,
        baseUrl: dependencies.baseUrl?.() ?? config.weixinBaseUrl,
        botType: dependencies.botType?.() ?? config.weixinBotType,
        recentMessageIds: new Set<string>(),
        pendingDeliveries: new Set<Promise<void>>(),
        now: dependencies.now ?? (() => new Date()),
        sleep: dependencies.sleep ?? waitForDelay,
        readState: dependencies.readState ?? readWeixinState,
        writeState: dependencies.writeState ?? writeWeixinState,
        requestQrSession: dependencies.requestQrSession ?? requestWeixinQrSession,
        pollQrSession: dependencies.pollQrSession ?? pollWeixinQrSession,
        pollUpdates: dependencies.pollUpdates ?? pollWeixinUpdates,
        notifyConnection: dependencies.notifyConnection ?? notifyWeixinConnection,
        downloadImages: dependencies.downloadImages ?? downloadWeixinMedia,
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
      let runPromise: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      let logoutWatcher: fs.FSWatcher | undefined;
      const stopWork = () => closing ??= (async () => {
        lifecycle.active = false;
        lifecycle.controller.abort();
        logoutWatcher?.close();
        try { await runPromise; }
        finally { await Promise.allSettled([closeWeixinConnection(lifecycle), ...lifecycle.pendingDeliveries]); }
      })();
      startup?.onFailure(stopWork);
      lifecycle.recentMessageIds = loadRecentMessageIds(lifecycle.memoryDataDir);
      const state = lifecycle.readState(lifecycle.dataDir, lifecycle.baseUrl);
      patchWeixinStatus(lifecycle.dataDir, {
        ...statusPatch(describeWeixinStartup(state)),
        identityNamespace: weixinIdentityNamespace(state) ?? "",
        maturity: "experimental"
      }, lifecycle.now());
      logoutWatcher = fs.watch(lifecycle.dataDir, { persistent: false }, (_, filename) => {
        if ((!filename || filename === WEIXIN_LOGOUT_REQUEST_FILE) && hasWeixinLogoutRequest(lifecycle.dataDir)) lifecycle.pollAbort?.abort();
      });
      runPromise = runWeixinAdapter(lifecycle).catch((error) => {
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
      let disposal: Promise<void> | undefined;
      const dispose: MessageAdapterDispose = () => disposal ??= (async () => {
        await stopWork();
        patchWeixinStatus(lifecycle.dataDir, {
          status: "disabled",
          polling: false,
          loggedIn: false,
          qrStatus: "disabled",
          qrCode: "",
          qrCodeImageContent: "",
          qrCodeDataUrl: "",
          qrExpiresAt: "",
          message: "微信机器人消息端已停止。"
        }, lifecycle.now());
        appendWeixinRuntimeLog(lifecycle, { event: "disabled", message: "Weixin adapter disabled" });
      })();
      return dispose;
    }
  };
}
