import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadWeixinImages,
  readWeixinState,
  sendWeixinFile,
  sendWeixinImage,
  textFromWeixinItems,
  weixinApiError,
  weixinApiSucceeded,
  writeWeixinState,
  type WeixinStateProtector
} from "./weixinOpenClaw.js";

const testProtector: WeixinStateProtector = {
  scheme: "test-protector",
  protect: plaintext => Buffer.from(plaintext, "utf8").toString("base64"),
  unprotect: protectedValue => Buffer.from(protectedValue, "base64").toString("utf8")
};

test("personal Weixin image input decrypts into private image storage", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-image-"));
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  try {
    const images = await downloadWeixinImages([
      { type: 2, image_item: { aeskey: key.toString("hex"), media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download" } } }
    ], tempDir, "message-1", async () => new Response(encrypted, { status: 200 }));
    assert.equal(images.length, 1);
    assert.equal(images[0]?.mimeType, "image/png");
    assert.deepEqual(fs.readFileSync(images[0]!.path), plain);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("personal Weixin item parsing preserves text, media markers, and reply evidence", () => {
  const parsed = textFromWeixinItems([
    { type: 1, text_item: { text: "hello" } },
    { type: 2 },
    { type: 3, voice_item: { text: "voice transcript" }, ref_msg: { message_item: { type: 1, text_item: { text: "quoted" }, message_id: "source-1" } } }
  ]);

  assert.equal(parsed.text, "hello\n[图片]\nvoice transcript");
  assert.equal(parsed.messageType, "mixed");
  assert.equal(parsed.quotedText, "quoted");
  assert.equal(parsed.repliedMessageId, "source-1");
});

test("personal Weixin state survives restart without writing plaintext credentials", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-"));
  try {
    writeWeixinState(tempDir, {
      token: "runtime-token",
      accountId: "account-1",
      userId: "user-1",
      baseUrl: "https://example.invalid",
      syncBuf: "cursor-1",
      contextTokens: { "session-1": "context-1" },
      authState: "recoverable",
      credentialsRetained: true,
      updatedAt: new Date(0).toISOString()
    }, testProtector);
    const persisted = fs.readFileSync(path.join(tempDir, "weixin-openclaw-state.json"), "utf8");
    assert.doesNotMatch(persisted, /runtime-token|account-1|user-1|cursor-1|context-1/);

    const state = readWeixinState(tempDir, undefined, testProtector);
    assert.equal(state.token, "runtime-token");
    assert.equal(state.accountId, "account-1");
    assert.equal(state.userId, "user-1");
    assert.equal(state.syncBuf, "cursor-1");
    assert.equal(state.contextTokens["session-1"], "context-1");
    assert.equal(state.baseUrl, "https://example.invalid");
    assert.equal(state.authState, "recoverable");
    assert.equal(state.credentialsRetained, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("personal Weixin distinguishes never logged in from an explicitly invalidated session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-empty-"));
  try {
    assert.equal(readWeixinState(tempDir, undefined, testProtector).authState, "never_logged_in");
    writeWeixinState(tempDir, {
      baseUrl: "https://example.invalid",
      contextTokens: {},
      authState: "invalid",
      credentialsRetained: false,
      invalidatedAt: "2026-07-31T00:00:00.000Z",
      updatedAt: new Date(0).toISOString()
    }, testProtector);
    assert.equal(readWeixinState(tempDir, undefined, testProtector).authState, "invalid");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy plaintext personal Weixin state migrates into the protected envelope", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-legacy-"));
  try {
    fs.writeFileSync(path.join(tempDir, "weixin-openclaw-state.json"), JSON.stringify({
      token: "legacy-secret",
      baseUrl: "https://example.invalid",
      contextTokens: { session: "legacy-context" },
      updatedAt: new Date(0).toISOString()
    }), "utf8");
    const legacy = readWeixinState(tempDir, undefined, testProtector);
    assert.equal(legacy.storageFormat, "legacy_plaintext");
    writeWeixinState(tempDir, legacy, testProtector);
    const persisted = fs.readFileSync(path.join(tempDir, "weixin-openclaw-state.json"), "utf8");
    assert.doesNotMatch(persisted, /legacy-secret|legacy-context/);
    assert.equal(readWeixinState(tempDir, undefined, testProtector).token, "legacy-secret");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Windows default personal Weixin storage uses current-user DPAPI", {
  skip: process.platform !== "win32"
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-dpapi-"));
  try {
    writeWeixinState(tempDir, {
      token: "dpapi-dummy-secret",
      baseUrl: "https://example.invalid",
      contextTokens: {},
      authState: "recoverable",
      credentialsRetained: true,
      updatedAt: new Date(0).toISOString()
    });
    const persisted = fs.readFileSync(path.join(tempDir, "weixin-openclaw-state.json"), "utf8");
    assert.doesNotMatch(persisted, /dpapi-dummy-secret/);
    assert.match(persisted, /windows-dpapi-current-user/);
    assert.equal(readWeixinState(tempDir).token, "dpapi-dummy-secret");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("personal Weixin API status uses both ret and errcode", () => {
  assert.equal(weixinApiSucceeded({ ret: 0, errcode: 0 }), true);
  assert.equal(weixinApiSucceeded({ ret: 0, errcode: -14 }), false);
  assert.match(weixinApiError({ ret: 1, errcode: 2, errmsg: "bad" }), /ret=1, errcode=2, errmsg=bad/);
});

test("personal Weixin file output encrypts, uploads, and sends a file item", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-file-"));
  const filePath = path.join(tempDir, "client.apk");
  fs.writeFileSync(filePath, Buffer.from("apk"));
  writeWeixinState(tempDir, {
    token: "runtime-token",
    baseUrl: "https://api.example.invalid",
    contextTokens: { "session-1": "context-1" },
    updatedAt: new Date(0).toISOString()
  });
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method || "GET"), body: init?.body });
    if (url.endsWith("/ilink/bot/getuploadurl")) {
      return new Response(JSON.stringify({ ret: 0, errcode: 0, upload_full_url: "https://cdn.example.invalid/upload" }), { status: 200 });
    }
    if (url === "https://cdn.example.invalid/upload") {
      return new Response("", { status: 200, headers: { "x-encrypted-param": "encrypted-file-reference" } });
    }
    return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
  };
  try {
    const result = await sendWeixinFile(tempDir, "session-1", filePath, "RabiLink.apk", "delivery-1");
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    const uploadRequest = JSON.parse(String(calls[0].body));
    assert.equal(uploadRequest.media_type, 3);
    assert.equal(uploadRequest.rawsize, 3);
    assert.equal(uploadRequest.filesize, 16);
    assert.equal((calls[1].body as Uint8Array).byteLength, 16);
    assert.notDeepEqual(Buffer.from(calls[1].body as Uint8Array), Buffer.from("apk"));
    const sendRequest = JSON.parse(String(calls[2].body));
    assert.equal(sendRequest.msg.item_list[0].type, 4);
    assert.equal(sendRequest.msg.item_list[0].file_item.file_name, "RabiLink.apk");
    assert.equal(sendRequest.msg.item_list[0].file_item.len, "3");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("personal Weixin image output uses the native image item", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-image-send-"));
  const imagePath = path.join(tempDir, "cat.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeWeixinState(tempDir, { token: "runtime-token", baseUrl: "https://api.example.invalid", contextTokens: { "session-1": "context-1" }, updatedAt: new Date(0).toISOString() });
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    if (url.endsWith("/ilink/bot/getuploadurl")) return new Response(JSON.stringify({ ret: 0, errcode: 0, upload_full_url: "https://cdn.example.invalid/upload" }), { status: 200 });
    if (url === "https://cdn.example.invalid/upload") return new Response("", { status: 200, headers: { "x-encrypted-param": "image-reference" } });
    return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
  };
  try {
    await sendWeixinImage(tempDir, "session-1", imagePath, "delivery-image-1");
    assert.equal(JSON.parse(String(calls[0].body)).media_type, 1);
    const sent = JSON.parse(String(calls[2].body));
    assert.equal(sent.msg.item_list[0].type, 2);
    assert.equal(sent.msg.item_list[0].image_item.media.encrypt_query_param, "image-reference");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
