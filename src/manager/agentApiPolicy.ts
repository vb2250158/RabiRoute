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

type Definition = readonly [AgentApiMethod, string, string, string?, string?, (readonly string[])?];
const contractResourceId = "docs/rabi-agent-interfaces.md";
const handlerBoundary = "鉴权后的连接可使用已提供的接口；请求仍需符合来源身份、文件路径、幂等键及版本合同。";

// This catalog describes reviewed contracts; connection authentication is enforced separately.
function operations(group: string, prefix: string, definitions: readonly Definition[], limitations: readonly string[] = []): AgentApiOperation[] {
  return definitions.map(([method, suffix, description, query = "", repeatable = "", operationLimitations = []]) => {
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
      : method === "POST" && ["/api/agent/send/receipts/:deliveryId/verify", "/api/agent/send/receipts/:deliveryId/settle"].includes(pathTemplate)
        ? {
            requestBody: "JSON 仅含 originalRequest: AgentSendRequest；原 deliveryId 必须与路径一致。禁止客户端证据、verifier、result 或当前账号覆盖。",
            response: "返回可信维护处理器的核验或结算结果；缺少能力时 503 失败关闭，不调用 send。",
            auth: "计划绑定非必须；必须核验调用身份、原发送者、原 Route 和完整原请求绑定。trusted LAN 来源仅从认证请求提取。",
            effects: pathTemplate.endsWith("/verify") ? "只读可信证据核验；不 deliver、不 retry、不改回执。" : "仅对原 deliveryId 进行受控结算；不 deliver、不 retry、不创建新投递。",
            retry: "保留原 deliveryId 和完整原请求；不确定时读取原回执，禁止自动外发重试。",
            mutating: pathTemplate.endsWith("/settle"), idempotencyRequired: true
          }
      : pathTemplate.startsWith("/api/desktop-pet/roles/") && pathTemplate.includes("/motion")
        ? {
            requestBody: method === "POST" ? 'JSON: requestId (8-128 ASCII ID), mode? (auto/walk/teleport), target: {kind:"position",x,y} or {kind:"screen-corner",corner,screenName?} or {kind:"active-window",corner}. Idempotency-Key must equal requestId.' : "No body; use the original requestId.",
            response: "code=0, data: receipt. accepted/running is not arrival. succeeded includes position and destination in logical desktop pixels; failed/cancelled/uncertain retains the reason. Receipts remain one hour within the same Manager generation.",
            auth: "Reuse Manager connection authentication. Runtime claim/acknowledgment endpoints are excluded from Agent tools.",
            effects: method === "POST" ? "Moves only the enabled desktop pet using its existing animations; user drag/hide/lock takes precedence. Does not focus or move application windows or change wander settings." : "Read-only motion receipt.",
            retry: "Keep requestId, body and generation; query the original receipt before retrying. Same ID/body never repeats movement; different body returns 409. A missing receipt after restart/expiry is unknown, not permission to replay.",
            mutating: method === "POST", idempotencyRequired: method === "POST"
          }
      : pathTemplate === "/api/agent/qq/diagnostics" && method === "GET"
        ? {
            requestBody: "无请求体；必须传唯一非空 routeId query。",
            response: "仅返回所选 Route 的唯一已启用 QQ 实例 ID、WS 连接布尔值与 OneBot online/good 布尔值；探针失败不表示离线。",
            auth: "可信本机与已认证启用 Agent 权限对等；远端使用原始授权 lease 并在探针前后复验，仍核对精确 Route 和唯一已启用 QQ 实例。",
            effects: "只读当前 Route 的 WS 状态，并在授权后对其唯一实例发起短时 OneBot GET get_status；不读取消息或写入状态。",
            retry: "只读无幂等键；探针不可用时显示未知，不自动切换 Route 或实例。", mutating: false, idempotencyRequired: false
          }
      : pathTemplate === "/api/agent/qq/group-files" && method === "GET"
         ? {
             requestBody: "无请求体；必须传唯一非空 routeId、groupId，folderId 可选且至多一次。",
             response: "返回选定群的有界文件/文件夹元数据；completenessUnknown 与 potentiallyTruncated 表示不可据此证明文件不存在。",
             auth: "可信本机与已认证启用 Agent 权限对等；核对精确 Route 与唯一 QQ 实例。readableGroupFileIds 未设置时允许读取；显式列表只允许所列精确群 ID，空列表禁用群文件读取。",
             effects: "只读所选 QQ 实例的 get_group_root_files 或 get_group_files_by_folder；不下载、不发送文件。",
             retry: "只读无幂等键；结果不完整时不据此去重，授权或实例不可用时不跨 Route 回退。", mutating: false, idempotencyRequired: false
           }
       : pathTemplate === "/api/agent/uploads/:uploadId"
        ? {
            requestBody: method === "PUT" ? "application/octet-stream；必须使用 UUID uploadId、同值 Idempotency-Key、x-rabiroute-content-sha256 和 URI 编码文件名；禁止 content-encoding。" : "GET 无请求体。",
            response: "PUT 成功返回 code=0、data { id, fileName, size, sha256, expiresAt }；GET 返回当前上传回执/资源。",
            auth: "必须由当前已认证 Agent trusted source 访问，并在开始、提交和读取阶段复核 owner 与权限。",
            effects: method === "PUT" ? "只保存上传文件，不自动外发；后续发送必须显式引用 fileId/fileSha256。" : "只读取上传状态。",
              retry: "uploadId 与 Idempotency-Key 必须稳定且相同；不确定时先 GET 同一 uploadId，不改 ID、不自动重传。", mutating: method === "PUT", idempotencyRequired: method === "PUT"
          }
        : pathTemplate === "/api/agent/xiaomi-home/action-requests" && method === "POST"
          ? {
              requestBody: "JSON：requestId?、resourceId、capability、arguments?、expectedStateVersion、reason?、dryRun?；必须携带稳定 Idempotency-Key，并携带当前 application-generation/manager-instance fence。",
              response: "202 返回 code=0 与 action receipt；planned/accepted/succeeded/failed/uncertain 是不同状态。accepted 仅证明服务受理，succeeded 仅证明状态读回；不证明已听到声音。简化能力从 capabilities 获取，home.entity.action@1 的 argumentsSchema 与 revision 从 entity-actions 或 resources?includeActions=1 获取；回执通过 GET action-requests?idempotencyKey 查询。",
              auth: "复用 Manager 连接鉴权；执行层校验设备能力、参数、状态版本、幂等键及当前 Manager 身份。",
              effects: "可能调用家庭设备服务并执行状态变更；dryRun 只产生 planned。",
              retry: "相同 key 只读恢复既有 receipt；状态版本变化、in_progress 或 uncertain 时先读回，禁止自动重发。", mutating: true, idempotencyRequired: true
            }
          : undefined;
    const machineReadable = getAgentUploadContract(method, pathTemplate);
    const operation = {
      id, method, pathTemplate, description, contractResourceId,
      queryParameters,
      repeatableQueryParameters,
      limitations: Object.freeze([handlerBoundary, ...limitations, ...operationLimitations]),
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
      auth: Object.freeze({ required: auditedSummary ? true : null, source: auditedSummary?.auth ?? "复用 Manager 连接鉴权；处理器校验请求身份、对象和参数合同。", scopes: Object.freeze(["agent-api-entry"]) }),
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
  ["POST", "/plans", "新增计划（含附件与任务绑定）"],
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
  ["GET", "/skills/:skillId/download", "下载指定人格技能完整目录ZIP；鉴权即可读取，不执行脚本"],
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
  ...operations("desktop-pet", "/api/desktop-pet/roles/:roleId", [
    ["POST", "/motion", "让桌宠走路或传送到坐标、屏幕四角或激活窗口四角"],
    ["GET", "/motion/:requestId", "查询桌宠实际移动结果与抵达坐标"]
  ]),
  ...operations("knowledge", "/api/roles/:roleId", roleKnowledge),
  ...operations("knowledge-alias", "/roles/:roleId", roleKnowledge),
  ...operations("persona", "/api/roles/:roleId", [
    ["GET", "/knowledge/search", "按关键词或全文检索知识", "query mode kind archived limit cursor"],
    ["GET", "/knowledge/cache/status", "读取知识索引状态"],
    ["POST", "/knowledge/cache/reload", "刷新指定知识索引"],
    ["GET", "/message-endpoint-history", "检索已记录消息的最近片段（无分页）", "query match adapter channel kind sender target conversationKey from to afterSequence beforeSequence includeArchives limit maxChars", "", [
      "只查该人格已保存的消息；includeArchives=1 纳入归档，不保证平台全部历史。",
      "limit 默认 50、最多 200；maxChars 默认及最多 200000，按文本、分段和记录开销计预算，首条可超过预算。count 仅本次返回数，coverage 是查询范围标签；少于 limit 也不能证明完整。",
      "无 cursor/offset、nextCursor 或完整结束标记；不把本次结果当作整月统计样本或全量历史，不按最早时间减一秒模拟翻页（同秒多条会漏）。",
      "归档冷查询需读取候选文件，减小 limit 或增加关键词不降低扫描量。先限定目标会话与 Unix 秒 from/to，limit 建议 10；成功后按需要扩展，不并发全历史扫描。",
      "503/超时应区分索引未就绪、读池繁忙与读取超时；缩小时间窗口或使用已核验覆盖范围的正式来源，不对相同重查询无限重试。"
    ]],
    ["GET", "/role-panel/messages", "读取人格消息时间线", "limit"],
    ["GET", "/persona-document", "读取固定 persona.md；不开放 file 参数"],
    ["GET", "/persona-reference", "只读获取人格正文与消息配置；数据仍归所属 PC", "file"],
    ["POST", "/persona-reference/language-style", "由人格所属 PC 根据当前 revision 和自身风格配置检查正文；不接受调用者指定文件地址", ""],
    ["GET", "/plans/:planId/attachments/:attachmentId", "读取计划附件"],
    ["GET", "/plan-agents/status", "读取计划绑定 Agent 的状态", "planId", "planId"]
  ]),
  ...operations("agent", "", [
    ["GET", "/meta", "核对 Manager 健康与 generation"],
    ["GET", "/api/personas", "发现人格与可投递 Route", "addressable"],
    ["GET", "/api/personas/:personaId", "读取人格投递信息"],
    ["POST", "/api/personas/:personaId/messages", "通过来源能力跨人格投递"],
    ["GET", "/api/personas/messages/receipts/:deliveryId", "读取跨人格投递回执"],
    ["GET", "/api/agent/threads", "列出 Agent 会话", "query limit offset"],
    ["POST", "/api/agent/threads", "发现、读取、创建、命名、投递与原回执；目标执行能力由实际宿主协议决定"],
    ["PUT", "/api/agent/uploads/:uploadId", "上传当前远端 Agent 的上传文件，不自动外发"],
    ["GET", "/api/agent/uploads/:uploadId", "核对当前远端 Agent 的文件上传回执"],
    ["GET", "/api/agent/help", "按 operationId、方法或路径查询当前接口帮助", "operationId path method"],
    ["GET", "/api/agent/qq/diagnostics", "查询唯一已启用 QQ 实例的脱敏只读诊断", "routeId"],
    ["GET", "/api/agent/qq/group-files", "读取精确群的有界 QQ 文件元数据", "routeId groupId folderId"],
    ["GET", "/api/agent/qq/stickers", "读取所选 QQ 账号的收藏表情 ID 和描述", "routeId instanceId count", "routeId"],
    ["GET", "/api/agent/qq/stickers/:stickerId/preview", "预览所选 QQ 账号的收藏表情", "routeId instanceId", "routeId"],
    ["GET", "/api/agent/qq/history", "鉴权连接读取选定 QQ 会话历史分页", "routeId kind target cursor limit"],
    ["GET", "/api/agent/qq/messages/:messageId", "鉴权连接读取原消息及附件下载入口", "routeId kind target"],
    ["GET", "/api/agent/qq/messages/:messageId/attachments/:attachmentIndex", "鉴权连接下载原消息附件二进制；最多 64 MiB", "routeId kind target"],
    ["GET", "/api/agent/send/capabilities", "列出发送渠道、参数示例与不重试规则"],
    ["GET", "/api/agent/chat-history", "按发送目标搜索聊天记录及省略索引范围", "routeId channel params afterSequence beforeSequence query limit"],
    ["POST", "/api/agent/send", "通过渠道策略发送消息或附件"],
    ["GET", "/api/agent/send/traces", "按平台消息追踪发送", "channel sentMessageId routeId"],
    ["GET", "/api/agent/send/receipts/:deliveryId", "读取渠道发送回执"],
    ["POST", "/api/agent/send/receipts/:deliveryId/verify", "只读核验原投递的可信证据；无需计划绑定，不外发或重试"],
    ["POST", "/api/agent/send/receipts/:deliveryId/settle", "受控结算原投递 ID；无需计划绑定，不外发或重试"],
    ["GET", "/api/agent/requests", "列出 Agent 回复请求", "status"],
    ["GET", "/api/agent/requests/:requestId", "读取 Agent 回复请求"],
    ["POST", "/api/agent/requests/:requestId/cancel", "取消不再需要的回复请求"],
    ["POST", "/api/agent-state", "提交 Agent 业务状态"],
    ["GET", "/api/agent-adapters/catalog", "读取 Agent 适配器业务能力目录"],
    ["GET", "/api/remote-agent/devices", "读取远端 Agent 设备与任务"],
    ["GET", "/api/remote-agent/tasks", "列出远端 Agent 任务"],
    ["POST", "/api/remote-agent/tasks", "向已授权远端 Agent 创建任务"]
  ]),
  ...operations("device-agent", "/api/device-agents", [
    ["GET", "", "鉴权连接发现本机提供的设备 Agent；不要求人格或 Route 绑定"],
    ["GET", "/:agentId/session", "读取设备会话与加载状态"],
    ["GET", "/:agentId/pending", "读取设备队列是否存在待接收消息；不返回提示词", "waitMs"],
    ["PUT", "/:agentId/session", "签名设备登记或续租唯一模型 owner；会话纪元由 PC 生成"],
    ["POST", "/:agentId/deliveries", "鉴权连接向指定设备排队原消息；绑定只选择自动投递目标，排队不等于 owner 已接收"],
    ["GET", "/:agentId/deliveries/:deliveryId", "鉴权连接读取原设备投递回执与结果", "waitMs"],
    ["POST", "/:agentId/prepared-deliveries", "真实账本 PC 向设备所在 PC 投递原 reservation；接收 PC 回查原账本指纹，眼镜领取后才确认"],
    ["POST", "/:agentId/prepared-deliveries/reconcile", "真实账本 PC 核对原设备执行者回执，不重新排队或启动替代模型"],
    ["POST", "/:agentId/deliveries/claim", "已加载的签名设备领取一条消息；要求原 sessionId 和 ownerEpoch"],
    ["POST", "/:agentId/deliveries/:deliveryId/response", "原设备 owner 按 sessionId、ownerEpoch 和 claimToken 回传原消息结果"],
    ["GET", "/:agentId/wake-requests", "手机读取唤醒 nonce 元数据，不返回提示词"],
    ["POST", "/:agentId/wake-requests/:nonce/claim", "手机独占领取原唤醒请求，避免重复触发"],
    ["POST", "/:agentId/wake-requests/:nonce/receipt", "手机报告原唤醒请求的真实提交或拒绝；不能代替 owner 接收回执"]
  ], ["实验能力；眼镜执行模型，PC 只保存投递与回执。保留原 deliveryId，不确定时先回读。每个入口继续核验连接、设备归属和当前 owner 纪元。"]),
  ...operations("processing", "/api/message-processing", [
    ["GET", "/board", "查询消息处理看板", "routeId limit"],
    ["POST", "/requirements", "登记消息组或提交消息分派结果"],
    ["GET", "/requirements/:requirementId", "读取消息处理需求"],
    ["GET", "/requirements/:requirementId/send-context", "读取发送前上下文审阅", "sourceMessageId"],
    ["POST", "/requirements/:requirementId/send-context", "提交发送前上下文审阅"],
    ["POST", "/requirements/:requirementId/outcome", "提交消息处理结果"],
    ["POST", "/requirements/:requirementId/knowledge-callback", "提交知识核对与更新回执"]
  ]),
  ...operations("hook", "/api/codex-hook", [
    ["POST", "/context", "提交真实会话的 Hook 事件；复验签名来源的会话与 provider"],
    ["GET", "/roles", "读取可选人格"],
    ["GET", "/doctor", "读取 Hook 诊断"],
    ["GET", "/sessions", "列出会话人格绑定"],
    ["GET", "/sessions/:sessionId", "读取指定会话人格绑定"],
    ["PUT", "/sessions/:sessionId", "设置指定会话人格绑定"],
    ["PATCH", "/sessions/:sessionId", "设置指定会话人格绑定"],
    ["DELETE", "/sessions/:sessionId", "解除指定会话人格绑定"]
  ]),
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
    ["GET", "/records/:recordId/audio", "读取语音记录音频"],
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
  ]),
  ...operations("home", "/api/agent/xiaomi-home", [
    ["GET", "/health", "读取家庭设备连接与事件监听健康状态"],
    ["GET", "/vacuum-cloud/status", "读取扫地机云地图连接状态"],
    ["POST", "/vacuum-cloud/video/start", "启动持续至退出的扫地机视频会话，不收音或移动"],
    ["GET", "/vacuum-remote/capabilities", "读取共享扫地机遥控能力与协议版本", "resourceId"],
    ["GET", "/vacuum-remote/status", "查询遥控会话或原动作回执", "sessionId idempotencyKey"],
    ["POST", "/vacuum-remote/start", "进入共享遥控模式"],
    ["POST", "/vacuum-remote/pulse", "执行自动松键的短时方向控制"],
    ["POST", "/vacuum-remote/stop", "松开方向键，保留遥控模式"],
    ["POST", "/vacuum-remote/exit", "松键并退出遥控模式，设备可能自动回仓"],
    ["GET", "/vacuum-cloud/video/network", "读取已归属扫地机的局域网地址及本机同网段判断，不启动视频", "deviceId region"],
    ["GET", "/vacuum-cloud/video/password", "查询本机视频密码保存状态或原删除回执，不返回密码", "deviceId region idempotencyKey"],
    ["POST", "/vacuum-cloud/video/password/forget", "删除当前云账号设备的本机视频密码"],
    ["POST", "/vacuum-cloud/video/stop", "停止指定视频会话"],
    ["GET", "/vacuum-cloud/video/status", "读取视频会话和首帧证据，或查询原动作回执", "sessionId idempotencyKey"],
    ["GET", "/vacuum-cloud/video/stream", "读取已启动会话的视频流", "sessionId"],
    ["GET", "/vacuum-cloud/video/frame", "读取已启动会话的单个 MP4 视频帧", "sessionId"],
    ["GET", "/vacuum-cloud/connect", "打开米家扫码地图连接页", "deviceId view"],
    ["POST", "/vacuum-cloud/login", "开始米家扫码登录，凭据由连接组件保存"],
    ["POST", "/vacuum-cloud/login/poll", "有界等待当前扫码结果"],
    ["GET", "/vacuum-cloud/devices", "查询米家云扫地机，不返回凭据", "region"],
    ["GET", "/vacuum-cloud/plugin-information", "读取官方扫地机插件元数据，不返回下载签名", "deviceId region sdkVersion"],
    ["GET", "/vacuum-cloud/plugin-package", "读取官方插件文件，仅供静态协议诊断", "deviceId region sdkVersion"],
    ["GET", "/vacuum-cloud/position", "读取设备位置属性，空值保持不可用，单位与时效未验证", "deviceId region"],
    ["GET", "/vacuum-cloud/trajectory", "读取官方轨迹查询返回值，不移动设备或证明定位即时性", "deviceId region poseId"],
    ["GET", "/vacuum-cloud/path", "在同一云地图快照上预览避障路径，不移动设备", "deviceId region slot mapHash targetX targetY clearanceMm"],
    ["GET", "/vacuum-cloud/map", "读取实验性云地图原始文件，不移动设备", "deviceId region slot"],
    ["GET", "/capabilities", "读取家庭媒体动作参数、绑定与结果确认合同"],
    ["GET", "/resources", "分页搜索实体摘要：q搜索名称、描述、设备登记和属性；默认limit=20、view=summary，返回items/total/nextOffset；按resourceId读单项状态和动作", "q kind available view offset limit deviceId includeActions"],
    ["GET", "/devices", "分页搜索设备摘要，不带完整实体属性；q搜索名称、描述、房间和属性，kind筛实体类型，view=detail显式读取该页详情；以nextOffset续页，详见home-device-agent-api.md", "q kind available view offset limit"],
    ["GET", "/devices/:deviceId", "读取单台设备完整登记信息及resourcesPath；实体目录按deviceId筛选并分页"],
    ["GET", "/entity-actions", "读取一个实体实时支持的动作及参数合同", "resourceId"],
    ["GET", "/resources/:resourceId", "读取已授权家庭设备资源"],
    ["POST", "/action-requests", "向已连接设备提交动作"],
    ["GET", "/action-requests", "只读查询同一幂等键的设备动作回执", "idempotencyKey"],
    ["POST", "/events", "提交家庭设备业务事件"],
    ["GET", "/artifacts", "查询家庭媒体记录", "resourceId eventKind"],
    ["GET", "/artifacts/lifecycle", "读取家庭媒体生命周期合同"],
    ["GET", "/artifacts/:artifactId", "读取家庭媒体记录"],
    ["GET", "/artifacts/:artifactId/content", "读取家庭媒体内容"]
  ], ["复用已有 Manager 连接鉴权；本机、已鉴权 WebGUI 和已登记远端 Agent 使用相同业务合同。"])
]);

