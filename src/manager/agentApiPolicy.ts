import { getAgentUploadContract, type AgentUploadMachineContract } from "./agentUploadContract.js";

export type AgentApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AgentApiHelp = Readonly<{
  operationId: string;
  method: AgentApiMethod;
  pathTemplate: string;
  description: string;
  queryParameters: readonly string[];
  repeatableQueryParameters: readonly string[];
  limitations: readonly string[];
  request: Readonly<{ body: string; query: string; path: string }>;
  response: string;
  machineReadable?: AgentUploadMachineContract;
  errors: readonly string[];
  nextStep: string;
  auth: Readonly<{ required: boolean | null; source: string; scopes: readonly string[] }>;
  effects: Readonly<{ mode: "readOnly" | "mutating" | "unknown"; sideEffects: string }>;
  idempotency: Readonly<{ required: boolean | null; retryRule: string }>;
  contractResourceId: string;
  contractLevel: "baseline" | "verified";
  auditLevel: "none" | "implementation-summary";
  coverage: Readonly<{ exactRequestSchema: boolean; exactResponseSchema: boolean; missing: readonly string[] }>;
}>;

export type AgentApiOperation = Readonly<{
  id: string;
  method: AgentApiMethod;
  pathTemplate: string;
  description: string;
  contractResourceId: string;
  queryParameters: readonly string[];
  repeatableQueryParameters: readonly string[];
  limitations: readonly string[];
  help: AgentApiHelp;
}>;

export type AgentApiAuthorization =
  | { allowed: true; operation: AgentApiOperation }
  | { allowed: false; reason: "invalid_method" | "invalid_path" | "query_credentials" | "query_not_allowed" | "operation_not_allowed" };

type Definition = readonly [AgentApiMethod, string, string, string?, string?];
const contractResourceId = "docs/rabi-agent-interfaces.md";
const handlerBoundary = "仅授予业务入口；不替代处理器的对象权限、Action Gate、来源身份、文件根、幂等键及版本校验。";
const loopbackBoundary = "现有处理器仅允许 loopback；目录收录不代表已支持远端调用，不得代理为本机绕过。";

