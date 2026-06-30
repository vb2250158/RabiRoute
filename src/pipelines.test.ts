import assert from "node:assert/strict";
import test from "node:test";
import { resolvePipeline } from "./pipelines.js";

test("wecom_chat preset resolves to bidirectional WeCom markdown chat", () => {
  const pipeline = resolvePipeline("wecom_chat");

  assert.equal(pipeline.inputAdapter, "wecom");
  assert.equal(pipeline.outputAdapter, "wecom");
  assert.equal(pipeline.outputPipeline, "wecom");
  assert.equal(pipeline.promptOutputMode, "markdown");
  assert.equal(pipeline.replyToSource, true);
  assert.equal(pipeline.preventFeedbackLoop, true);
});
