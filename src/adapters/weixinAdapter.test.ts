import assert from "node:assert/strict";
import test from "node:test";
import type { WeixinMessageRecord } from "../history.js";
import { dispatchWeixinRecord } from "./weixinAdapter.js";

function record(patch: Partial<WeixinMessageRecord> = {}): WeixinMessageRecord {
  return {
    time: 1,
    rawMessage: "hello",
    messageId: "weixin-1",
    adapterType: "weixin",
    sessionId: "session-1",
    userId: "user-1",
    senderName: "User",
    messageType: "text",
    ...patch
  };
}

test("personal Weixin forwards text and downloaded images, but records unreadable media", () => {
  const calls: string[] = [];
  const handlers = {
    forward: () => calls.push("forward"),
    recordOnly: () => {
      calls.push("record");
      return 1;
    }
  };

  assert.equal(dispatchWeixinRecord(record(), {}, handlers), "forwarded");
  assert.equal(dispatchWeixinRecord(record({ messageType: "image", rawMessage: "[图片]" }), {}, handlers), "record_only");
  assert.equal(dispatchWeixinRecord(record({
    messageType: "image",
    rawMessage: "[图片附件：C:\\private\\image-0.png]",
    attachments: [{ path: "C:\\private\\image-0.png", name: "image-0.png", mimeType: "image/png", size: 42 }]
  }), {}, handlers), "forwarded");
  assert.deepEqual(calls, ["forward", "record", "forward"]);
});
