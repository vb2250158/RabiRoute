import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  downloadWeixinMedia,
  pollWeixinQrSession,
  pollWeixinUpdates,
  readWeixinState,
  requestWeixinQrSession,
  sendWeixinFile,
  sendWeixinImage,
  setWeixinTyping,
  startWeixinRealName,
  pollWeixinRealName,
  notifyWeixinConnection,
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
    const images = await downloadWeixinMedia([
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

test("Weixin receives voice, file and video using native CDN references and isolates a failed item", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plain = Buffer.from("fixture media bytes");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ref = (param: string, asciiHex = false) => ({
    encrypt_query_param: param,
    aes_key: (asciiHex ? Buffer.from(key.toString("hex")) : key).toString("base64")
  });
  const calls: string[] = [];
  const attachments = await downloadWeixinMedia([
    { type: 3, voice_item: { media: ref("voice") } },
    { type: 4, file_item: { file_name: "missing.zip", media: ref("failed") } },
    { type: 4, file_item: { file_name: "..\\excerpt.txt", media: ref("file", true) } },
    { type: 5, video_item: { media: ref("video") } }
  ], root, "message-1", async input => {
    const param = new URL(String(input)).searchParams.get("encrypted_query_param")!;
    calls.push(param);
    if (param === "failed") throw new Error("fixture CDN offline");
    return new Response(ciphertext);
  });
  assert.deepEqual(calls, ["voice", "failed", "file", "video"]);
  assert.deepEqual(attachments.map(file => file.name), ["voice-0.silk", "file-2-excerpt.txt", "video-3.mp4"]);
  for (const file of attachments) assert.deepEqual(fs.readFileSync(file.path), plain);
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

test("personal Weixin long polling accepts Fiber cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(new Error("aborted by Fiber")), { once: true });
    });
  };
  try {
    const controller = new AbortController();
    const polling = pollWeixinUpdates(recoverableStateForPoll(), controller.signal);
    controller.abort();
    await assert.rejects(polling, /aborted by Fiber/);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function recoverableStateForPoll() {
  return {
    token: "runtime-token",
    baseUrl: "https://api.example.invalid",
    contextTokens: {},
    authState: "recoverable" as const,
    credentialsRetained: true,
    updatedAt: new Date(0).toISOString()
  };
}

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

test("Weixin official binding, typing and lifecycle use their native endpoints", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-protocol-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { token: "fixture-bot", baseUrl: "https://api.example.invalid",
    contextTokens: { "session-1": "fixture-context" }, updatedAt: new Date(0).toISOString() };
  writeWeixinState(dir, state);
  const videoPath = path.join(dir, "fixture.mp4");
  fs.writeFileSync(videoPath, "test-video");
  const seen: Array<{ url: URL; method: string; body: Record<string, any> }> = [];
  const ticket = "a".repeat(32);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    seen.push({ url, method: init?.method ?? "GET", body });
    if (url.searchParams.get("step") === "get_auth_url") return Response.json({ data: {
      bot_spam_ticket: ticket, auth_url: "liteapp://fixture", expire_time: Math.floor(Date.now() / 1000) + 600
    } });
    if (url.searchParams.get("step") === "query_auth_result") return Response.json({ auth_status: 1 });
    if (url.pathname.endsWith("get_bot_qrcode")) return Response.json({ qrcode: "fixture-code", qrcode_img_content: "https://example.invalid/qr" });
    if (url.pathname.endsWith("get_qrcode_status")) return Response.json({ status: "confirmed" });
    if (url.pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "fixture-typing-ticket" });
    if (url.pathname.endsWith("getuploadurl")) return Response.json({ ret: 0, upload_full_url: "https://example.invalid/upload" });
    if (url.pathname === "/upload") return new Response(null, { headers: { "x-encrypted-param": "fixture-download-ref" } });
    return Response.json({ ret: 0 });
  };
  try {
    const signal = new AbortController().signal;
    const auth = await startWeixinRealName(signal);
    assert.equal(auth.ticket, ticket);
    assert.equal(await pollWeixinRealName(ticket, signal), 1);
    const session = await requestWeixinQrSession(state.baseUrl, "3", signal, auth.ticket);
    session.pollBaseUrl = "https://redirect.weixin.qq.com";
    await pollWeixinQrSession(state.baseUrl, session, signal, "012345");
    assert.equal(seen[2].method, "POST");
    assert.deepEqual(seen[2].body, { local_token_list: [], bot_spam_ticket: ticket });
    assert.equal(seen[3].url.host, "redirect.weixin.qq.com");
    assert.equal(seen[3].url.searchParams.get("verify_code"), "012345");
    await setWeixinTyping(dir, "session-1", true);
    await setWeixinTyping(dir, "session-1", false);
    assert.equal(seen[4].body.context_token, "fixture-context");
    assert.equal(seen[5].body.typing_ticket, "fixture-typing-ticket");
    assert.deepEqual([seen[5].body.status, seen[7].body.status], [1, 2]);
    await notifyWeixinConnection(state, true, signal);
    await notifyWeixinConnection(state, false, signal);
    assert.deepEqual(seen.slice(8, 10).map(call => call.url.pathname), ["/ilink/bot/msg/notifystart", "/ilink/bot/msg/notifystop"]);
    await sendWeixinFile(dir, "session-1", videoPath, "fixture.mp4", "delivery-video");
    assert.equal(seen[10].body.media_type, 2);
    assert.equal(seen[12].body.msg.item_list[0].type, 5);
    assert.equal(seen[12].body.msg.item_list[0].video_item.video_size, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
