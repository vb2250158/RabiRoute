import assert from "node:assert/strict";
import test from "node:test";
import {
  memoryConsolidationResultMutationLines,
  planFeedbackResponseMutationInstruction,
  roleStorageMutationContractLines
} from "./roleStorageMutationContract.js";

test("role storage Agent instructions use durable idempotency and strong revision fencing", () => {
  const common = roleStorageMutationContractLines("http://manager/api/roles/YeYu").join("\n");
  assert.match(common, /Idempotency-Key/);
  assert.match(common, /If-Match/);
  assert.match(common, /强 ETag/);
  assert.match(common, /有界超时/);
  assert.match(common, /applicationGenerationId/);
  assert.match(common, /managerInstanceId/);
  assert.match(common, /成功响应.*Idempotency-Key.*强 ETag/);
  assert.match(common, /503.*同一个 Idempotency-Key/);
  assert.match(common, /412.*废弃.*重新 GET.*新.*Idempotency-Key/);

  const feedback = planFeedbackResponseMutationInstruction({
    endpoint: "http://manager/api/roles/YeYu/plans/plan-1/feedback",
    planId: "plan-1",
    feedbackId: "response-feedback-1",
    kind: "guidance_response",
    scope: "只写当前 planId"
  });
  assert.match(feedback, /Idempotency-Key=plan-feedback-response:response-feedback-1/);
  assert.match(feedback, /If-Match=<刚才 GET 的强 ETag>/);
  assert.match(feedback, /GET http:\/\/manager\/meta/);
  assert.match(feedback, /有界超时/);
  assert.match(feedback, /响应 Idempotency-Key 必须等于请求值/);
  assert.match(feedback, /响应 ETag 必须是强 ETag/);
  assert.match(feedback, /data\.id=response-feedback-1/);
  assert.match(feedback, /data\.planId=plan-1/);
  assert.match(feedback, /applicationGenerationId.*managerInstanceId.*完全一致/);
  assert.match(feedback, /503.*同一个 Idempotency-Key/);
  assert.match(feedback, /412.*废弃.*新.*Idempotency-Key/);

  const consolidation = memoryConsolidationResultMutationLines({
    endpoint: "http://manager/api/roles/YeYu/memory/consolidation-runs/run-1/result",
    runId: "run-1"
  }).join("\n");
  assert.match(consolidation, /Idempotency-Key=memory-consolidation-result:run-1/);
  assert.match(consolidation, /If-Match=<整理轮次 GET 的强 ETag>/);
  assert.match(consolidation, /GET http:\/\/manager\/meta/);
  assert.match(consolidation, /有界超时/);
  assert.match(consolidation, /响应 Idempotency-Key 必须等于请求值/);
  assert.match(consolidation, /响应 ETag 必须是强 ETag/);
  assert.match(consolidation, /data\.run\.id=run-1/);
  assert.match(consolidation, /applicationGenerationId.*managerInstanceId.*完全一致/);
  assert.match(consolidation, /503.*同一个 Idempotency-Key/);
  assert.match(consolidation, /412.*废弃.*新.*Idempotency-Key/);
});
