import { errorResponsePresentation } from "@rabiroute/host-api/shared/errorPresentation";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { createManagerConfigurationOwner, createRabiApiOwner, publicRouteMutationFailure, requireRouteMutationContract, type ManagerConfigurationContext, type RabiApiContext, type RouteMutationContract } from "./rabiApi.js";
import { apiDigest, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { normalizeSearchText } from "@rabiroute/host-api/manager/searchText";
import { deviceLabelLimits, type DeviceLabels } from "./rabiLinkDeviceLabels.js";
import { createDeviceControlOperations, type DeviceComputerPort } from "./deviceControlOperations.js";

const empty = { type: "object", additionalProperties: false };
const ignored = { type: "object" };
const rawField = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
const lifecycleHeaders = { type: "object", additionalProperties: true, properties: {
  "x-rabiroute-expected-application-generation-id": { ...rawField, description: "Optional native generation fence; supply both lifecycle headers together." },
  "x-rabiroute-expected-manager-instance-id": { ...rawField, description: "Original selected Manager instance; paired with the generation fence." },
  "idempotency-key": { ...rawField, description: "Native Route mutation identity: 1..256 ASCII letters, digits, colon, dot, underscore or hyphen." },
  "if-match": { ...rawField, description: "Native Route mutation precondition: strong 64-hex content hash, bare or quoted. Weak ETags are rejected before body consumption." }
} };
const instanceQuery = { type: "object", additionalProperties: true, properties: {
  timeoutMs: { ...rawField, description: "Native DNS-SD operation budget; default and maximum are configurable in timeout settings (original defaults 450ms and 3000ms)." },
  ports: { ...rawField, description: "Retired input; the native owner rejects its presence rather than scanning ports." }
} };
const routeQuery = { type: "object", additionalProperties: true, properties: {
  includeProfiles: { ...rawField, description: "The first value equal to true includes unbound persona profiles." },
  presentation: { ...rawField, description: "The first value equal to mobile selects native mobile summary fields." },
  ...instanceQuery.properties
} };
const repliesQuery = { type: "object", additionalProperties: true, properties: {
  limit: { ...rawField, description: "Native numeric coercion clamped to 1..100; default 20." },
  afterId: { ...rawField, description: "Read after this native reply identity before applying the tail limit." },
  ...instanceQuery.properties
} };
const error = { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" }, errorCode: { type: "string" } }, additionalProperties: true };
const envelope = { type: "object", required: ["code"], properties: { code: { type: "number" }, data: { type: "object" }, message: { type: "string" }, receipt: { type: "object" }, routeCatalog: { type: "object" } }, additionalProperties: true };
// Discovery's selected Manager is an independently versioned native JSON owner. Its original
// proxy deliberately passes any valid JSON through, including upstream non-envelope failures.
const proxiedJson = { description: "Native selected-Manager JSON, forwarded without rewriting its fields or status.", anyOf: ["object", "array", "string", "number", "boolean", "null"].map(type => ({ type })) };
const pathSchema = (route = false) => ({ type: "object", required: route ? ["guid", "routeId"] : ["guid"], additionalProperties: false, properties: { guid: { type: "string", minLength: 1 }, ...(route ? { routeId: { type: "string", minLength: 1 } } : {}) } });
const nativeBody = (properties: Record<string, ApiSchema>) => ({ kind: "json" as const, maxBytes: 0, allowAnyContentType: true, emptyValue: {}, schema: { description: "The native owner ignores unknown properties, preserves JavaScript coercion and accepts non-null primitive or array JSON as an empty patch. Field constraints are enforced by its existing configuration and Route owners.", anyOf: [{ type: "object", properties, additionalProperties: true }, ...["array", "string", "number", "boolean"].map(type => ({ type }))] } });
const routeBase = "/api/rabi/instances/:guid/routes/:routeId";
const linkHomeDevicePath = "/api/rabi/link-home/devices/:deviceId";
const linkHomeDeviceId = "manager.route-control.link-home.device.read";
const deviceIdPath = { type: "object", required: ["deviceId"], additionalProperties: false, properties: { deviceId: { type: "string", minLength: 1, maxLength: 256 } } };
const deviceLabelsSchema = {
  alias: { type: "string", maxLength: deviceLabelLimits.alias },
  tags: { type: "array", maxItems: deviceLabelLimits.tags, items: { type: "string", maxLength: deviceLabelLimits.tag } }
};
const phoneFileActions = ["file.list", "file.stat", "file.read", "file.mkdir", "file.rename", "file.delete", "file.settings.read", "file.settings.update",
  "upload.begin", "upload.write", "upload.status", "upload.commit", "upload.abort"];
const phoneFileInput = {
  type: "object", required: ["targetGuid", "action"], additionalProperties: false,
  properties: {
    targetGuid: { type: "string", maxLength: 256 }, action: { enum: phoneFileActions },
    enabled: { type: "boolean" },
    path: { type: "string", maxLength: 2048 }, to: { type: "string", maxLength: 2048 },
    version: { type: "string", pattern: "^[a-f0-9]{64}$" }, after: { type: "string", maxLength: 255 },
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    size: { type: "integer", minimum: 0, maximum: 512 * 1024 * 1024 },
    uploadId: { type: "string", maxLength: 36 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    data: { type: "string", maxLength: 87_384 }
  }
};
const phoneLocationSchema = {
  anyOf: [
    { action: "location.read", fields: {
      maxAgeMs: { type: "integer", minimum: 1000, maximum: 120000 },
      waitMs: { type: "integer", minimum: 100, maximum: 10000 },
      includePlace: { type: "boolean" }
    }, required: [] },
    { action: "location.settings.read", fields: {}, required: [] },
    { action: "location.settings.update", fields: { enabled: { type: "boolean" } }, required: ["enabled"] },
  ].map(({ action, fields, required }) => ({
    type: "object", additionalProperties: false, required: ["targetGuid", "action", ...required],
    properties: { targetGuid: { type: "string", maxLength: 256 }, action: { const: action }, ...fields }
  }))
};
const deviceSchema = {
  type: "object", required: ["id", "guid", "name", "deviceKind", "online", "capabilities", "rabiPcVersion", "isLocal"], additionalProperties: false,
  properties: { id: { type: "string" }, guid: { type: "string" }, name: { type: "string" }, deviceKind: { type: "string" },
    online: { type: "boolean" }, capabilities: { type: "array", items: { type: "string" } }, rabiPcVersion: { type: ["string", "null"] }, isLocal: { type: "boolean" },
    labelRevision: { type: "string" }, labels: { type: "object", required: ["alias", "tags"], additionalProperties: false, properties: deviceLabelsSchema } }
};
const homeEnvelope = (data: ApiSchema): ApiSchema => ({
  type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data }
});
type Guard = () => void;
type Invoke = (input: ApiOperationInput, mutation: RouteMutationContract | undefined, assertCurrent: Guard) => ApiOperationResult | Promise<ApiOperationResult>;

/** Single executable declaration source; native owner methods never decode or dispatch HTTP. */
export function createRabiControlOperations(context: RabiApiContext, managerConfig?: ManagerConfigurationContext,
  deviceComputer?: DeviceComputerPort): readonly ApiOperationDefinition[] {
  const owner = createRabiApiOwner(context);
  const define = (name: string, method: "GET" | "POST" | "PATCH", pathTemplate: string, path: ApiSchema, body: ApiOperationDefinition["contract"]["request"]["body"], invoke: Invoke,
    options: { mutation?: boolean; effects?: string; recovery?: string; response?: ApiSchema; query?: ApiSchema; preflight?: (input: Omit<ApiOperationInput, "body">) => ApiOperationResult | undefined; lifecycle?: boolean } = {}): ApiOperationDefinition => {
    const operationId = "manager.route-control." + name;
    const run = async (input: ApiOperationInput, mutation?: RouteMutationContract): Promise<ApiOperationResult> => {
      const assertCurrent = () => { input.signal?.throwIfAborted(); hasAuthenticatedConnectionRequest(input.request); };
      assertCurrent();
      const result = await invoke(input, mutation, assertCurrent);
      return { ...result, body: errorResponsePresentation(result.body, result.status) };
    };
    return { contract: { operationId, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: options.effects ?? `Read native ${name} from the existing Manager owner.`,
      request: { path, query: options.query ?? ignored, headers: pathTemplate === "/api/rabi/timeouts" ? { ...lifecycleHeaders, properties: { ...lifecycleHeaders.properties, "if-match": { ...rawField, description: "Copy the complete strong ETag returned by GET /api/rabi/timeouts, including quotes. The version is bound to this Manager generation and instance." } } } : lifecycleHeaders, body },
      responses: { "200": { mediaType: "application/json", schema: options.response ?? envelope }, default: { mediaType: "application/json", schema: pathTemplate.includes(":guid") ? proxiedJson : error } },
      effects: { mode: options.mutation ? "route-catalog-mutation" : method === "GET" ? "read" : "native-owner-action", description: options.effects ?? "Read the existing Manager and immutable Route catalog; no new Agent runtime, permission store or configuration copy." },
      recovery: { strategy: options.mutation ? "native-route-catalog-idempotency" : method === "GET" ? "repeatable-read" : "inspect-original-owner-no-blind-replay",
        ...(options.mutation ? { idempotencyHeader: "Idempotency-Key", receiptPath: "/api/rabi/instances/:guid/routes" } : {}),
        description: options.recovery ?? (options.mutation ? "Preserve the original Idempotency-Key and strong If-Match catalog hash. Native writeConfig resolves committed replay and conflicts; inspect the original receipt/catalog before repeating uncertain work." : method === "GET" ? "Repeat the read against the freshly discovered Manager generation." : "No request-level idempotency exists. Read the original owner state before retrying an uncertain action.") },
      validators: [{ id: "native-rabi-owner", description: "Authenticated remote connections use the same public owner without additional feature grants. Existing generation pair, object identity, Route CAS, native coercion and selected-Manager DNS-SD verification remain authoritative; caller credentials are never copied into proxy headers." }]
    }, prepare(input) {
      const lifecycle = options.lifecycle === false ? undefined : owner.assertLifecycle(input.request);
      if (lifecycle) return { ...lifecycle, body: errorResponsePresentation(lifecycle.body, lifecycle.status) };
      const rejected = options.preflight?.(input);
      if (rejected) return { ...rejected, body: errorResponsePresentation(rejected.body, rejected.status) };
      let mutation: RouteMutationContract | undefined;
      if (options.mutation) {
        try { mutation = requireRouteMutationContract(input.request); }
        catch (cause) { const failure = publicRouteMutationFailure(cause); return { status: failure.statusCode, body: errorResponsePresentation({ code: -1, errorCode: failure.errorCode, message: failure.message }, failure.statusCode) }; }
      }
      return prepared => run(prepared, mutation);
    }, handler: input => run(input, options.mutation ? requireRouteMutationContract(input.request) : undefined) };
  };
  const ignoredBody = { kind: "none" as const, allowIgnoredBody: true };
  const phoneLocation = define("link-home.device.location.execute", "POST", linkHomeDevicePath + "/location", deviceIdPath,
    { kind: "json", maxBytes: 4096, schema: phoneLocationSchema },
    input => owner.phoneLocation(input.path.deviceId!, input.body as Record<string, unknown>, input.signal), {
      query: empty, effects: "Read one current position from a phone that advertises location access, using its system permission. includePlace uses the phone's configured provider when available. This request is independent of location tracks.",
      recovery: "Read location.settings.read on the same device before repeating a setting change after an uncertain result."
    });
  const definitions: ApiOperationDefinition[] = [
    ...(deviceComputer ? createDeviceControlOperations(deviceComputer, owner, phoneLocation) : []),
    define("timeouts.read", "GET", "/api/rabi/timeouts", empty, ignoredBody, () => owner.timeouts()),
    define("timeouts.update", "PATCH", "/api/rabi/timeouts", empty, { kind: "json", maxBytes: 0, schema: { type: "object", required: ["overrides"], additionalProperties: false, properties: { overrides: { type: "object", additionalProperties: { type: "integer", minimum: 1, maximum: 2147483647 } } } } }, (input, _, guard) => owner.updateTimeouts(input.body as { overrides: unknown }, guard, String(input.request.headers["if-match"] ?? "")), { effects: "Persist timeout overrides through the global configuration owner and publish the committed snapshot. Read back before retrying an uncertain write; this does not resend any timed-out business operation." }),
    define("identity.read", "GET", "/api/rabi/identity", empty, ignoredBody, input => owner.identity(input.request)),
    define("identity.update", "PATCH", "/api/rabi/identity", empty, nativeBody({ rabiName: {}, rabiLinkRelay: {}, agentUploads: {} }), (input, _, guard) => owner.updateIdentity(input.body as any, guard), { effects: "Patch the native global configuration, synchronize the original Relay, mark affected native RabiLink gateways for restart and synchronize them. The public response excludes the saved Relay token." }),
    { ...define("link-home.read", "GET", "/api/rabi/link-home", empty, { kind: "none" }, input => owner.home(input.signal), { query: empty,
      preflight: input => input.url.search || input.request.headers["transfer-encoding"] || Number(input.request.headers["content-length"] || 0) > 0 ? { status: 400, headers: { "cache-control": "no-store" }, body: { code: -1, errorCode: "RABILINK_HOME_INVALID_REQUEST", message: "此接口不接受查询参数或请求正文。" } } : undefined,
      response: homeEnvelope({ type: "object", required: ["devices", "checkedAt"], additionalProperties: false,
        properties: { checkedAt: { type: "string" }, devices: { type: "array", items: deviceSchema } } }) }),
      discovery: { title: "查找已授权电脑和设备", summary: "按名称、别名或标签查找 RabiLink 设备。遇到跨机任务，先用 Rabi CLI 查询 scope=devices，核对 deviceId，再进入远程终端或电脑控制。",
        keywords: ["Rabi CLI", "rabicli", "查电脑", "跨机", "远程电脑", "远端 CLI", "device alias", "device tags"],
        category: { id: "devices", title: "电脑与设备" },
        relatedOperations: [linkHomeDeviceId, "manager.lan-agent.computers.list", "manager.lan-agent.terminals.list", "manager.lan-agent.computer.execute"] } },
    define("link-home.device.read", "GET", linkHomeDevicePath, deviceIdPath, { kind: "none" },
      input => owner.homeDevice(input.path.deviceId!, input.signal), { query: empty, response: homeEnvelope(deviceSchema) }),
    define("link-home.device.labels.update", "PATCH", linkHomeDevicePath + "/labels", deviceIdPath,
      { kind: "json", maxBytes: 4096, schema: { type: "object", additionalProperties: false, required: ["alias", "tags", "guid", "expectedRevision"],
        properties: { ...deviceLabelsSchema, guid: { type: "string", maxLength: 256 }, expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" } } } },
      (input, _, guard) => owner.updateDeviceLabels(input.path.deviceId!, input.body as DeviceLabels & { guid: string; expectedRevision: string }, guard, input.signal),
      { query: empty, response: homeEnvelope(deviceSchema), effects: "Save presentation labels for the selected authorized RabiLink device on this Manager.",
        recovery: "Re-read the original device and label revision before repeating an uncertain edit." }),
    { ...define("link-home.device.phone-files.execute", "POST", linkHomeDevicePath + "/files", deviceIdPath,
      { kind: "json", maxBytes: 128 * 1024, schema: phoneFileInput },
      input => owner.phoneFiles(input.path.deviceId!, input.body as Record<string, unknown>, input.signal), {
        query: empty, effects: "Operate on Android primary shared storage within the device's file-operation setting and Android storage permission. Use the exact device ID and GUID from RabiLink. Reads and uploads use the PC file protocol's 64 KiB SHA-256-checked chunks.",
        recovery: "Use upload.status with the original uploadId after an uncertain upload. Refresh the directory or stat the original paths before repeating other uncertain changes."
      }), discovery: { title: "手机文件操作", summary: "查询和设置手机文件操作开关，浏览、创建、读取、移动、删除以及上传下载文件。",
      keywords: ["Android", "手机文件", "文件传输", "phone files", "upload", "download"],
      category: { id: "devices", title: "电脑与设备" }, relatedOperations: [linkHomeDeviceId] } },
    { ...phoneLocation,
      contract: { ...phoneLocation.contract, effects: { ...phoneLocation.contract.effects,
        request: { bodyPath: ["action"], modes: { "location.read": "read", "location.settings.read": "read", "location.settings.update": "write" } } } },
      discovery: { title: "读取手机当前位置", summary: "选择公布定位访问的手机，读取一次当前坐标和定位精度。Android 有高德配置时可补充地点名称。定位访问开关与轨迹记录独立。",
        keywords: ["手机定位", "当前位置", "定位访问", "高德", "Android", "phone location", "location.read"],
        category: { id: "devices", title: "电脑与设备" }, relatedOperations: [linkHomeDeviceId] } },
    define("instances.list", "GET", "/api/rabi/instances", empty, ignoredBody, input => owner.instances(input.request, input.url), { query: instanceQuery }),
    define("routes.list", "GET", "/api/rabi/instances/:guid/routes", pathSchema(), ignoredBody, input => owner.routes(input.request, input.url, input.path.guid), { response: proxiedJson, query: routeQuery }),
    define("agent-options.read", "GET", routeBase + "/agent-options", pathSchema(true), ignoredBody, input => owner.agentOptions(input.request, input.url, input.path.guid, input.path.routeId), { response: proxiedJson }),
    define("rabilink-replies.list", "GET", routeBase + "/rabilink-replies", pathSchema(true), ignoredBody, input => owner.replies(input.request, input.url, input.path.guid, input.path.routeId), { response: proxiedJson, query: repliesQuery }),
    ...(["PATCH", "POST"] as const).map(method => define("agent-binding." + (method === "PATCH" ? "update" : "post"), method, routeBase + "/agent-binding", pathSchema(true), nativeBody({ agentAdapter: {}, codexCwd: {}, codexThreadId: {}, codexThreadName: {}, copilotThreadName: {}, copilotCwd: {}, copilotCliBin: {}, marvisAppId: {}, agentInstanceBindings: {}, remoteAgentTargets: {}, primaryAgentTarget: {}, astrbotUrl: {}, astrbotUsername: {}, astrbotPassword: {}, astrbotProjectId: {}, astrbotSessionId: {}, grokBotProfilePath: {}, grokBotBackendUrl: {}, grokBotAgentId: {}, grokBotSessionId: {}, grokBotSessionName: {}, dshSessionId: {}, dshSessionName: {}, dshCwd: {}, dshBaseUrl: {} }), (input, mutation, guard) => owner.agentBinding(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, mutation!, guard), { mutation: true, response: proxiedJson, effects: "Change the existing Route Agent binding through writeConfig's atomic catalog CAS and idempotency receipt, preserve explicit remote targets, then synchronize native gateways. No Agent prompt or fallback Runtime is started." })),
    define("message-processing.read", "GET", routeBase + "/message-processing", pathSchema(true), ignoredBody, (input, _, guard) => owner.messageProcessing(input.request, input.url, input.path.guid, input.path.routeId, undefined, undefined, guard), { response: proxiedJson }),
    define("message-processing.update", "PATCH", routeBase + "/message-processing", pathSchema(true), nativeBody({ adapter: {}, maxAgents: {} }), (input, mutation, guard) => owner.messageProcessing(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, mutation, guard), { mutation: true, response: proxiedJson, effects: "Update native per-adapter worker limits through the original Route catalog transaction. The native owner coerces and clamps maxAgents to 1..32, skips unknown adapters, and returns its committed receipt." }),
    define("message-processing.cleanup", "POST", routeBase + "/message-processing-cleanup", pathSchema(true), nativeBody({ adapter: {}, keepSessionIds: {} }), (input, _, guard) => owner.cleanup(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, guard, input.signal), { response: proxiedJson, effects: "Delete only native message-processing workers selected by the original adapter/workspace/title rules, retain keepSessionIds, and persist the original worker and affinity files. DSH deletion can partially succeed; no operation-level replay guarantee exists." })
  ];
  const homeIndex = definitions.findIndex(definition => definition.contract.operationId === "manager.route-control.link-home.read");
  const home = definitions[homeIndex]!;
  definitions[homeIndex] = { ...home,
    contract: { ...home.contract, searchable: { scope: "devices", legend: "RabiLink 已授权设备的名称、别名和标签 / authorized RabiLink devices", kinds: ["computer", "device"] } },
    searchLanes: () => [{ key: "rabilink-devices", source: "devices", agent: null, async read({ signal, query }) {
    const { devices, checkedAt, scope } = await owner.homeDevices(signal, true);
    const terms = [...new Set(normalizeSearchText(query.q).split(/[\s,，、]+/u).filter(Boolean))];
    const items = devices.flatMap(device => {
      const fields = [device.name, device.labels?.alias ?? "", ...(device.labels?.tags ?? []), device.id, device.guid].map(normalizeSearchText);
      const matched = terms.filter(term => fields.some(field => field.includes(term))).length;
      if (terms.length && (!matched || query.match === "all" && matched !== terms.length)) return [];
      const detailUrl = linkHomeDevicePath.replace(":deviceId", encodeURIComponent(device.id));
      const computer = device.deviceKind === "pc";
      const exact = terms.length > 0 && fields.includes(normalizeSearchText(query.q));
      return [{ source: "devices", kind: computer ? "computer" : "device", agent: null, label: device.labels?.alias || device.name || device.id,
        excerpt: [device.name, device.online ? "在线" : "离线", ...(device.labels?.tags ?? [])].filter(Boolean).join(" · "),
        origin: { deviceId: device.id, deviceGuid: device.guid }, detailUrl,
        handle: { detailUrl, operationId: linkHomeDeviceId, deviceId: device.id, deviceGuid: device.guid,
          ...(computer ? { relatedOperations: ["manager.lan-agent.computers.list", "manager.lan-agent.terminals.list", "manager.lan-agent.computer.execute"] } : {}) },
        searchText: fields.join(" "), searchScore: matched * 1000 + (exact ? 300 : 0),
        evidence: { observedAt: checkedAt, state: "confirmed" as const, evidenceRefs: [detailUrl] } }];
    });
    return { items, complete: true, version: apiDigest([scope, devices]) };
  } }] };
  if (managerConfig) {
    const configuration = createManagerConfigurationOwner(managerConfig);
    const schema = { type: "object", required: ["code"], additionalProperties: false, properties: { code: { const: 0 }, routeDir: { type: "string" }, rolesDir: { type: "string" }, directoryDiagnostics: { type: "array", items: { type: "object", required: ["field", "code", "message"], additionalProperties: false, properties: { field: {type:"string"}, code: {type:"string"}, message: {type:"string"} } } }, rawDirectoryConfig: { type:"object", additionalProperties:false, properties: {routeDir:{},rolesDir:{}} } } };
    definitions.push(
      define("manager-config.read", "GET", "/manager-config", empty, ignoredBody, () => ({ status: 200, body: configuration.read() }), { response: schema, lifecycle: false }),
      define("manager-config.update", "POST", "/manager-config", empty, nativeBody({ routeDir: {}, rolesDir: {} }), async (input, _, guard) => {
        try { return { status: 200, body: await configuration.update(input.body as any, guard) }; }
        catch (cause) { const error = cause as { statusCode?: number; code?: string }; return { status: Number.isInteger(error?.statusCode) ? error.statusCode! : 400, body: { code: -1, errorCode: typeof error?.code === "string" ? error.code : "request_failed", message: cause instanceof Error ? cause.message : String(cause) } }; }
      }, { response: schema, lifecycle: false, effects: "Patch the original Manager routeDir/rolesDir configuration, then await its existing ensureDataDirs lifecycle. Readback reports the native resolved paths; no second configuration store or extra remote permission exists." })
    );
  }
  return definitions;
}
