import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import {
  appendAdapterLog,
  appendFeishuMessage,
  type FeishuMessageRecord
} from "../history.js";
import { forwardMessage } from "../forwarding.js";
import type { MessageAdapter } from "./messageAdapter.js";

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

const statusPath = path.join(config.dataDir, "gateway-status.json");

function patchFeishuStatus(patch: Record<string, unknown>): void {
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
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
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
export function createFeishuAdapter(): MessageAdapter {
  return {
    type: "feishu",
    start() {
      const missing = [
        !(config.feishuAppId && config.feishuAppSecret) ? "app_credentials" : "",
        !config.feishuVerificationToken ? "verification_token" : "",
        !config.feishuEncryptKey ? "encrypt_key" : "",
        !config.feishuEventSubscriptionEnabled ? "event_subscription" : ""
      ].filter(Boolean);
      if (missing.length > 0) {
        const message = "飞书消息端保持关闭：需要独立应用凭据、Verification Token、Encrypt Key，并明确确认事件订阅已配置；群机器人 webhook 不能替代。";
        patchFeishuStatus({
          status: "blocked",
          connected: false,
          authenticated: false,
          listenerReady: false,
          message,
          missing
        });
        appendAdapterLog("feishu", {
          level: "warning",
          event: "missing_config",
          message,
          data: { missing }
        });
        return;
      }

      const server = http.createServer(async (request, response) => {
        const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method !== "POST" || requestPath !== config.feishuWebhookPath) {
          response.writeHead(404);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_CALLBACK_BYTES) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(bytes);
        }
        const result = handleFeishuCallback({
          rawBody: Buffer.concat(chunks),
          headers: {
            timestamp: request.headers["x-lark-request-timestamp"] as string | undefined,
            nonce: request.headers["x-lark-request-nonce"] as string | undefined,
            signature: request.headers["x-lark-signature"] as string | undefined
          },
          verificationToken: config.feishuVerificationToken,
          encryptKey: config.feishuEncryptKey
        });
        if (result.disposition === "challenge") {
          patchFeishuStatus({
            status: "ready",
            connected: true,
            authenticated: true,
            listenerReady: true,
            subscriptionVerified: true,
            lastChallengeAt: new Date().toISOString()
          });
        } else if (result.disposition === "accepted" && result.record) {
          patchFeishuStatus({
            status: "ready",
            connected: true,
            authenticated: true,
            listenerReady: true,
            subscriptionVerified: true,
            lastMessageAt: new Date().toISOString(),
            lastEventId: result.record.eventId
          });
          forwardMessage("feishu_message", result.record, {
            feishuChatId: result.record.chatId,
            feishuMessageId: result.record.messageId
          });
        } else if (result.disposition === "duplicate") {
          appendAdapterLog("feishu", {
            event: "duplicate_event_ignored",
            message: "Ignored an already persisted Feishu event."
          });
        } else if (result.statusCode >= 400) {
          appendAdapterLog("feishu", {
            level: "warning",
            event: "callback_rejected",
            message: `Rejected Feishu callback: ${result.disposition}.`
          });
        }
        response.writeHead(result.statusCode, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify(result.responseBody ?? {}));
      });
      server.listen(config.feishuWebhookPort, "127.0.0.1", () => {
        const message = "飞书独立事件入口已监听，等待已配置的飞书应用完成 URL challenge 或投递事件。";
        patchFeishuStatus({
          status: "listening",
          connected: false,
          authenticated: true,
          listenerReady: true,
          subscriptionVerified: false,
          message,
          callbackPath: config.feishuWebhookPath,
          callbackPort: config.feishuWebhookPort
        });
        appendAdapterLog("feishu", { event: "listening", message });
      });
      server.on("error", (error) => {
        const message = `飞书事件入口未启动：${error.message}`;
        patchFeishuStatus({
          status: "failed",
          connected: false,
          authenticated: true,
          listenerReady: false,
          message
        });
        appendAdapterLog("feishu", {
          level: "error",
          event: "listener_failed",
          message
        });
      });
    }
  };
}
