import { errorResponsePresentation } from "@rabiroute/host-api/shared/errorPresentation";
import { createGatewayControlOwner, prepareGatewayMutation, publicRouteMutationError, type GatewayControlRoutesContext, type GatewayMutation } from "./gatewayControlRoutes.js";
import type { ApiMethod, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";

const empty = { type: "object", additionalProperties: false };
const ignored = { type: "object" };
const ignoredBody = { kind: "none" as const, allowIgnoredBody: true };
const pathSchema = (name: string) => ({ type: "object", required: [name], additionalProperties: false, properties: { [name]: { type: "string", minLength: 1 } } });
const error = { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" }, errorCode: { type: "string" }, statusCode: { type: "integer" } }, additionalProperties: true };
const payload = { type: "object", additionalProperties: true, properties: { code: { type: "number" }, message: { type: "string" }, data: {}, routeCatalog: { type: "object" }, receipt: { type: "object", required: ["state", "operationId", "routeConfigHash"], properties: { state: { enum: ["committed", "not_committed"] }, operationId: { type: "string" }, routeConfigHash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, additionalProperties: true } } };
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const rawField = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
const mutationHeaders = { type: "object", additionalProperties: true, properties: {
  "idempotency-key": { ...rawField, description: "Original Route mutation key: 1..256 ASCII letters, digits, colon, dot, underscore or hyphen." },
  "if-match": { ...rawField, description: "Exact 64-hex strong Route catalog content hash, bare or quoted. Required and checked before the body." }
} };
const nativeJson = (properties: Record<string, ApiSchema>) => ({ kind: "json" as const, maxBytes: 0, allowAnyContentType: true, emptyValue: {}, schema: { description: "Native owner validation remains authoritative, including coercion, unknown fields and native failures on incompatible values; no new application byte limit.", anyOf: [{ type: "object", properties, additionalProperties: true }, ...["array", "string", "number", "boolean", "null"].map(type => ({ type }))] } });

const gatewayPurposes: Record<string, [string, string[]]> = {
  "list": [
    "查询消息路由、Agent配置与运行状态",
    [
      "路由列表",
      "Agent配置",
      "会话绑定",
      "gateway route configuration"
    ]
  ],
  "replace": [
    "替换消息路由配置",
    [
      "路由配置",
      "批量配置",
      "replace gateway routes"
    ]
  ],
  "config.save": [
    "保存消息路由与 Agent 绑定配置",
    [
      "配置Agent",
      "接入Agent",
      "绑定任务",
      "会话绑定",
      "保存路由",
      "configure adapter",
      "bind agent session",
      "save route configuration"
    ]
  ],
  "mutation.read": [
    "查询路由配置保存回执",
    [
      "保存结果",
      "配置回执",
      "route mutation receipt"
    ]
  ],
  "start": [
    "启动消息路由",
    [
      "启动路由",
      "start gateway"
    ]
  ],
  "stop": [
    "停止消息路由",
    [
      "停止路由",
      "stop gateway"
    ]
  ],
  "restart": [
    "重启消息路由",
    [
      "重启路由",
      "restart gateway"
    ]
  ],
  "delete": [
    "删除消息路由",
    [
      "删除路由",
      "remove gateway"
    ]
  ],
  "weixin-login.request": [
    "发起微信消息端登录",
    [
      "微信登录",
      "weixin login"
    ]
  ],
  "manual-trigger.request": [
    "手动触发路由自动化规则",
    [
      "手动触发",
      "执行规则",
      "manual automation trigger"
    ]
  ],
  "agent-delivery-test.request": [
    "测试路由绑定 Agent 的真实投递",
    [
      "投递测试",
      "验证Agent接入",
      "agent delivery test"
    ]
  ],
  "delivery-replay.list": [
    "查询可重放的路由投递记录",
    [
      "投递历史",
      "失败投递",
      "delivery replay records"
    ]
  ],
  "delivery-replay.request": [
    "重放指定的路由投递记录",
    [
      "重放投递",
      "补发消息",
      "replay delivery"
    ]
  ],
  "network-options.read": [
    "查询可用网络绑定地址",
    [
      "网络地址",
      "监听网卡",
      "network bind options"
    ]
  ],
  "reload": [
    "重新加载路由运行配置",
    [
      "重载配置",
      "reload routes"
    ]
  ]
};

function gatewayDiscovery(name: string, mutation: boolean): ApiOperationDefinition["discovery"] {
  const purpose = gatewayPurposes[name];
  return { title: purpose[0], summary: purpose[0] + (name === "config.save"
    ? "。先读取现有路由配置和适配器合同，提交局部字段；使用当前 routeCatalog.contentHash 及原操作 ID，分别核对保存回执和运行状态。" : "。"),
    category: { id: "settings.routes", title: "消息路由与 Agent 配置", parentId: "settings" }, keywords: purpose[1],
    ...(name !== "list" && name !== "replace" && name !== "mutation.read" && name !== "network-options.read" && name !== "reload"
      ? { inputSources: [{ field: "path.id", operationId: "manager.gateway-runtime.list", resultPath: "/data/config/gateways", valuePath: "/id", parameters: { "query.summary": { value: "1" }, "query.includeConfig": { value: "1" } } },
        ...(mutation ? [{ field: "headers.if-match", operationId: "manager.gateway-runtime.list", resultPath: "/routeCatalog", valuePath: "/contentHash" }] : [])] }
      : mutation ? { inputSources: [{ field: "headers.if-match", operationId: "manager.gateway-runtime.list", resultPath: "/routeCatalog", valuePath: "/contentHash" }] } : {}),
    ...(name === "config.save" || name === "replace" || name === "delete" ? { relatedOperations: ["manager.gateway-runtime.list", "manager.gateway-runtime.mutation.read", "agent.adapters.catalog.get"] }
      : name === "agent-delivery-test.request" ? { relatedOperations: ["manager.gateway-runtime.list", "manager.gateway-runtime.delivery-replay.list"] } : {}),
    ...(name === "config.save" ? { examples: [{ title: "修改已读取路由的启用状态", input: { body: { enabled: true } } }] } : {}) };
}

type Invoke = (input: ApiOperationInput, mutation?: GatewayMutation) => ApiOperationResult | Promise<ApiOperationResult>;

/** The same definitions install native gateway routes and publish their executable contracts. */
export function createGatewayControlOperations(context: GatewayControlRoutesContext, readOnly = false): readonly ApiOperationDefinition[] {
  const owner = createGatewayControlOwner(context);
  const define = (name: string, method: ApiMethod, pathTemplate: string, path: ApiSchema, body: ApiOperationDefinition["contract"]["request"]["body"], invoke: Invoke,
    options: { mutation?: boolean; query?: ApiSchema; effects?: string; recovery?: string; responses?: ApiOperationDefinition["contract"]["responses"] } = {}): ApiOperationDefinition => {
    const run = async (input: ApiOperationInput, mutation?: GatewayMutation): Promise<ApiOperationResult> => {
      const result = await invoke(input, mutation);
      return result.body === undefined ? result : { ...result, body: errorResponsePresentation(result.body, result.status) };
    };
    return { contract: { operationId: "manager.gateway-runtime." + name, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: options.effects ?? `Read native ${name} through its existing gateway owner.`,
      request: { path, query: options.query ?? ignored, headers: options.mutation ? mutationHeaders : ignored, body },
      responses: options.responses ?? { "200": json(payload), "202": json(payload), default: json(error) },
      effects: { mode: options.mutation ? "route-catalog-mutation" : method === "GET" ? "read" : "native-owner-action",
        description: options.effects ?? "Read the original native owner; no duplicate runtime, Route configuration or permission store." },
      recovery: { strategy: options.mutation ? "native-route-catalog-receipt" : method === "GET" ? "repeatable-read" : "inspect-original-owner-no-blind-replay",
        ...(options.mutation ? { idempotencyHeader: "Idempotency-Key", receiptPath: "/gateways/mutations/:operationId" } : {}),
        description: options.recovery ?? (options.mutation ? "Retain the same native key and strong hash. Read /gateways/mutations/:operationId; its original queue barrier resolves earlier writes before returning committed or not_committed. Activation failure does not erase a committed scoped save." : method === "GET" ? "Repeat the read against the active native owner." : "HTTP acceptance or uncertain response is not completion. Inspect the original runtime, process or delivery receipt before deciding whether to repeat; this operation has no generic replay guarantee.") },
      validators: [{ id: "native-gateway-owner", description: "Authenticated remote connections use all public operations without an additional feature grant. Original read-only mode, object lookup, Route CAS/idempotency, native launch and platform validators remain authoritative. Registry JSON decode failures are HTTP 400; business failures preserve their native status." }]
    }, discovery: gatewayDiscovery(name, options.mutation === true), prepare(input) {
      if (readOnly && method !== "GET" && method !== "HEAD") return { status: 403, body: errorResponsePresentation({ code: -1, message: "Manager is running in read-only acceptance mode." }, 403) };
      try { const mutation = options.mutation ? prepareGatewayMutation(input.request, context) : undefined; return prepared => run(prepared, mutation); }
      catch (cause) { const failure = publicRouteMutationError(cause); return { status: failure.statusCode, body: errorResponsePresentation({ code: -1, errorCode: failure.errorCode, message: failure.message }, failure.statusCode) }; }
    }, handler: input => run(input, options.mutation ? prepareGatewayMutation(input.request, context) : undefined) };

  };
  const base = "/gateways/:id";
  const definitions: ApiOperationDefinition[] = [
    define("list", "GET", "/gateways", empty, ignoredBody, input => owner.list(input.url.searchParams.get("summary"), input.url.searchParams.get("includeConfig")), { query: { type: "object", additionalProperties: true, properties: { summary: { ...rawField, description: "First value 1 omits diagnostics and, unless includeConfig=1, configuration definitions." }, includeConfig: rawField } } }),
    define("replace", "POST", "/gateways", empty, nativeJson({ gateways: {} }), (input, mutation) => owner.replace(input.body as any, mutation!), { mutation: true, effects: "Replace the native Route configuration through its original atomic CAS transaction, then synchronize native runtimes. Read the original mutation receipt after an uncertain response." }),
    define("config.save", "PUT", base + "/config", pathSchema("id"), nativeJson({ id: {}, configName: {}, enabled: {} }), (input, mutation) => owner.save(input.path.id, input.body as any, mutation!), { mutation: true, effects: "Merge one Route through the original writeGatewayConfig transaction and return its persisted receipt. Report runtime activation requested/failed independently of committed persistence; retain native definition and adapter validation." }),
    define("mutation.read", "GET", "/gateways/mutations/:operationId", pathSchema("operationId"), ignoredBody, input => owner.resolve(input.path.operationId)),
    ...(["start", "stop", "restart"] as const).map(action => define(action, "POST", base + "/" + action, pathSchema("id"), ignoredBody, input => owner.action(input.path.id, action), { effects: `Request ${action} through the existing gateway runtime service and return current statuses; requested is not process completion.` })),
    define("delete", "POST", base + "/delete", pathSchema("id"), ignoredBody, (input, mutation) => owner.remove(input.path.id, mutation!), { mutation: true, effects: "Remove the Route through the original configuration transaction and synchronize the existing runtimes; retain its committed deletion receipt." }),
    define("weixin-login.request", "POST", base + "/weixin-login", pathSchema("id"), ignoredBody, input => owner.weixinLogin(input.path.id), { effects: "Request a personal-WeChat login QR code only after the original Route and enabled adapter lookup. Native acceptance is HTTP 202 and does not send a message or change account configuration." }),
    define("manual-trigger.request", "POST", base + "/manual-trigger", pathSchema("id"), nativeJson({ triggerId: {}, triggerName: {}, message: {}, routeKind: {}, ruleId: {}, triggerSource: {} }), input => owner.manual(input.path.id, input.body as any), { effects: "Use the original manual-trigger process owner and its existing process-key deduplication. HTTP 202 reports accepted or already running; completion and teardown remain with that process owner." }),
    define("agent-delivery-test.request", "POST", base + "/agent-delivery-test", pathSchema("id"), nativeJson({ agentTargetId: {}, agentAdapterType: {} }), input => owner.testDelivery(input.path.id, input.body as any), { effects: "Invoke the native real Agent-delivery test and await its original target receipt. This operation sends a real test prompt when run outside a controlled fixture; fixture tests substitute only the native target boundary." }),
    define("delivery-replay.list", "GET", base + "/delivery-replay", pathSchema("id"), ignoredBody, input => owner.replays(input.path.id, input.url.searchParams.get("limit"), input.url.searchParams.get("status")), { query: { type: "object", additionalProperties: true, properties: { limit: { ...rawField, description: "Native Number coercion; falsy values default to 50, owner retains its own limit rules." }, status: rawField } } }),
    define("delivery-replay.request", "POST", base + "/delivery-replay", pathSchema("id"), nativeJson({ attemptId: {}, attemptIds: {}, routeKind: {}, messageId: {}, mode: {} }), input => owner.replay(input.path.id, input.body as any), { effects: "Replay delivery through the original attempt ledger and target owner. The native owner can create new external effects; inspect the original attempts before repeating uncertain work." }),
    define("network-options.read", "GET", "/network-options", empty, ignoredBody, () => owner.network()),
    define("reload", "POST", "/reload", empty, ignoredBody, input => owner.reload(input.request.headers.accept), { effects: "Await the original runtime reload and synchronization. Accept containing application/json returns JSON 200; other callers receive an empty 303 response with Location: /.", responses: {
      "200": json({ type: "object", required: ["ok", "gateways", "routeCatalog"], additionalProperties: false, properties: { ok: { const: true }, gateways: { type: "array" }, routeCatalog: { type: "object" } } }),
      "303": { mediaType: "text/plain", headers: { type: "object", required: ["location"], properties: { location: { const: "/" } }, additionalProperties: true } }, default: json(error)
    } }),

  ];
  return definitions;
}
