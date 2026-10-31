import { validApiHttpMethod } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { REMOTE_AGENT_ROUTES, remoteAgentContract } from "./remoteAgentContract.js";
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

type AgentApiInvalidTarget = { allowed: false; reason: "invalid_method" | "invalid_path" | "query_credentials" | "query_not_allowed" };

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

const catalog: readonly AgentApiOperation[] = Object.freeze([
  ...operations("instance-agent", "/api/lan-agent/instances", [
    ["GET", "", "查询电脑与 Agent 列表，取得 instanceId、agentId、provider 及连接状态"],
    ["POST", "/:instanceId/agents/:agentId/threads", "按明确 agentAdapter 查询会话列表（action=list，limit/offset）或操作明确 threadId"],
    ["POST", "/:instanceId/agents/:agentId/tasks", "按明确 provider 和完整 threadId 投递；不使用默认 Agent 或修改绑定"]
  ], ["tasks 每次必须传 provider、threadId、message；agentId 位于路径。先查询实例目录，再以 action=list 查询会话。", "idempotencyKey 同时绑定 provider、agentId、threadId、message 与 cwd；相同键不得更换目标。"]),
  ...operations("remote-terminal", "/api/lan-agent/instances/:instanceId/terminals", [
    ["GET", "", "查询远端支持的 Shell、终端及真实进程状态"],
    ["POST", "", "新增、查询、输入、调整大小或退出远端终端"],
    ["GET", "/:terminalId", "查询远端终端及输出；可有界等待新输出", "after waitMs"],
    ["GET", "/:terminalId/events", "读取有界缓存和实时终端输出（SSE）", "after"]
  ], ["Windows 默认提供 CMD 和 PowerShell；Mac/Linux 返回实际可用的 Zsh/Bash/sh，需安装连接器的 node-pty 可选依赖。终端属于连接器主程序的子程序。", "POST action=open|list|get|input|resize|close；open 使用稳定 terminalId，input 使用递增 sequence，相同 sequence 不重复执行。", "超时后查询现有会话及 nextInputSequence，不自动重建或重发输入。输出仅保留有界内存缓存，不写入日志。"]),
  ...operations("remote-computer", "/api/lan-agent/instances/:instanceId/computer", [
    ["POST", "", "远端文件互传、窗口查询、桌面或窗口截图"]
  ], ["由客户端直接执行，关联 Codex/DSH 等后端无需启动；数据、记忆、Skill 与流程归主控。", "action=file.stat|file.read|upload.begin|upload.write|upload.status|upload.commit|upload.abort|windows.list|screen.capture。文件路径必须绝对；客户端自身系统权限适用。", "下载先 file.stat(path)，以 version+offset 调用 file.read；返回 base64 data、块 sha256、nextOffset、eof，每块最多64 KiB。", "上传 begin(uploadId,path,size,sha256)，write(uploadId,offset,data,sha256)，status(uploadId)，commit(uploadId)；稳定UUID、顺序分块、整文件校验，不覆盖已存在文件。默认无额外大小额度；远端启动环境 RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES 可显式限制，字节数须为非负安全整数。RABI_AGENT_COMPUTER_MAX_CONCURRENT_IO/MAX_ACTIVE_UPLOADS/MAX_UPLOAD_RECORDS 默认4/4/64，0取消对应资源额度；调整后重启远端Agent。", "windows.list 可传 query 和 limit(1..200)；screen.capture 可传 maxWidth(320..3840)，窗口截图必须同时传查询得到的 windowId 和 pid。返回 image/png 的 base64 data、尺寸与 capturedAt；最多8 MiB。", "截图需要交互桌面；最小化、受保护或不支持 PrintWindow 的窗口可能无法获取有效画面。超时先查原上传或终端，不自动重放写入。"]),
  ...operations("agent", "", [
    ["GET", "/meta", "核对 Manager 健康与 generation"],
    ["PUT", "/api/agent/uploads/:uploadId", "上传当前远端 Agent 的上传文件，不自动外发"],
    ["GET", "/api/agent/uploads/:uploadId", "核对当前远端 Agent 的文件上传回执"],
    ["GET", "/api/agent/help", "按 operationId、方法或路径查询当前接口帮助", "operationId path method"],
    ["GET", "/api/agent/qq/diagnostics", "查询唯一已启用 QQ 实例的脱敏只读诊断", "routeId"],
    ["GET", "/api/agent/qq/group-files", "读取精确群的有界 QQ 文件元数据", "routeId groupId folderId"],
    ["GET", "/api/agent/qq/stickers", "读取所选 QQ 账号的收藏表情 ID 和描述", "routeId instanceId count", "routeId"],
    ["GET", "/api/agent/qq/stickers/:stickerId/preview", "预览所选 QQ 账号的收藏表情", "routeId instanceId", "routeId"],
    ["GET", "/api/agent/qq/history", "鉴权连接读取选定 QQ 会话历史分页", "routeId kind target cursor limit"],
    ["GET", "/api/agent/qq/messages/:messageId", "鉴权连接读取原消息及附件下载入口", "routeId kind target"],
    ["GET", "/api/agent/qq/messages/:messageId/attachments/:attachmentIndex", "鉴权连接下载原消息附件二进制；大小额度由 QQ 媒体设置决定", "routeId kind target"],
    ["GET", "/api/agent/send/capabilities", "列出发送渠道、参数示例与不重试规则"],
    ["GET", "/api/agent/chat-history", "按发送目标搜索聊天记录及省略索引范围", "routeId channel params afterSequence beforeSequence query limit"],
    ["POST", "/api/agent/send", "通过渠道策略发送消息或附件"],
    ["GET", "/api/agent/send/traces", "按平台消息追踪发送", "channel sentMessageId routeId"],
    ["GET", "/api/agent/send/receipts/:deliveryId", "读取渠道发送回执"],
    ["POST", "/api/agent/send/receipts/:deliveryId/verify", "只读核验原投递的可信证据；无需计划绑定，不外发或重试"],
    ["POST", "/api/agent/send/receipts/:deliveryId/settle", "受控结算原投递 ID；无需计划绑定，不外发或重试"],
    ["GET", "/api/agent/requests", "列出 Agent 回复请求", "status"],
    ["GET", "/api/agent/deliveries", "读取投递记录；指定电脑离线时不推断其队列为空", "nodeId limit cursor state query"],
    ["GET", "/api/agent/deliveries/:deliveryId", "读取原投递记录及接收证据", "nodeId"],
    ["GET", "/api/agent/deliveries/caller/:callerDeliveryId", "按原调用键读取当前来源的投递；不发送", "sourceThreadId sourceAgentType agentAdapter"],
    ["GET", "/api/agent/requests/:requestId", "读取 Agent 回复请求"],
    ["POST", "/api/agent/requests/:requestId/cancel", "取消不再需要的回复请求"],
    ["GET", "/api/agent-adapters/catalog", "读取 Agent 适配器业务能力目录"]
  ]),
  // Legacy discovery IDs remain a projection of the executable owner, not another route table.
  ...operations("agent", "", REMOTE_AGENT_ROUTES.flatMap(route => {
    const contract = remoteAgentContract(route);
    return contract.aliases?.length ? [[route.method, route.pathTemplate, contract.description] as const] : [];
  })),
  ...operations("hook", "/api/codex-hook", [
    ["POST", "/context", "提交真实会话的 Hook 事件；复验签名来源的会话与 provider"],
    ["GET", "/roles", "读取可选角色"],
    ["GET", "/doctor", "读取 Hook 诊断"],
    ["GET", "/sessions", "列出会话角色绑定"],
    ["GET", "/sessions/:sessionId", "读取指定会话角色绑定"],
    ["PUT", "/sessions/:sessionId", "设置指定会话角色绑定"],
    ["PATCH", "/sessions/:sessionId", "设置指定会话角色绑定"],
    ["DELETE", "/sessions/:sessionId", "解除指定会话角色绑定"]
  ]),

]);