/** Public operation contracts only; connection authentication and shared route policy are enforced separately, not by this catalog as a permission allowlist. */
export function listAgentApiOperations(): readonly AgentApiOperation[] { return catalog; }

// Exact connection credential names, after punctuation is removed. Business
// pagination and counters such as pageToken/tokenCount are not credentials.
const credentialKey = /^(?:token|accessToken|refreshToken|idToken|bearerToken|authToken|webguiToken|rabilinkToken|lanAgentToken|agentToken|authorization|proxyAuthorization|credential|credentials|password|secret|clientSecret|cookie|cookie2|apiKey|xApiKey|accessKey|capability|sourceCapability|signature|sourceSignature)$/i;
const parameterPatterns: Readonly<Record<string, RegExp>> = Object.freeze({
  date: /^\d{4}-\d{2}-\d{2}$/,
  uploadId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  historyJobId: /^[0-9a-f-]+$/,
  mediaId: /^[0-9a-f-]{36}$/
});

function safeSegment(raw: string): string | undefined {
  try {
    const decoded = decodeURIComponent(raw);
    encodeURIComponent(decoded); // Reject unpaired UTF-16 without restricting valid Unicode IDs.
    // HTTP resource identifiers are not filenames. Path traversal and ambiguous
    // separators remain ingress errors; individual handlers own filename schemas.
    if (decoded === "." || decoded === ".." || /[\/\\\x00-\x1f\x7f]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)) return undefined;
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
  if (typeof method !== "string" || !/^(?:GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(method)) return { allowed: false, reason: "invalid_method" };
  if (typeof requestTarget !== "string" || requestTarget.length > 16_384 || !requestTarget.startsWith("/")
    || requestTarget.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(requestTarget)) return { allowed: false, reason: "invalid_path" };
  const separator = requestTarget.indexOf("?");
  const pathname = separator < 0 ? requestTarget : requestTarget.slice(0, separator);
  const rawSegments = pathname.slice(1).split("/");
  const decodedSegments = rawSegments.map(segment => safeSegment(segment));
  if (decodedSegments.some(segment => segment === undefined)) return { allowed: false, reason: "invalid_path" };

  const query: string[] = [];
  if (separator >= 0) {
    const rawQuery = requestTarget.slice(separator + 1);
    if (rawQuery.split("&").length > 128) return { allowed: false, reason: "query_not_allowed" };
    for (const field of rawQuery ? rawQuery.split("&") : []) {
      const equals = field.indexOf("=");
      try {
        const key = decodeURIComponent((equals < 0 ? field : field.slice(0, equals)).replace(/\+/g, " "));
        const value = equals < 0 ? "" : decodeURIComponent(field.slice(equals + 1).replace(/\+/g, " "));
        if (credentialKey.test(key.replace(/[^a-z0-9]/gi, ""))) return { allowed: false, reason: "query_credentials" };
        if (!key || /[\x00-\x1f\x7f]/.test(key + value) || /%[0-9a-f]{2}/i.test(key)) return { allowed: false, reason: "query_not_allowed" };
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
  if (decodedSegments.length === 6 && decodedSegments.slice(0, 3).join("/") === "api/desktop-pet/roles"
    && decodedSegments[4] === "motion" && decodedSegments[5] === "runtime") return { allowed: false, reason: "operation_not_allowed" };
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
