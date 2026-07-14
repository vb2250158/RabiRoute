import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardMessageIdsForTest,
  renderOneBotMessageForTest,
  renderResolvedForwardMessagesForTest
} from "./napcatForwardMessages.js";

test("NapCat forward messages are detected from structured segments and CQ fallback", () => {
  assert.deepEqual(
    forwardMessageIdsForTest(
      [{ type: "forward", data: { id: "forward-1" } }],
      "[CQ:forward,id=forward-2]"
    ),
    ["forward-1", "forward-2"]
  );
});

test("NapCat forwarded message segments preserve text and media evidence", () => {
  assert.equal(
    renderOneBotMessageForTest([
      { type: "text", data: { text: "玩家反馈" } },
      { type: "image", data: { summary: "截图", url: "https://example.invalid/evidence.png" } },
      { type: "video", data: { file: "repro.mp4" } }
    ]),
    "玩家反馈[图片: 截图 https://example.invalid/evidence.png][视频: repro.mp4]"
  );
});

test("NapCat forwarded bundles render sender, time, and message content for Agent context", () => {
  const rendered = renderResolvedForwardMessagesForTest([{
    forwardId: "forward-1",
    nodes: [{
      time: 1_710_000_000,
      userId: 10001,
      senderName: "QA",
      rawMessage: "入口点击后没有反应"
    }]
  }]);

  assert.match(rendered, /合并转发消息 id=forward-1/);
  assert.match(rendered, /QA/);
  assert.match(rendered, /入口点击后没有反应/);
});
