export const ROLE_STORAGE_IDEMPOTENCY_HEADER = "Idempotency-Key" as const;
export const ROLE_STORAGE_REVISION_HEADER = "If-Match" as const;
export const ROLE_STORAGE_REQUEST_TIMEOUT_SECONDS = 12 as const;

function managerMetaEndpoint(resourceEndpoint: string): string {
  const marker = "/api/roles/";
  const markerIndex = resourceEndpoint.indexOf(marker);
  if (markerIndex < 0) return "/meta";
  const managerBaseUrl = resourceEndpoint.slice(0, markerIndex).replace(/\/+$/, "");
  return `${managerBaseUrl}/meta` || "/meta";
}

export function roleStorageMutationContractLines(baseUrl: string): string[] {
  const metaEndpoint = managerMetaEndpoint(baseUrl);
  return [
    `- 每次 GET/POST/PATCH 都设置有界超时（最长 ${ROLE_STORAGE_REQUEST_TIMEOUT_SECONDS} 秒）；写入前先 GET ${metaEndpoint}，保存非空 applicationGenerationId 和 managerInstanceId，任一字段缺失就停止`,
    `- 写入 ${baseUrl} 下的计划、记忆、反馈或整理结果前，先为这一项逻辑操作生成并保存稳定的 Idempotency-Key；请求超时、HTTP 503 或结果不确定时，只能用原请求体和同一个 Idempotency-Key 重试，不得另建重复操作`,
    "- PATCH 计划/近期记忆、POST 计划反馈或回传记忆整理结果前，先 GET 对应单项资源或 feedback，保存响应的强 ETag，并把它原样放入 If-Match；禁止使用 W/ 弱 ETag、* 或 updatedAt 代替存储版本",
    "- HTTP 412 明确表示旧前置版本未提交：废弃旧请求的 Idempotency-Key 和 If-Match，重新 GET 当前事实；原意仍适用时建立并保存新的 Idempotency-Key，配合新强 ETag 提交，禁止重放旧前置版本",
    "- 成功响应必须同时回显与原请求完全相同的 Idempotency-Key、返回强 ETag，并由响应 body 的资源身份确认写中了预期对象；任一项缺失都不能宣布成功",
    `- 收到写入响应后再次以有界超时 GET ${metaEndpoint}；applicationGenerationId 和 managerInstanceId 必须与写入前完全一致，字段缺失、请求失败或切代都视为结果不确定，并保留原请求和 Idempotency-Key 做权威读回或安全重试`,
    "- POST 新计划、新近期记忆或发起记忆整理仍须带稳定 Idempotency-Key，但不带 If-Match；成功响应返回的 Idempotency-Key 与 ETag 是本次操作回执"
  ];
}

export function planFeedbackResponseMutationInstruction(input: {
  endpoint: string;
  planId: string;
  feedbackId: string;
  kind: string;
  scope: string;
}): string {
  const key = `plan-feedback-response:${input.feedbackId}`;
  const metaEndpoint = managerMetaEndpoint(input.endpoint);
  return [
    `开始前以有界超时（最长 ${ROLE_STORAGE_REQUEST_TIMEOUT_SECONDS} 秒）GET ${metaEndpoint}，保存非空 applicationGenerationId 和 managerInstanceId`,
    `完成前以同样的有界超时 GET ${input.endpoint} 并保存响应的强 ETag；随后 POST 同一地址`,
    `headers: Idempotency-Key=${key}、If-Match=<刚才 GET 的强 ETag>`,
    `body: feedbackId=${input.feedbackId}、kind=${input.kind}、author=agent、source=agent、notifyAgent=false，${input.scope}`,
    `只有响应 Idempotency-Key 必须等于请求值、响应 ETag 必须是强 ETag、body 同时满足 data.id=${input.feedbackId} 与 data.planId=${input.planId}，才算命中预期反馈`,
    `POST 返回后再次以有界超时 GET ${metaEndpoint}；applicationGenerationId 和 managerInstanceId 必须与 POST 前完全一致，字段缺失、读取失败或切代均视为结果不确定并保留原 key`,
    "请求超时、HTTP 503、响应丢失或结果不确定时只用相同 body 和同一个 Idempotency-Key 重试，并先做权威读回；不得创建第二条反馈",
    "HTTP 412 明确表示旧版本未提交：废弃旧 Idempotency-Key 与 If-Match，重新 GET 当前反馈和计划；原意仍适用时保存新的 Idempotency-Key 并配合新强 ETag 提交，body 的固定 feedbackId 不变"
  ].join("；");
}

export function memoryConsolidationResultMutationLines(input: {
  endpoint: string;
  runId: string;
}): string[] {
  const metaEndpoint = managerMetaEndpoint(input.endpoint);
  return [
    `结果回传前以有界超时（最长 ${ROLE_STORAGE_REQUEST_TIMEOUT_SECONDS} 秒）GET ${metaEndpoint}，保存非空 applicationGenerationId 和 managerInstanceId`,
    `再以同样的有界超时 GET ${input.endpoint.replace(/\/result$/, "")} 并保存响应的强 ETag`,
    `结果回传 API：${input.endpoint}`,
    `回传 headers：Idempotency-Key=memory-consolidation-result:${input.runId}；If-Match=<整理轮次 GET 的强 ETag>`,
    `成功回执要求响应 Idempotency-Key 必须等于请求值、响应 ETag 必须是强 ETag、body 满足 data.run.id=${input.runId}`,
    `POST 返回后再次以有界超时 GET ${metaEndpoint}；applicationGenerationId 和 managerInstanceId 必须与 POST 前完全一致，字段缺失、读取失败或切代均视为结果不确定并保留原 key`,
    "请求超时、HTTP 503、响应丢失或结果不确定时只允许用相同结果和同一个 Idempotency-Key 重试，并先做权威读回",
    "HTTP 412 明确表示旧版本未提交：废弃旧 Idempotency-Key 与 If-Match，重新 GET 整理轮次；结果仍适用时保存新的 Idempotency-Key 并配合新强 ETag 提交"
  ];
}