// This is trusted, reviewed policy, not mutable plugin configuration. New plugin routes do not grant authority.
function operations(group: string, prefix: string, definitions: readonly Definition[], limitations: readonly string[] = []): AgentApiOperation[] {
  return definitions.map(([method, suffix, description, query = "", repeatable = ""]) => {
    const pathTemplate = `${prefix}${suffix}`;
    const id = `${group}:${method}:${pathTemplate}`;
    const queryParameters = Object.freeze(query.split(" ").filter(Boolean));
    const repeatableQueryParameters = Object.freeze(repeatable.split(" ").filter(Boolean));
    const auditedSummary = pathTemplate === "/api/agent/send" && method === "POST"
      ? {
          requestBody: "JSON 对象：deliveryId、sender { agentType, sessionId }、routeId、channel、params、payload；Content-Type 与发送渠道参数以 send capabilities 为准。",
          response: "成功为 code=0 且包含 send result；202 仅表示 Manager 接受，平台最终送达须读取 receipt/traces。",
          auth: "请求来源和 sender 权限由 Manager/Route 处理器核验；远端 trusted source 缺失时 fail closed。",
          effects: "高风险外发：可能向外部消息渠道发送内容；不代表平台最终回执。",
          retry: "deliveryId 是稳定幂等键；超时、5xx、切代或 uncertain 时只读取同 deliveryId 回执，不改 ID、渠道或自动重放。", mutating: true, idempotencyRequired: true
        }
      : pathTemplate === "/api/agent/uploads/:uploadId"
        ? {
            requestBody: method === "PUT" ? "application/octet-stream；必须使用 UUID uploadId、同值 Idempotency-Key、x-rabiroute-content-sha256 和 URI 编码文件名；禁止 content-encoding。" : "GET 无请求体。",
            response: "PUT 成功返回 code=0、data { id, fileName, size, sha256, expiresAt }；GET 返回当前上传回执/资源。",
            auth: "必须由当前已认证 Agent trusted source 访问，并在开始、提交和读取阶段复核 owner 与权限。",
            effects: method === "PUT" ? "只保存受管文件，不自动外发；后续发送必须显式引用 fileId/fileSha256。" : "只读取受管上传状态。",
              retry: "uploadId 与 Idempotency-Key 必须稳定且相同；不确定时先 GET 同一 uploadId，不改 ID、不自动重传。", mutating: method === "PUT", idempotencyRequired: method === "PUT"
          }
        : pathTemplate === "/api/agent/xiaomi-home/action-requests" && method === "POST"
          ? {
              requestBody: "JSON：requestId?、resourceId、capability、arguments?、expectedStateVersion、reason?、dryRun?；必须携带稳定 Idempotency-Key，并携带当前 application-generation/manager-instance fence。",
              response: "202 返回 code=0 与 action receipt；planned/succeeded/failed/uncertain 是不同状态，不能把接受当作设备完成。",
              auth: "仅受 loopback/control-plane 门禁及生命周期 fence 允许；设备资源权限和 Action Gate 仍由 Xiaomi Home 执行层核验。",
              effects: "可能调用家庭设备服务并执行状态变更；dryRun 或 writeEnabled=false 只产生 planned。",
              retry: "相同 key 只读恢复既有 receipt；状态版本变化、in_progress 或 uncertain 时先读回，禁止自动重发。", mutating: true, idempotencyRequired: true
            }
          : undefined;
    const machineReadable = getAgentUploadContract(method, pathTemplate);
    const operation = {
      id, method, pathTemplate, description, contractResourceId,
      queryParameters,
      repeatableQueryParameters,
      limitations: Object.freeze([handlerBoundary, ...limitations]),
      help: undefined as unknown as AgentApiHelp
    };
    operation.help = Object.freeze({
      operationId: id, method, pathTemplate, description,
      queryParameters, repeatableQueryParameters,
      limitations: operation.limitations,
      request: Object.freeze({
        body: auditedSummary?.requestBody ?? (method === "GET" ? "无请求体；按 path/queryParameters 传参。" : "请求体格式尚未在 Help 核验；先查 contractResourceId 的对应接口，包括 Content-Type。不要假定为 JSON，也不要把凭据放进 query。"),
        query: queryParameters.length ? `允许：${queryParameters.join(", ")}。` : "不接受 query 参数。",
        path: "只传相对路径；先从当前 Manager 能力目录取得真实 pathTemplate。"
      }),
      response: auditedSummary?.response ?? "以 HTTP 状态码和 JSON code/data 或 error 为准；不要把网络可达当作业务成功。",
      errors: Object.freeze(["400：参数或业务合同错误；按 error/help/repair 修正。", "401/403：身份、权限或 Agent 启停被拒绝。", "404：资源或接口不存在，重新读取当前能力目录。", "412/5xx/超时：先读回资源或回执，不自动重放写入。"]),
      nextStep: method === "GET" ? "根据返回的 data/coverage 判断结果；空结果不等于系统没有数据。" : "保存原请求体和幂等键；不确定时先查询回执或资源状态。",
      auth: Object.freeze({ required: auditedSummary ? true : null, source: auditedSummary?.auth ?? "当前目录仅说明 Agent 入口；实际身份、对象权限和 Action Gate 以处理器及当前请求来源为准。", scopes: Object.freeze(["agent-api-entry"]) }),
      effects: Object.freeze({ mode: auditedSummary?.mutating ? "mutating" : auditedSummary ? "readOnly" : "unknown", sideEffects: auditedSummary?.effects ?? "未从统一目录核验；不得依据 HTTP 方法推断无副作用或必然写入。" }),
      idempotency: Object.freeze({ required: auditedSummary?.idempotencyRequired ?? (auditedSummary ? false : null), retryRule: auditedSummary?.retry ?? "幂等要求尚未逐接口核验；发生超时、5xx、412 或切代时保留原请求和原键，先读回回执/资源，不自动重放。" }),
      contractResourceId,
      contractLevel: "baseline",
       auditLevel: auditedSummary ? "implementation-summary" : "none",
      ...(machineReadable ? { machineReadable } : {}),
      coverage: Object.freeze({ exactRequestSchema: false, exactResponseSchema: false, missing: machineReadable?.missing ?? Object.freeze(["request-body-schema", "response-schema"]) })
    });
    return Object.freeze(operation);
  });
}