/** Public operation contracts only; connection authentication and shared route policy are enforced separately, not by this catalog as a permission allowlist. */
export function listAgentApiOperations(): readonly AgentApiOperation[] { return catalog; }

// Exact connection credential names, after punctuation is removed. Business
// pagination and counters such as pageToken/tokenCount are not credentials.
const credentialKey = /^(?:token|accessToken|refreshToken|idToken|bearerToken|authToken|webguiToken|rabilinkToken|lanAgentToken|agentToken|authorization|proxyAuthorization|credential|credentials|password|secret|clientSecret|cookie|cookie2|apiKey|xApiKey|accessKey|capability|sourceCapability|signature|sourceSignature)$/i;

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


/**
 * Call only after authenticating an explicitly enabled Agent principal. Pass the ORIGINAL origin-form
 * request.url, before URL normalization; never a decoded pathname or an absolute URL. No I/O or body parsing.
 * A successful result confirms HTTP target syntax only; the target handler owns its operation contract.
 */
export function validateAgentApiRequestTarget(method: string, requestTarget: string):
  | { allowed: true; rawSegments: string[]; decodedSegments: (string | undefined)[]; query: string[] }
  | AgentApiInvalidTarget {
  if (!validApiHttpMethod(method)) return { allowed: false, reason: "invalid_method" };
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
