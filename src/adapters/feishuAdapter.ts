import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import {
  appendAdapterLogToDir,
  appendFeishuMessage,
  appendFeishuMessageToDir,
  type AdapterLogRecord,
  type FeishuMessageRecord
} from "../history.js";
import { forwardMessage } from "../forwarding.js";
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

type GatewayStatus = {
  messageAdapters?: Record<string, Record<string, unknown>>;
  feishu?: Record<string, unknown>;
};

export type FeishuCallbackHeaders = {
  timestamp?: string;
  nonce?: string;
  signature?: string;
};

export type FeishuCallbackResult = {
  statusCode: number;
  responseBody?: Record<string, unknown>;
  disposition:
    | "challenge"
    | "accepted"
    | "duplicate"
    | "ignored"
    | "invalid_json"
    | "invalid_signature"
    | "invalid_token"
    | "invalid_event";
  record?: FeishuMessageRecord;
};

function gatewayStatusPath(dataDir: string): string {
  return path.join(dataDir, "gateway-status.json");
}

function patchFeishuStatus(
  patch: Record<string, unknown>,
  dataDir = config.dataDir,
  now = new Date()
): void {
  const statusPath = gatewayStatusPath(dataDir);
  let status: GatewayStatus = {};
  try {
    if (fs.existsSync(statusPath)) {
      status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
    }
  } catch {
    // Replace malformed status while preserving fail-closed runtime behavior.
  }
  const next = {
    ...(status.messageAdapters?.feishu ?? {}),
    ...patch,
    type: "feishu",
    updatedAt: now.toISOString()
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({
    ...status,
    feishu: { ...status.feishu, ...next },
    messageAdapters: { ...status.messageAdapters, feishu: next }
  }, null, 2), "utf8");
}
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Feishu callback signature:
 * SHA256(timestamp + nonce + encryptKey + rawRequestBody).
 */