// Only aliases actually accepted by handleRoleKnowledgeApi and its delegated handlers are expanded.
const roleKnowledge: readonly Definition[] = [
  ["GET", "/counts", "读取人格知识数量"],
  ["GET", "/plans", "查询计划目录与分页", "limit cursor detail view sort query status tag facets", "status tag"],
  ["GET", "/plans/:planId", "读取计划及强 ETag", "detail"],
  ["POST", "/plans", "新增计划（含受管附件与任务绑定）"],
  ["PATCH", "/plans/:planId", "更新计划（保留版本及幂等合同）"],
  ["GET", "/plans/:planId/history", "读取计划历史"],
  ["GET", "/plans/:planId/feedback", "读取计划反馈及版本"],
  ["POST", "/plans/:planId/feedback", "提交计划反馈"],
  ["GET", "/plan-statuses", "读取人格计划状态目录"],
  ["POST", "/plan-statuses", "创建人格计划状态"],
  ["PATCH", "/plan-statuses/:statusKey", "修改人格计划状态"],
  ["DELETE", "/plan-statuses/:statusKey", "替换并退役人格计划状态"],
  ["GET", "/plan-marker-statuses", "读取兼容计划状态目录"],
  ["POST", "/plan-marker-statuses", "通过兼容入口创建计划状态"],
  ["PATCH", "/plan-marker-statuses/:statusKey", "通过兼容入口修改计划状态"],
  ["DELETE", "/plan-marker-statuses/:statusKey", "通过兼容入口退役计划状态"],
  ["GET", "/skills", "列出人格技能"],
  ["GET", "/skills/:skillId", "读取人格技能"],
  ["GET", "/skills/:skillId/download", "下载指定人格技能完整目录ZIP；仍需人格绑定，不执行脚本"],
  ["GET", "/memory", "读取记忆概览、数量或分页", "counts limit cursor kind query"],
  ["GET", "/memory/recent", "列出近期记忆"],
  ["GET", "/memory/recent/:memoryId", "读取近期记忆（可能刷新 viewedAt）"],
  ["POST", "/memory/recent", "新增近期记忆"],
  ["PATCH", "/memory/recent/:memoryId", "更新近期记忆"],
  ["GET", "/memory/consolidated", "列出沉淀记忆"],
  ["GET", "/memory/consolidated/:memoryId", "读取沉淀记忆"],
  ["GET", "/memory/consolidation-runs", "列出记忆整理运行"],
  ["GET", "/memory/consolidation-runs/:runId", "读取记忆整理运行及版本"],
  ["POST", "/memory/consolidation-requests", "请求记忆整理"],
  ["POST", "/memory/consolidation-runs/:runId/result", "提交记忆整理结果"],
  ["GET", "/knowledge-validation", "读取已发布知识校验结果"],
  ["GET", "/identity-relations", "读取身份关系或账号上下文", "platform endpointIdentityNamespace senderStableId conversationKey projectId"],
  ["PUT", "/identity-relations", "维护人格身份关系；确认不构成执行授权"],
  ["POST", "/identity-relations/observations", "提交候选身份线索"],
  ["GET", "/voice-identities", "读取人格声纹身份", "sourceHostId voiceprintId"],
  ["PUT", "/voice-identities", "维护人格声纹身份"],
  ["GET", "/voice-transcripts", "查询人格语音转写", "limit includeArchives includeDetails speaker from to"],
  ["GET", "/chat-history", "读取 Agent 最终回复历史", "cursor limit"],
  ["GET", "/conversation-situations", "读取情景记录", "limit"],
  ["GET", "/conversation-situations/:situationId", "读取单项情景记录", "limit"],
  ["GET", "/health", "读取健康摘要兼容入口", "sourceDeviceId from to limit"],
  ["GET", "/health/state", "读取健康状态与时效", "sourceDeviceId"],
  ["GET", "/health/history", "查询健康观测历史", "sourceDeviceId metric from to limit order", "metric"],
  ["GET", "/health/summary", "读取健康摘要", "sourceDeviceId from to limit"],
  ["GET", "/health/config", "读取人格健康业务配置"],
  ["PATCH", "/health/config", "更新人格健康业务配置"],
  ["POST", "/health/observations", "提交健康观测"]
];

