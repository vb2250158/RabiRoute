import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { appendFeishuMessage, type FeishuMessageRecord } from "../history.js";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

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
  // The official Feishu envelope prefixes its random IV to the ciphertext.
  const payload = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, payload.subarray(0, 16));
  const plaintext = Buffer.concat([
    decipher.update(payload.subarray(16)),
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
