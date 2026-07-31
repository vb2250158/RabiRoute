import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFeishuMessageToDir } from "../history.js";
import {
  decryptFeishuCallback,
  handleFeishuCallback,
  verifyFeishuCallbackSignature
} from "./feishuAdapter.js";

const verificationToken = "verification-token-for-test";
const encryptKey = "encrypt-key-for-test";
const nowSeconds = 1_700_000_000;

function callbackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      create_time: String(nowSeconds),
      token: verificationToken
    },
    event: {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "om-message",
        chat_id: "oc-source-chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello from Feishu" })
      }
    },
    ...overrides
  };
}

function signed(rawBody: Buffer, timestamp = String(nowSeconds), nonce = "nonce-1") {
  const signature = createHash("sha256")
    .update(timestamp)
    .update(nonce)
    .update(encryptKey)
    .update(rawBody)
    .digest("hex");
  return { timestamp, nonce, signature };
}

function encrypt(body: Record<string, unknown>): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(body), "utf8")),
    cipher.final()
  ]).toString("base64");
}

test("Feishu callback signature covers timestamp, nonce, Encrypt Key and raw body", () => {
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  const headers = signed(rawBody);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, encryptKey, nowSeconds), true);
  assert.equal(verifyFeishuCallbackSignature(Buffer.from("{}"), headers, encryptKey, nowSeconds), false);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, "wrong-key", nowSeconds), false);
  assert.equal(verifyFeishuCallbackSignature(rawBody, headers, encryptKey, nowSeconds + 301), false);
});

test("Feishu URL challenge is authenticated by Verification Token without requiring a signature", () => {
  const result = handleFeishuCallback({
    rawBody: Buffer.from(JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value",
      token: verificationToken
    })),
    headers: {},
    verificationToken,
    encryptKey,
    nowSeconds
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.disposition, "challenge");
  assert.deepEqual(result.responseBody, { challenge: "challenge-value" });
});

test("signed Feishu message persists once by event_id and preserves the source chat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-feishu-"));
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  const input = {
    rawBody,
    headers: signed(rawBody),
    verificationToken,
    encryptKey,
    nowSeconds,
    persist: (record: Parameters<typeof appendFeishuMessageToDir>[0]) =>
      appendFeishuMessageToDir(record, dir)
  };
  const accepted = handleFeishuCallback(input);
  const duplicateAfterFreshHandler = handleFeishuCallback(input);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(accepted.record?.eventId, "evt-1");
  assert.equal(accepted.record?.chatId, "oc-source-chat");
  assert.equal(duplicateAfterFreshHandler.disposition, "duplicate");

  const lines = fs.readFileSync(path.join(dir, "feishu-messages.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /verification-token-for-test/);
  assert.doesNotMatch(lines[0], /encrypt-key-for-test/);
});

test("Feishu message callback rejects missing, stale, or invalid signatures", () => {
  const rawBody = Buffer.from(JSON.stringify(callbackBody()));
  for (const headers of [
    {},
    signed(rawBody, String(nowSeconds - 301)),
    { ...signed(rawBody), signature: "0".repeat(64) }
  ]) {
    const result = handleFeishuCallback({
      rawBody,
      headers,
      verificationToken,
      encryptKey,
      nowSeconds
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.disposition, "invalid_signature");
  }
});

test("encrypted Feishu callbacks are verified and decrypted before dispatch", () => {
  const encrypted = encrypt(callbackBody());
  const rawBody = Buffer.from(JSON.stringify({ encrypt: encrypted }));
  assert.equal(decryptFeishuCallback(encrypted, encryptKey).schema, "2.0");
  const result = handleFeishuCallback({
    rawBody,
    headers: signed(rawBody),
    verificationToken,
    encryptKey,
    nowSeconds,
    persist: () => true
  });
  assert.equal(result.disposition, "accepted");
  assert.equal(result.record?.messageId, "om-message");
});
