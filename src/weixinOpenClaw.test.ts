import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readWeixinState,
  textFromWeixinItems,
  weixinApiError,
  weixinApiSucceeded,
  writeWeixinState
} from "./weixinOpenClaw.js";

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

test("personal Weixin state round-trips runtime tokens only in the runtime directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-"));
  try {
    writeWeixinState(tempDir, {
      token: "runtime-token",
      accountId: "account-1",
      userId: "user-1",
      baseUrl: "https://example.invalid",
      syncBuf: "cursor-1",
      contextTokens: { "session-1": "context-1" },
      updatedAt: new Date(0).toISOString()
    });
    const state = readWeixinState(tempDir);
    assert.equal(state.token, "runtime-token");
    assert.equal(state.contextTokens["session-1"], "context-1");
    assert.equal(state.baseUrl, "https://example.invalid");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("personal Weixin API status uses both ret and errcode", () => {
  assert.equal(weixinApiSucceeded({ ret: 0, errcode: 0 }), true);
  assert.equal(weixinApiSucceeded({ ret: 0, errcode: -14 }), false);
  assert.match(weixinApiError({ ret: 1, errcode: 2, errmsg: "bad" }), /ret=1, errcode=2, errmsg=bad/);
});