const catalog: readonly AgentApiOperation[] = Object.freeze([
  ...operations("knowledge", "/api/roles/:roleId", roleKnowledge),
  ...operations("knowledge-alias", "/roles/:roleId", roleKnowledge),
  ...operations("persona", "/api/roles/:roleId", [
    ["GET", "/knowledge/search", "按关键词或全文检索知识", "query mode kind archived limit cursor"],
    ["GET", "/knowledge/cache/status", "读取知识索引状态"],
    ["POST", "/knowledge/cache/reload", "刷新指定知识索引"],
    ["GET", "/message-endpoint-history", "检索消息端历史", "query match adapter channel kind sender target conversationKey from to includeArchives limit maxChars"],
    ["GET", "/role-panel/messages", "读取人格消息时间线", "limit"],
    ["GET", "/persona-document", "读取固定 persona.md；不开放 file 参数"],
    ["GET", "/plans/:planId/attachments/:attachmentId", "读取受管计划附件"],
    ["GET", "/plan-agents/status", "读取计划绑定 Agent 的状态", "planId", "planId"]
  ]),
  ...operations("agent", "", [
    ["GET", "/meta", "核对 Manager 健康与 generation"],
    ["GET", "/api/personas", "发现人格与可投递 Route", "addressable"],
    ["GET", "/api/personas/:personaId", "读取人格投递信息"],
    ["POST", "/api/personas/:personaId/messages", "通过来源能力跨人格投递"],
    ["GET", "/api/personas/messages/receipts/:deliveryId", "读取跨人格投递回执"],
    ["GET", "/api/agent/threads", "列出 Agent 会话", "query limit offset"],
    ["POST", "/api/agent/threads", "发现、读取、创建、命名与单向投递会话；远端来源仅支持 responsePolicy:none，不支持正式回复或跨远端投递"],
    ["PUT", "/api/agent/uploads/:uploadId", "上传当前远端 Agent 的受管文件，不自动外发"],
    ["GET", "/api/agent/uploads/:uploadId", "核对当前远端 Agent 的文件上传回执"],
    ["GET", "/api/agent/help", "按 operationId、方法或路径查询当前接口帮助", "operationId path method"],
    ["GET", "/api/agent/send/capabilities", "列出发送渠道、参数示例与不重试规则"],
    ["POST", "/api/agent/send", "通过渠道策略发送消息或受管附件"],
    ["GET", "/api/agent/send/traces", "按平台消息追踪发送", "channel sentMessageId routeId"],
    ["GET", "/api/agent/send/receipts/:deliveryId", "读取渠道发送回执"],
    ["GET", "/api/agent/requests", "列出 Agent 回复请求", "status"],
    ["GET", "/api/agent/requests/:requestId", "读取 Agent 回复请求"],
    ["POST", "/api/agent/requests/:requestId/cancel", "取消不再需要的回复请求"],
    ["POST", "/api/agent-state", "提交 Agent 业务状态"],
    ["GET", "/api/agent-adapters/catalog", "读取 Agent 适配器业务能力目录"],
    ["GET", "/api/remote-agent/devices", "读取远端 Agent 设备与任务"],
    ["GET", "/api/remote-agent/tasks", "列出远端 Agent 任务"],
    ["POST", "/api/remote-agent/tasks", "向已授权远端 Agent 创建任务"]
  ]),
  ...operations("processing", "/api/message-processing", [
    ["GET", "/board", "查询消息处理看板", "routeId limit"],
    ["POST", "/requirements", "提交消息分派结果；入站 register_group 仅由 Manager 执行"],
    ["GET", "/requirements/:requirementId", "读取消息处理需求"],
    ["GET", "/requirements/:requirementId/send-context", "读取发送前上下文审阅", "sourceMessageId"],
    ["POST", "/requirements/:requirementId/send-context", "提交发送前上下文审阅"],
    ["POST", "/requirements/:requirementId/outcome", "提交消息处理结果"],
    ["POST", "/requirements/:requirementId/knowledge-callback", "提交知识核对与更新回执"]
  ]),
  // Generic codex-hook handlers do not bind requests to an authenticated principal.
  // Remote hooks must use the separately authorized own-Agent /api/lan-agent/.../context endpoint.
  ...operations("speech", "/api/speech", [
    ["GET", "/status", "读取语音服务状态"],
    ["GET", "/events", "订阅语音业务事件"],
    ["GET", "/models", "列出已提供的语音模型"],
    ["GET", "/personas", "列出语音人格"],
    ["GET", "/speakers", "查询说话人目录", "sessionId"],
    ["POST", "/speakers", "创建说话人档案"],
    ["PATCH", "/speakers/:speakerId", "更新说话人档案"],
    ["DELETE", "/speakers/:speakerId", "删除说话人档案"],
    ["PUT", "/speaker-bindings", "绑定说话人"],
    ["DELETE", "/speaker-bindings", "解除说话人绑定", "sessionId recordId speakerLabel"],
    ["PUT", "/speaker-identities", "标注说话人身份"],
    ["GET", "/playback/status", "读取播放队列状态"],
    ["PUT", "/playback/volume", "调整语音播放音量"],
    ["POST", "/playback/stop", "停止语音播放"],
    ["GET", "/records", "检索语音记录", "limit kind sessionId routeId since until sourceDeviceId before"],
    ["GET", "/records/:recordId/audio", "读取受管语音记录音频"],
    ["POST", "/tts", "执行语音合成"],
    ["POST", "/asr", "转写上传的音频"],
    ["GET", "/messages", "查询语音消息及投递回执", "recordId limit sourceDeviceId messageAdapterType before"],
    ["POST", "/messages", "提交语音消息"]
  ]),
  ...operations("bilibili-history", "/api/bilibili-history", [
    ["GET", "/status", "读取历史采集桥状态（不含凭据）"],
    ["GET", "/roles/:roleId/days", "列出持久浏览历史日期"],
    ["GET", "/roles/:roleId/days/:date", "读取单日浏览历史", "offset limit"],
    ["POST", "/jobs", "请求已配对桥采集历史"],
    ["GET", "/jobs/:historyJobId", "读取历史采集任务"]
  ]),
  ...operations("video", "/api/video", [
    ["GET", "/status", "读取媒体生成状态"],
    ["GET", "/jobs", "列出媒体任务"],
    ["POST", "/jobs", "提交媒体生成任务"],
    ["GET", "/jobs/:mediaId", "读取媒体任务"],
    ["POST", "/jobs/:mediaId/cancel", "取消媒体生成任务"],
    ["GET", "/jobs/:mediaId/video", "读取生成视频"],
    ["GET", "/jobs/:mediaId/image", "读取生成图像"],
    ["POST", "/assets", "上传媒体素材", "kind"],
    ["GET", "/assets/:mediaId", "读取媒体素材或元数据", "metadata"],
    ["GET", "/projects", "列出媒体项目"],
    ["POST", "/projects", "创建媒体项目"],
    ["GET", "/projects/:mediaId", "读取媒体项目"],
    ["PUT", "/projects/:mediaId", "按版本保存媒体项目"]
  ]),
  ...operations("gamer", "/api/agent/yeyu-gamer", [
    ["GET", "/health", "读取受支持游戏集成健康"],
    ["GET", "/meta", "读取受支持游戏集成合同"],
    ["GET", "/snapshot", "读取受支持游戏集成快照"],
    ["GET", "/capabilities", "读取受支持游戏集成能力"],
    ["POST", "/work-items", "创建 plan-only 游戏工作项"]
  ], [loopbackBoundary]),
  ...operations("home", "/api/agent/xiaomi-home", [
    ["GET", "/resources", "列出已授权家庭设备资源"],
    ["GET", "/resources/:resourceId", "读取已授权家庭设备资源"],
    ["POST", "/action-requests", "向已授权设备提交受控动作"],
    ["POST", "/events", "提交家庭设备业务事件"],
    ["GET", "/artifacts", "查询受管家庭媒体记录", "resourceId eventKind"],
    ["GET", "/artifacts/lifecycle", "读取家庭媒体生命周期合同"],
    ["GET", "/artifacts/:artifactId", "读取家庭媒体记录"],
    ["GET", "/artifacts/:artifactId/content", "读取受管家庭媒体内容"]
  ], [loopbackBoundary])
]);

