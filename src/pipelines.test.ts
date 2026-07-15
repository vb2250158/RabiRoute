import assert from "node:assert/strict";
import test from "node:test";
import { normalizePipelineDefinition, resolvePipeline } from "./pipelines.js";

test("fallback pipeline keeps output in the local Agent session", () => {
  const pipeline = resolvePipeline();

  assert.equal(pipeline.outputAdapter, "agent");
  assert.equal(pipeline.outputPipeline, "agent");
  assert.equal(pipeline.replyToSource, false);
});

test("legacy Codex pipeline input normalizes once to canonical Agent output", () => {
  const normalized = normalizePipelineDefinition({
    outputAdapter: "codex",
    outputPipeline: "codex"
  });
  const resolved = resolvePipeline(undefined, {
    outputAdapter: "codex",
    outputPipeline: "codex"
  });

  assert.equal(normalized?.outputAdapter, "agent");
  assert.equal(normalized?.outputPipeline, "agent");
  assert.equal(resolved.outputAdapter, "agent");
  assert.equal(resolved.outputPipeline, "agent");
});

test("wecom_chat preset resolves to bidirectional WeCom markdown chat", () => {
  const pipeline = resolvePipeline("wecom_chat");

  assert.equal(pipeline.inputAdapter, "wecom");
  assert.equal(pipeline.outputAdapter, "wecom");
  assert.equal(pipeline.outputPipeline, "wecom");
  assert.equal(pipeline.promptOutputMode, "markdown");
  assert.equal(pipeline.replyToSource, true);
  assert.equal(pipeline.preventFeedbackLoop, true);
});
