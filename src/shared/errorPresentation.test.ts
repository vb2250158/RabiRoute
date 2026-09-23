import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { errorResponsePresentation, presentError } from "./errorPresentation.js";
test("error presentation preserves cause and commit state", () => {
  const text = presentError("disk EACCES: item-17", { reason: "projection_unavailable", commitState: "unknown", requestId: "original" }, "zh-CN");
  assert.match(text, /资源视图暂不可读取/); assert.match(text, /结果未知/); assert.match(text, /EACCES/); assert.match(text, /original/);
});
test("parameter errors retain concrete limits", () => assert.equal(presentError("Plan attachment exceeds 1024 bytes: photo.png.", {}, "zh-CN"), "原因：附件 photo.png 超过 1024 字节。"));
test("error response adds both locales and preserves machine fields", () => {
  const result = errorResponsePresentation({ code: -1, message: "Plan feedback text is required.", retryable: false }, 400) as Record<string, any>;
  assert.equal(result.retryable, false); assert.match(result.errorMessages["zh-CN"], /正文不能为空/); assert.match(result.errorMessages.en, /text is required/); assert.equal(result.reason, "invalid_request");
  const success = { code: 0, data: { message: "user content" } }; assert.equal(errorResponsePresentation(success, 200), success);
});
test("unknown failures retain the original diagnostic", () => assert.match(presentError("vendor-specific-19", {}, "zh-CN"), /vendor-specific-19/));

test("DSH connection failures have specific reasons and Chinese recovery guidance", () => {
  const missing = errorResponsePresentation({ code: -1, message: "DSH authentication configuration has no matching endpoint." }, 400) as Record<string, any>;
  assert.equal(missing.reason, "dsh_connection_configuration");
  assert.match(missing.errorMessages["zh-CN"], /不是当前 Agent 的业务权限不足/);
  assert.ok(!missing.errorMessages["zh-CN"].includes("authentication"));
  assert.match(missing.errorMessages.en, /configuration/);
  const expired = errorResponsePresentation({ code: -1, error: { stage: "request", message: "DSH authentication required or expired. Reconnect DSH in the local RabiRoute WebGUI; this RPC was not replayed.", retryable: false } }, 400) as Record<string, any>;
  assert.equal(expired.reason, "dsh_connection_required");
  assert.match(expired.errorMessages["zh-CN"], /消息路线.*连接 DSH/);
  assert.match(expired.errorMessages["zh-CN"], /没有自动重放/);
  assert.equal(expired.error.retryable, false);
  const denied = errorResponsePresentation({ message: "permission denied" }, 403) as Record<string, any>;
  assert.equal(denied.reason, "forbidden");
});

test("DSH RPC transport failures take precedence over HTTP 400 validation fallback", () => {
  const message = "DSH RPC transport failed; result may be unknown, check the original receipt before retrying.";
  const result = errorResponsePresentation({ code: -1, message, retryable: false }, 400) as Record<string, any>;
  assert.equal(result.reason, "dsh_transport_failed");
  assert.equal(result.message, message);
  assert.equal(result.retryable, false);
  assert.match(result.errorMessages["zh-CN"], /连接传输未完成/);
  assert.match(result.errorMessages["zh-CN"], /不等于请求参数错误或 Agent 业务权限不足/);
  assert.match(result.errorMessages["zh-CN"], /结果可能未知/);
  assert.match(result.errorMessages["zh-CN"], /核对原操作回执.*不要自动重发/);
  assert.doesNotMatch(result.errorMessages["zh-CN"], /请求参数未通过校验|尚未开始|尚未发送业务请求/);
  assert.ok(result.errorMessages.en.includes(message));
  const explicit = errorResponsePresentation({ message, reason: "service_failure" }, 400) as Record<string, any>;
  assert.equal(explicit.reason, "service_failure");
});

test("localized errors do not duplicate an already rendered response", () => {
  assert.equal(presentError("original", { errorMessages: { "zh-CN": "服务忙", en: "Busy" } }, "en"), "Busy");
});