/** The same immutable catalog drives both discovery and enforcement; availability is still owned by plugins. */
export function listAgentApiOperations(): readonly AgentApiOperation[] { return catalog; }

const credentialKey = /(?:token|authorization|credential|password|secret|cookie|apikey|accesskey|capability|signature)/i;
const parameterPatterns: Readonly<Record<string, RegExp>> = Object.freeze({
  date: /^\d{4}-\d{2}-\d{2}$/,
  uploadId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  historyJobId: /^[0-9a-f-]+$/,
  mediaId: /^[0-9a-f-]{36}$/
});

function safeSegment(raw: string): string | undefined {
  try {
    const decoded = decodeURIComponent(raw);
    // One decoding only. Reject separators, ADS, residual escapes, dot aliases and Windows device names.
    if (!decoded || decoded.length > 512 || decoded.trim() !== decoded || decoded.startsWith(".") || decoded.endsWith(".")
      || /[\s]$/.test(decoded) || !/^[\p{L}\p{N}_ .@-]+$/u.test(decoded)
      || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(decoded)) return undefined;
    return decoded;
  } catch { return undefined; }
}

const matchers = catalog.map(operation => ({ operation, segments: operation.pathTemplate.slice(1).split("/") }));

/**
 * Call only after authenticating an explicitly enabled Agent principal. Pass the ORIGINAL origin-form
 * request.url, before URL normalization; never a decoded pathname or an absolute URL. No I/O or body parsing.
 * A successful decision is an entry-point permission, not evidence that a business action was authorized or ran.
 */