export function verifyFeishuCallbackSignature(
  rawBody: Buffer,
  headers: FeishuCallbackHeaders,
  encryptKey: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const timestamp = String(headers.timestamp ?? "").trim();
  const nonce = String(headers.nonce ?? "").trim();
  const signature = String(headers.signature ?? "").trim().toLowerCase();
  const parsedTimestamp = Number(timestamp);
  if (!encryptKey || !timestamp || !nonce || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (!Number.isFinite(parsedTimestamp) || Math.abs(nowSeconds - parsedTimestamp) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = createHash("sha256")
    .update(timestamp, "utf8")
    .update(nonce, "utf8")
    .update(encryptKey, "utf8")
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, signature);
}

/** Decrypt an encrypted Feishu callback using the configured Encrypt Key. */
export function decryptFeishuCallback(encrypted: string, encryptKey: string): Record<string, unknown> {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decrypted Feishu callback is not an object.");
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTextContent(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return stringValue(objectValue(JSON.parse(value)).text);
  } catch {
    return "";
  }
}

function verifiedToken(body: Record<string, unknown>, expected: string): boolean {
  const header = objectValue(body.header);
  const token = stringValue(body.token) || stringValue(header.token);
  return Boolean(token && expected && safeEqual(token, expected));
}

export function handleFeishuCallback(input: {
  rawBody: Buffer;
  headers: FeishuCallbackHeaders;
  verificationToken: string;
  encryptKey: string;
  nowSeconds?: number;
  persist?: (record: FeishuMessageRecord) => boolean;
  /** App ID identifies this configured endpoint without exposing its secret. */
  identityNamespace?: string;
}): FeishuCallbackResult {
  let envelope: Record<string, unknown>;
  try {
    envelope = objectValue(JSON.parse(input.rawBody.toString("utf8")));
  } catch {
    return { statusCode: 400, disposition: "invalid_json" };
  }

  let body = envelope;
  const encrypted = stringValue(envelope.encrypt);
  if (encrypted) {
    if (!verifyFeishuCallbackSignature(
      input.rawBody,
      input.headers,
      input.encryptKey,
      input.nowSeconds
    )) {
      return { statusCode: 401, disposition: "invalid_signature" };
    }
    try {
      body = decryptFeishuCallback(encrypted, input.encryptKey);
    } catch {
      return { statusCode: 400, disposition: "invalid_event" };
    }
  }

  if (!verifiedToken(body, input.verificationToken)) {
    return { statusCode: 401, disposition: "invalid_token" };
  }

  // Feishu excludes URL verification from signature verification. The
  // configured verification token still authenticates the challenge.
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return {
      statusCode: 200,
      responseBody: { challenge: body.challenge },
      disposition: "challenge"
    };
  }

  if (!encrypted && !verifyFeishuCallbackSignature(
    input.rawBody,
    input.headers,
    input.encryptKey,
    input.nowSeconds
  )) {
    return { statusCode: 401, disposition: "invalid_signature" };
  }

  const header = objectValue(body.header);
  if (header.event_type !== "im.message.receive_v1") {
    return { statusCode: 200, disposition: "ignored" };
  }
  const event = objectValue(body.event);
  const message = objectValue(event.message);
  if (message.message_type !== "text") {
    return { statusCode: 200, disposition: "ignored" };
  }

  const eventId = stringValue(header.event_id);
  const messageId = stringValue(message.message_id);
  const chatId = stringValue(message.chat_id);
  const text = parseTextContent(message.content);
  if (!eventId || !messageId || !chatId || !text) {
    return { statusCode: 400, disposition: "invalid_event" };
  }
  const sender = objectValue(event.sender);
  const senderId = objectValue(sender.sender_id);
  const record: FeishuMessageRecord = {
    time: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    rawMessage: text,
    messageId,
    eventId,
    adapterType: "feishu",
    chatId,
    groupId: chatId,
    userId: stringValue(senderId.open_id) || stringValue(senderId.user_id),
    identityNamespace: stringValue(input.identityNamespace),
    messageType: "text",
    // Never persist the callback token, encrypted blob, or full raw body.
    raw: {
      schema: stringValue(body.schema),
      eventType: "im.message.receive_v1",
      eventId,
      chatType: stringValue(message.chat_type),
      createTime: stringValue(header.create_time)
    }
  };
  const persisted = (input.persist ?? appendFeishuMessage)(record);
  return {
    statusCode: 200,
    disposition: persisted ? "accepted" : "duplicate",
    record: persisted ? record : undefined
  };
}

/**
 * Feishu is independent from the generic webhook adapter. The listener stays
 * off until the app credentials, signed callback secrets, and explicit event
 * subscription confirmation are all present.
 */
export type FeishuAdapterSettings = {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  eventSubscriptionEnabled: boolean;
  webhookPath: string;
  webhookPort: number;
  host?: string;
};

export type FeishuAdapterDependencies = {
  settings?: () => FeishuAdapterSettings;
  dataDir?: () => string;
  memoryDataDir?: () => string;
  now?: () => Date;
  createServer?: (requestListener: http.RequestListener) => http.Server;
  persist?: (record: FeishuMessageRecord, memoryDataDir: string) => boolean;
  forward?: typeof forwardMessage;
  appendLog?: (
    record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>,
    dataDir: string
  ) => void;
};

type FeishuLifecycle = {
  active: boolean;
  dataDir: string;
  memoryDataDir: string;
  now(): Date;
};

function closeFeishuServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createFeishuAdapter(
  dependencies: FeishuAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "feishu",
    start(): Promise<MessageAdapterDispose> {
      const settings = dependencies.settings?.() ?? {
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        verificationToken: config.feishuVerificationToken,
        encryptKey: config.feishuEncryptKey,
        eventSubscriptionEnabled: config.feishuEventSubscriptionEnabled,
        webhookPath: config.feishuWebhookPath,
        webhookPort: config.feishuWebhookPort
      };
      const lifecycle: FeishuLifecycle = {
        active: true,
        dataDir: dependencies.dataDir?.() ?? config.dataDir,
        memoryDataDir: dependencies.memoryDataDir?.() ?? config.memoryDataDir,
        now: dependencies.now ?? (() => new Date())
      };
      const appendLog = (record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>) => {
        (dependencies.appendLog ?? ((entry, dataDir) => appendAdapterLogToDir("feishu", entry, dataDir)))(record, lifecycle.dataDir);
      };
      const patchRuntimeStatus = (patch: Record<string, unknown>, now = lifecycle.now()) => {
        try {
          patchFeishuStatus(patch, lifecycle.dataDir, now);
        } catch (error) {
          console.error("Failed to update Feishu runtime status", error);
        }
      };
      const appendRuntimeLog = (record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>) => {
        try {
          appendLog(record);
        } catch (error) {
          console.error("Failed to append Feishu runtime log", error);
        }
      };
      const missing = [
        !(settings.appId && settings.appSecret) ? "app_credentials" : "",
        !settings.verificationToken ? "verification_token" : "",
        !settings.encryptKey ? "encrypt_key" : "",
        !settings.eventSubscriptionEnabled ? "event_subscription" : ""
      ].filter(Boolean);
      if (missing.length > 0) {
        lifecycle.active = false;
        const message = "飞书消息端保持关闭：需要独立应用凭据、Verification Token、Encrypt Key，并明确确认事件订阅已配置；群机器人 webhook 不能替代。";
        patchFeishuStatus({
          status: "blocked",
          connected: false,
          authenticated: false,
          listenerReady: false,
          message,
          missing
        }, lifecycle.dataDir, lifecycle.now());
        appendLog({
          level: "warning",
          event: "missing_config",
          message,
          data: { missing }
        });
        return Promise.resolve(() => {});
      }

      const persist = dependencies.persist ?? appendFeishuMessageToDir;
      const deliver = dependencies.forward ?? forwardMessage;
      const server = (dependencies.createServer ?? http.createServer)(async (request, response) => {
        if (!lifecycle.active) {
          response.writeHead(503).end();
          return;
        }
        const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method !== "POST" || requestPath !== settings.webhookPath) {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of request) {
            if (!lifecycle.active) return;
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_CALLBACK_BYTES) {
              response.writeHead(413).end();
              return;
            }
            chunks.push(bytes);
          }
        } catch (error) {
          if (!lifecycle.active) return;
          const message = error instanceof Error ? error.message : String(error);
          appendLog({ level: "warning", event: "request_aborted", message });
          if (!response.headersSent) response.writeHead(400).end();
          return;
        }
        if (!lifecycle.active) return;
        const now = lifecycle.now();
        try {
          const result = handleFeishuCallback({
            rawBody: Buffer.concat(chunks),
            headers: {
              timestamp: request.headers["x-lark-request-timestamp"] as string | undefined,
              nonce: request.headers["x-lark-request-nonce"] as string | undefined,
              signature: request.headers["x-lark-signature"] as string | undefined
            },
            verificationToken: settings.verificationToken,
            encryptKey: settings.encryptKey,
            nowSeconds: Math.floor(now.getTime() / 1000),
            persist: (record) => lifecycle.active && persist(record, lifecycle.memoryDataDir),
            identityNamespace: settings.appId
          });
          if (!lifecycle.active) return;
          if (result.disposition === "challenge") {
            patchRuntimeStatus({
              status: "ready",
              connected: true,
              authenticated: true,
              listenerReady: true,
              subscriptionVerified: true,
              lastChallengeAt: now.toISOString()
            }, now);
          } else if (result.disposition === "accepted" && result.record) {
            patchRuntimeStatus({
              status: "ready",
              connected: true,
              authenticated: true,
              listenerReady: true,
              subscriptionVerified: true,
              lastMessageAt: now.toISOString(),
              lastEventId: result.record.eventId
            }, now);
            deliver("feishu_message", result.record, {
              feishuChatId: result.record.chatId,
              feishuMessageId: result.record.messageId
            });
          } else if (result.disposition === "duplicate") {
            appendRuntimeLog({
              event: "duplicate_event_ignored",
              message: "Ignored an already persisted Feishu event."
            });
          } else if (result.statusCode >= 400) {
            appendRuntimeLog({
              level: "warning",
              event: "callback_rejected",
              message: `Rejected Feishu callback: ${result.disposition}.`
            });
          }
          response.writeHead(result.statusCode, {
            "content-type": "application/json; charset=utf-8"
          });
          response.end(JSON.stringify(result.responseBody ?? {}));
        } catch (error) {
          if (!lifecycle.active) return;
          const message = error instanceof Error ? error.message : String(error);
          patchRuntimeStatus({
            status: "failed",
            listenerReady: server.listening,
            lastError: message,
            message: `飞书回调处理失败：${message}`
          });
          appendRuntimeLog({ level: "error", event: "callback_failed", message });
          if (!response.headersSent) response.writeHead(500).end();
        }
      });
      const host = settings.host || "127.0.0.1";

      return new Promise<MessageAdapterDispose>((resolve, reject) => {
        let startupSettled = false;

        const reportServerError = (error: Error, event: "listen_error" | "server_error") => {
          if (!lifecycle.active && event === "server_error") return;
          const message = event === "listen_error"
            ? `飞书事件入口未启动：${error.message}`
            : `飞书事件入口错误：${error.message}`;
          try {
            patchFeishuStatus({
              status: "failed",
              connected: false,
              authenticated: true,
              listenerReady: false,
              lastError: error.message,
              message
            }, lifecycle.dataDir, lifecycle.now());
          } catch (statusError) {
            console.error("Failed to update Feishu status", statusError);
          }
          try {
            appendLog({ level: "error", event, message });
          } catch (logError) {
            console.error("Failed to append Feishu error log", logError);
          }
        };

        const onStartupError = (error: Error) => {
          if (startupSettled) return;
          startupSettled = true;
          lifecycle.active = false;
          reportServerError(error, "listen_error");
          void closeFeishuServer(server).finally(() => reject(error));
        };

        server.once("error", onStartupError);
        server.listen(settings.webhookPort, host, async () => {
          if (startupSettled) return;
          server.off("error", onStartupError);
          const onServerError = (error: Error) => reportServerError(error, "server_error");
          server.on("error", onServerError);
          try {
            const message = "飞书独立事件入口已监听，等待已配置的飞书应用完成 URL challenge 或投递事件。";
            patchFeishuStatus({
              status: "listening",
              connected: false,
              authenticated: true,
              listenerReady: true,
              subscriptionVerified: false,
              message,
              callbackPath: settings.webhookPath,
              callbackPort: settings.webhookPort
            }, lifecycle.dataDir, lifecycle.now());
            appendLog({ event: "listening", message });
            startupSettled = true;
            let disposalPromise: Promise<void> | undefined;
            resolve(() => {
              if (!disposalPromise) {
                disposalPromise = (async () => {
                  lifecycle.active = false;
                  server.off("error", onServerError);
                  await closeFeishuServer(server);
                  patchRuntimeStatus({
                    status: "disabled",
                    connected: false,
                    authenticated: false,
                    listenerReady: false,
                    subscriptionVerified: false,
                    message: "飞书消息端已停止。",
                    callbackPath: settings.webhookPath,
                    callbackPort: settings.webhookPort
                  });
                  appendRuntimeLog({ event: "disabled", message: "Feishu adapter disabled" });
                })();
              }
              return disposalPromise;
            });
          } catch (error) {
            startupSettled = true;
            lifecycle.active = false;
            server.off("error", onServerError);
            await closeFeishuServer(server).catch(() => {});
            const startupError = error instanceof Error ? error : new Error(String(error));
            reportServerError(startupError, "listen_error");
            reject(startupError);
          }
        });
      });
    }
  };
}