export function validateAgentApiRequestTarget(method: string, requestTarget: string):
  | { allowed: true; rawSegments: string[]; decodedSegments: (string | undefined)[]; query: string[] }
  | Extract<AgentApiAuthorization, { allowed: false }> {
  if (typeof method !== "string" || !/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(method)) return { allowed: false, reason: "invalid_method" };
  if (typeof requestTarget !== "string" || requestTarget.length > 16_384 || !requestTarget.startsWith("/")
    || requestTarget.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(requestTarget)) return { allowed: false, reason: "invalid_path" };
  const separator = requestTarget.indexOf("?");
  const pathname = separator < 0 ? requestTarget : requestTarget.slice(0, separator);
  const rawSegments = pathname.slice(1).split("/");
  const decodedSegments = rawSegments.map(safeSegment);
  if (decodedSegments.some(segment => segment === undefined)) return { allowed: false, reason: "invalid_path" };

  const query: string[] = [];
  if (separator >= 0) {
    const rawQuery = requestTarget.slice(separator + 1);
    if (!rawQuery || rawQuery.split("&").length > 128) return { allowed: false, reason: "query_not_allowed" };
    for (const field of rawQuery.split("&")) {
      const equals = field.indexOf("=");
      if (equals <= 0) return { allowed: false, reason: "query_not_allowed" };
      try {
        const key = decodeURIComponent(field.slice(0, equals).replace(/\+/g, " "));
        const value = decodeURIComponent(field.slice(equals + 1).replace(/\+/g, " "));
        if (credentialKey.test(key.replace(/[^a-z0-9]/gi, ""))) return { allowed: false, reason: "query_credentials" };
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || /[\x00-\x1f\x7f]/.test(value)) return { allowed: false, reason: "query_not_allowed" };
        query.push(key);
      } catch { return { allowed: false, reason: "invalid_path" }; }
    }
  }

  return { allowed: true, rawSegments, decodedSegments, query };
}

/** Public operation catalog policy; request authentication is a separate boundary. */
export function authorizeAgentApiOperation(method: string, requestTarget: string): AgentApiAuthorization {
  const target = validateAgentApiRequestTarget(method, requestTarget);
  if (!target.allowed) return target;
  const { rawSegments, decodedSegments, query } = target;
  const match = matchers.find(({ operation, segments }) => operation.method === method
    && segments.length === rawSegments.length && segments.every((segment, index) => {
      if (!segment.startsWith(":")) return segment === rawSegments[index];
      const pattern = parameterPatterns[segment.slice(1)];
      return !pattern || pattern.test(decodedSegments[index]!);
    }));
  if (!match) return { allowed: false, reason: "operation_not_allowed" };
  const seen = new Set<string>();
  for (const key of query) {
    if (!match.operation.queryParameters.includes(key)
      || (seen.has(key) && !match.operation.repeatableQueryParameters.includes(key))) return { allowed: false, reason: "query_not_allowed" };
    seen.add(key);
  }
  return { allowed: true, operation: match.operation };
}
