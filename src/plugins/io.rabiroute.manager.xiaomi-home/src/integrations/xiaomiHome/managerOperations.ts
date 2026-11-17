import { once } from "node:events";
import { XiaomiHomeArtifactEvidenceError } from "./artifactStore.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { createXiaomiHomeOperationsOwner, presentedXiaomiHomeError, type XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";
import type { XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import type { ApiMethod, ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiHttpProxyDefinition, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";

const empty = { type: "object", additionalProperties: false };
const read = { kind: "none" as const, allowIgnoredBody: true };
const body = { kind: "json" as const, maxBytes: 0, allowAnyContentType: true, emptyValue: {}, schema: { description: "Native integration owner validates the existing business DTO, revision and resource constraints; no added application byte cap." } };
const path = (name: string) => ({ type: "object", required: [name], additionalProperties: false, properties: { [name]: { type: "string", minLength: 1 } } });
const success = { type: "object", required: ["code"], additionalProperties: false, properties: { code: { const: 0 }, data: { description: "Original typed integration result, including independent cloud/provider results; no secret projection is added here." }, coverage: { type: "object", description: "Artifact list coverage and bounded diagnostics; original ledger records are retained." } } };
const failure = { type: "object", required: ["code", "error"], properties: { code: { const: -1 }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, outcome: { type: "string" } }, additionalProperties: true } }, additionalProperties: true };
type Options = { configuration?: boolean; lifecycle?: boolean; key?: boolean; query?: readonly string[]; family?: "cloud" | "remote"; status?: number; effect?: string };
type Invocation = (input: ApiOperationInput, authority: XiaomiHomeRequestAuthority, key: string) => unknown | Promise<unknown>;
const root = "/api/agent/xiaomi-home";


const homePurposes: Record<string, string> = {
  "health.read": "检查家庭设备连接健康",
  "deployment.read": "查询家庭设备服务部署状态",
  "deployment.save": "保存家庭设备服务部署设置",
  "deployment.start": "启动家庭设备服务",
  "deployment.install": "安装家庭设备服务",
  "auth.read": "查询家庭设备连接授权",
  "auth.connect": "连接并授权 Home Assistant",
  "auth.refresh": "刷新家庭设备连接授权",
  "auth.disconnect": "断开家庭设备授权连接",
  "settings.read": "查询家庭设备配置",
  "settings.save": "保存家庭设备配置",
  "recordings.latest": "读取最新设备录音",
  "resources.list": "查询家庭设备实体列表",
  "devices.list": "查询家庭设备目录",
  "device.read": "读取家庭设备详情",
  "entity-actions.read": "查询指定实体的可用动作与参数",
  "capabilities.read": "查询家庭设备动作能力与参数格式",
  "resource.read": "读取设备实体状态与版本",
  "action.request": "执行家庭设备动作",
  "action-receipt.read": "查询原设备动作回执",
  "event.deliver": "投递家庭设备事件",
  "artifacts.list": "查询家庭设备事件产物",
  "artifact-lifecycle.read": "查询设备产物保留规则",
  "artifact.read": "读取家庭设备产物元数据",
  "artifact.register": "登记家庭设备事件产物",
  "artifact.content": "下载家庭设备产物内容",
  "vacuum-remote.capabilities": "查询扫地机器人遥控能力",
  "vacuum-remote.status": "查询扫地机器人遥控会话",
  "vacuum-remote.start": "开始扫地机器人遥控",
  "vacuum-remote.pulse": "发送扫地机器人方向控制",
  "vacuum-remote.stop": "停止扫地机器人移动",
  "vacuum-remote.exit": "退出扫地机器人遥控",
  "vacuum-cloud.status": "查询扫地机器人云端连接",
  "vacuum-cloud.login": "登录扫地机器人云端账号",
  "vacuum-cloud.login-poll": "查询扫地机器人登录进度",
  "vacuum-cloud.devices": "查询云端扫地机器人",
  "vacuum-cloud.plugin-package": "查询扫地机器人插件包",
  "vacuum-cloud.plugin-information": "查询扫地机器人插件信息",
  "vacuum-cloud.map": "读取扫地机器人地图",
  "vacuum-cloud.path": "计算扫地机器人路径",
  "vacuum-cloud.trajectory": "读取扫地机器人移动轨迹",
  "vacuum-cloud.feedback": "提交扫地机器人路径反馈",
  "vacuum-cloud.position": "读取扫地机器人位置",
  "vacuum-cloud.telemetry": "读取扫地机器人遥测状态",
  "vacuum-cloud.connect": "打开扫地机器人云端连接页",
  "deployment.events": "订阅家庭设备部署事件",
  "vacuum-cloud.video-status": "查询扫地机器人视频状态",
  "vacuum-cloud.video-password": "设置扫地机器人视频密码",
  "vacuum-cloud.video-start": "启动扫地机器人视频连接",
  "vacuum-cloud.video-stop": "停止扫地机器人视频连接",
  "vacuum-cloud.video-forget": "清除扫地机器人视频连接",
  "vacuum-cloud.video-network": "查询扫地机器人视频网络",
  "vacuum-cloud.video-stream": "读取扫地机器人视频流",
  "vacuum-cloud.video-frame": "读取扫地机器人视频画面"
};
function homeDiscovery(name: string): ApiOperationDefinition["discovery"] {
  const title = homePurposes[name];
  if (!title) return undefined;
  return { title, summary: title + (name === "action.request" ? "。从实体目录取得 resourceId，读取该实体的动作与 stateVersion，按 capabilities 的 argumentsSchema 填参数；保留原动作键并查询回执。" : "。"),
    category: { id: "devices.home", title: "家庭设备与扫地机器人", parentId: "devices" }, provider: "xiaomi-home", keywords: [title, name.replace(/[.-]/g, " "), "home assistant", "xiaomi home"],
    ...(name === "resource.read" ? { inputSources: [{ field: "path.resourceId", operationId: "manager.xiaomi-home.resources.list", resultPath: "/data/items", valuePath: "/resourceId" }] }
      : name === "entity-actions.read" ? { inputSources: [{ field: "query.resourceId", operationId: "manager.xiaomi-home.resources.list", resultPath: "/data/items", valuePath: "/resourceId" }] }
      : name === "action.request" ? { inputSources: [
        { field: "body.resourceId", operationId: "manager.xiaomi-home.resources.list", resultPath: "/data/items", valuePath: "/resourceId" },
        { field: "body.expectedStateVersion", operationId: "manager.xiaomi-home.entity-actions.read", resultPath: "/data", valuePath: "/stateVersion", parameters: { "query.resourceId": { from: "body.resourceId" } } },
        { field: "body.capability", operationId: "manager.xiaomi-home.capabilities.read", resultPath: "/data/actions", valuePath: "/capability" }
      ], relatedOperations: ["manager.xiaomi-home.entity-actions.read", "manager.xiaomi-home.capabilities.read", "manager.xiaomi-home.action-receipt.read"] }
      : name === "settings.save" ? { relatedOperations: ["manager.xiaomi-home.settings.read", "manager.xiaomi-home.health.read"] }
      : name.startsWith("deployment.") && name !== "deployment.read" ? { relatedOperations: ["manager.xiaomi-home.deployment.read"] } : {}) };
}

/** Exact routes only: the integration's native services retain state, validation and receipts. */
export function createXiaomiHomeManagerOperations(context: XiaomiHomeManagerRoutesContext) {
  const owner = createXiaomiHomeOperationsOwner(context), runtime = owner.runtime;
  const presentedCause = (cause: unknown) => cause instanceof XiaomiHomeArtifactEvidenceError ? new XiaomiHomeManagerApiError(cause.status, cause.code, cause.message) : cause;
  const rejection = (cause: unknown): ApiOperationResult => { const { status, ...error } = presentedXiaomiHomeError(presentedCause(cause)); return { status, ...(error.outcome === "not_started" || error.outcome === "unknown" ? { mutationOutcome: error.outcome } : {}), body: { code: -1, error } }; };
  const check = (request: ApiOperationInput["request"], url: URL, options: Options) => {
    const authority = owner.prepare(request, url, options.configuration);
    if (options.query) owner.query(url, options.query, options.family === "remote" ? "xiaomi_vacuum_remote_query_invalid" : options.family === "cloud" ? "xiaomi_vacuum_cloud_query_invalid" : "xiaomi_home_query_invalid");
    if (options.lifecycle) owner.lifecycle(request);
    return { authority, key: options.key ? owner.key(request) : "" };
  };
  const contract = (name: string, method: ApiMethod, suffix: string, pathSchema: ApiSchema, options: Options): ApiOperationContract => ({
    ...(name === "resources.list" ? { searchable: { scope: "entities", legend: "家庭设备与实体的状态及动作入口 / device entities", kinds: ["*"] } } : {}),
    operationId: "manager.xiaomi-home." + name, aliases: [`home:${method}:${root}${suffix}`], contractVersion: "1.0.0", method, pathTemplate: root + suffix, exposure: "public", transport: "http",
    description: options.effect ?? `Use the original Xiaomi Home ${name} owner.`,
    request: { path: pathSchema, query: { type: "object", additionalProperties: true, ...(options.query ? { properties: Object.fromEntries(options.query.map(name => [name, { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }])) } : {}) }, headers: { type: "object", additionalProperties: true, properties: {
      ...(options.lifecycle ? { "x-rabiroute-expected-application-generation-id": { type: "string", description: "Required current /meta application generation; checked by the native owner before reading a body." }, "x-rabiroute-expected-manager-instance-id": { type: "string", description: "Required current /meta Manager instance; checked together with generation." } } : {}),
      ...(options.key ? { "idempotency-key": { type: "string", description: "Required original native key, 16..200 ASCII letters, digits, dot, underscore, colon or hyphen; never generate another key after uncertainty." } } : {})
    } }, body: method === "GET" ? read : body },
    responses: { [String(options.status ?? 200)]: { mediaType: "application/json", schema: success }, default: { mediaType: "application/json", schema: failure } },
    effects: { mode: method === "GET" ? "native-read" : "native-integration-action", description: options.effect ?? "Original integration owner executes the request; public connection access does not bypass native resources, platform state, revisions, keys or budgets." },
    recovery: { strategy: options.key ? "original-native-key-and-receipt" : method === "GET" ? "repeatable-read" : "inspect-original-owner-before-replay", ...(options.key ? { idempotencyHeader: "Idempotency-Key" } : {}), description: "Keep original device/session/action identity, lifecycle generation, revision and native idempotency key where required. Inspect original native receipts after uncertainty; do not reconnect accounts, install software, move devices, deliver events or replay actions automatically." },
    validators: [{ id: "xiaomi-original-owner", description: "Original authority is captured before body consumption and rechecked before result disclosure. Authenticated enabled connections need no extra local-origin feature grant. Native lifecycle, revision, receipt, resource-root and credential owners remain authoritative. Family query validators reject unknown or repeated fields before native dispatch." }]
  });
  const definitions: ApiOperationDefinition[] = [];
  const add = (name: string, method: ApiMethod, suffix: string, invoke: Invocation, options: Options = {}, pathSchema: ApiSchema = empty) => {
    const nativeContract = contract(name, method, suffix, pathSchema, options);
    const run = async (input: ApiOperationInput, saved: ReturnType<typeof check>) => {
      const result = await owner.result(saved.authority, async () => { try { return await invoke(input, saved.authority, saved.key); } catch (cause) { throw presentedCause(cause); } }, options.status);
      if (name === "artifacts.list" && result.status === 200) return { ...result, body: { ...(result.body as Record<string, unknown>), coverage: runtime.artifacts.coverage() } };
      return result;
    };
    definitions.push({ contract: nativeContract, discovery: homeDiscovery(name), prepare(input) { try { const saved = check(input.request, input.url, options); return full => run(full, saved); } catch (cause) { return rejection(cause); } }, handler: input => { try { return run(input, check(input.request, input.url, options)); } catch (cause) { return rejection(cause); } } });
  };
  const q = (input: ApiOperationInput, name: string, fallback = "") => input.url.searchParams.get(name) || fallback;
  add("health.read", "GET", "/health", (_, authority) => runtime.health(authority), { configuration: true });
  add("deployment.read", "GET", "/deployment", (_, authority) => runtime.deployment.inspect(authority));
  add("deployment.save", "PUT", "/deployment", (input, authority) => runtime.deployment.save((input.body as any).config, (input.body as any).revision, authority), { lifecycle: true });
  add("deployment.start", "POST", "/deployment/start", (input, authority) => runtime.deployment.ensureReady((input.body as any).revision, authority), { lifecycle: true });
  add("deployment.install", "POST", "/deployment/install", (input, authority) => runtime.deployment.install((input.body as any).revision, authority), { lifecycle: true });
  add("auth.read", "GET", "/auth", (_, authority) => runtime.authorization(authority), { configuration: true });
  add("auth.connect", "POST", "/auth", (input, authority, key) => owner.authorize(input.body as any, key, authority), { configuration: true, lifecycle: true, key: true });
  add("auth.refresh", "POST", "/auth/refresh", (input, authority, key) => owner.refresh(input.body as any, key, authority), { configuration: true, lifecycle: true, key: true });
  add("auth.disconnect", "DELETE", "/auth", (input, authority, key) => owner.disconnect(input.body as any, key, authority), { configuration: true, lifecycle: true, key: true });
  add("settings.read", "GET", "/settings", () => runtime.settings(), { configuration: true });
  add("recordings.latest", "GET", "/recordings/latest", () => owner.latestRecording(), { configuration: true, lifecycle: true, query: [] });
  add("settings.save", "PUT", "/settings", (input, authority) => runtime.update((input.body as any).settings, String((input.body as any).revision || ""), authority), { configuration: true, lifecycle: true });
  add("resources.list", "GET", "/resources", (input, authority) => runtime.client.queryResources(owner.parseDirectory(input.url.searchParams, "resources"), authority));
  add("devices.list", "GET", "/devices", (input, authority) => runtime.client.queryDevices(owner.parseDirectory(input.url.searchParams, "devices"), authority));
  add("device.read", "GET", "/devices/:deviceId", (input, authority) => { if (input.url.search) owner.invalid("xiaomi_home_query_invalid", "Device detail does not accept query parameters."); return runtime.client.getDevice(input.path.deviceId, authority); }, {}, path("deviceId"));
  add("entity-actions.read", "GET", "/entity-actions", (input, authority) => { if (input.url.searchParams.getAll("resourceId").length !== 1 || !q(input, "resourceId") || [...input.url.searchParams.keys()].some(key => key !== "resourceId")) owner.invalid("xiaomi_home_query_invalid", "Supply one resourceId."); return runtime.client.getResourceActions(q(input, "resourceId"), authority); });
  add("capabilities.read", "GET", "/capabilities", () => runtime.client.getCapabilities());
  add("action-receipt.read", "GET", "/action-requests", input => { if (input.url.searchParams.getAll("idempotencyKey").length !== 1 || [...input.url.searchParams.keys()].some(key => key !== "idempotencyKey")) owner.invalid("xiaomi_home_idempotency_required", "Supply one idempotencyKey query parameter."); return runtime.client.getActionReceipt(q(input, "idempotencyKey")); });
  add("resource.read", "GET", "/resources/:resourceId", (input, authority) => runtime.client.getResource(input.path.resourceId, authority), {}, path("resourceId"));
  add("action.request", "POST", "/action-requests", (input, authority) => runtime.client.executeAction(input.body as any, String(input.request.headers["idempotency-key"] || ""), authority), { lifecycle: true, status: 202 });
  add("event.deliver", "POST", "/events", (input, authority) => owner.event(input.body as any, authority), { lifecycle: true, status: 202 });
  add("artifacts.list", "GET", "/artifacts", input => runtime.artifacts.list({ resourceId: q(input, "resourceId") || undefined, eventKind: q(input, "eventKind") || undefined }));
  add("artifact-lifecycle.read", "GET", "/artifacts/lifecycle", () => runtime.artifacts.lifecycleContract());
  add("artifact.read", "GET", "/artifacts/:artifactId", input => { const artifact = runtime.artifacts.get(input.path.artifactId); if (!artifact) owner.invalid("xiaomi_home_artifact_not_found", "Artifact was not found.", 404); return artifact; }, {}, path("artifactId"));
  add("artifact.register", "POST", "/artifacts", (input, authority) => owner.artifact(input.body as any, authority), { lifecycle: true, status: 201 });
  const remote = "/vacuum-remote";
  add("vacuum-remote.capabilities", "GET", remote + "/capabilities", input => runtime.vacuumRemote.capabilities(q(input, "resourceId")), { family: "remote", query: ["resourceId"] });
  add("vacuum-remote.status", "GET", remote + "/status", input => { if (input.url.searchParams.has("sessionId") === input.url.searchParams.has("idempotencyKey")) owner.invalid("xiaomi_vacuum_remote_query_invalid", "Choose one session or original action key."); return input.url.searchParams.has("sessionId") ? runtime.vacuumRemote.status(q(input, "sessionId")) : runtime.vacuumRemote.receipt(q(input, "idempotencyKey")); }, { family: "remote", query: ["sessionId", "idempotencyKey"] });
  for (const command of ["start", "pulse", "stop", "exit"] as const) add("vacuum-remote." + command, "POST", remote + "/" + command, (input, _, key) => runtime.vacuumRemote.command(command, input.body as any, key), { family: "remote", query: [], lifecycle: true, key: true });
  const cloud = "/vacuum-cloud", cloudOptions = (query: readonly string[]): Options => ({ family: "cloud", query });
  add("vacuum-cloud.status", "GET", cloud + "/status", () => runtime.vacuumCloud.status(), cloudOptions([]));
  add("vacuum-cloud.login", "POST", cloud + "/login", (input, _, key) => owner.cloudLogin(input.body as any, key), { ...cloudOptions([]), lifecycle: true, key: true });
  add("vacuum-cloud.login-poll", "POST", cloud + "/login/poll", input => owner.cloudPoll(input.body as any), { ...cloudOptions([]), lifecycle: true });
  add("vacuum-cloud.devices", "GET", cloud + "/devices", input => runtime.vacuumCloud.devices(q(input, "region", "cn")), cloudOptions(["region"]));
  for (const operation of ["plugin-package", "plugin-information"] as const) add("vacuum-cloud." + operation, "GET", cloud + "/" + operation, input => runtime.vacuumCloud[operation === "plugin-package" ? "pluginPackage" : "pluginInformation"](q(input, "deviceId"), q(input, "region", "cn"), Number(q(input, "sdkVersion", "10112"))), cloudOptions(["deviceId", "region", "sdkVersion"]));
  add("vacuum-cloud.map", "GET", cloud + "/map", input => runtime.vacuumCloud.map(q(input, "deviceId"), q(input, "region", "cn"), q(input, "slot", "0")), cloudOptions(["deviceId", "region", "slot"]));
  add("vacuum-cloud.path", "GET", cloud + "/path", input => runtime.vacuumCloud.path(q(input, "deviceId"), q(input, "region", "cn"), q(input, "slot", "0"), q(input, "mapHash"), q(input, "targetX"), q(input, "targetY"), q(input, "clearanceMm", "250")), cloudOptions(["deviceId", "region", "slot", "mapHash", "targetX", "targetY", "clearanceMm"]));
  add("vacuum-cloud.trajectory", "GET", cloud + "/trajectory", input => runtime.vacuumCloud.trajectory(q(input, "deviceId"), q(input, "region", "cn"), q(input, "poseId")), cloudOptions(["deviceId", "region", "poseId"]));
  add("vacuum-cloud.feedback", "GET", cloud + "/feedback", input => runtime.vacuumCloud.feedback(q(input, "deviceId"), q(input, "region", "cn"), q(input, "slot", "0"), q(input, "scope"), q(input, "poseId")), cloudOptions(["deviceId", "region", "slot", "scope", "poseId"]));
  for (const operation of ["position", "telemetry", "videoNetwork"] as const) add("vacuum-cloud." + (operation === "videoNetwork" ? "video-network" : operation), "GET", cloud + "/" + (operation === "videoNetwork" ? "video/network" : operation), input => runtime.vacuumCloud[operation](q(input, "deviceId"), q(input, "region", "cn")), cloudOptions(["deviceId", "region"]));
  add("vacuum-cloud.video-status", "GET", cloud + "/video/status", input => { if (input.url.searchParams.has("sessionId") && input.url.searchParams.has("idempotencyKey")) owner.invalid("xiaomi_vacuum_video_query_invalid", "Choose a session or action key."); return input.url.searchParams.has("idempotencyKey") ? runtime.vacuumCloud.video.receipt(q(input, "idempotencyKey")) : runtime.vacuumCloud.video.status(q(input, "sessionId") || undefined); }, cloudOptions(["sessionId", "idempotencyKey"]));
  add("vacuum-cloud.video-password", "GET", cloud + "/video/password", input => { if (input.url.searchParams.has("idempotencyKey")) { if (input.url.searchParams.has("deviceId") || input.url.searchParams.has("region")) owner.invalid("xiaomi_vacuum_video_query_invalid", "Choose a device or action key."); return runtime.vacuumCloud.videoPasswordReceipt(q(input, "idempotencyKey")); } return runtime.vacuumCloud.videoPasswordStatus(q(input, "deviceId"), q(input, "region", "cn")); }, cloudOptions(["deviceId", "region", "idempotencyKey"]));
  for (const action of ["start", "stop", "forget"] as const) add("vacuum-cloud.video-" + action, "POST", cloud + "/video/" + (action === "forget" ? "password/forget" : action), (input, _, key) => owner.video(action, input.body as any, key), { ...cloudOptions([]), lifecycle: true, key: true });

  // HTML and SSE are independent exact operations, never hidden inside a prefix dispatcher.
  const html = contract("vacuum-cloud.connect", "GET", cloud + "/connect", empty, cloudOptions(["deviceId", "view"]));
  definitions.push({ discovery: homeDiscovery("vacuum-cloud.connect"), contract: { ...html, responses: { "200": { mediaType: "text/html", schema: { type: "string" } }, default: { mediaType: "application/json", schema: failure } } }, handler(input) { try { check(input.request, input.url, cloudOptions(["deviceId", "view"])); return owner.connect(input.url); } catch (cause) { return rejection(cause); } } });
  const sse = contract("deployment.events", "GET", "/deployment/events", empty, {});
  definitions.push({ discovery: homeDiscovery("deployment.events"), contract: { ...sse, transport: "sse", responses: { "200": { mediaType: "text/event-stream", stream: { framing: "sse-json", maxFrameBytes: 1024 * 1024, frameSchema: { type: "object", required: ["event", "data"], properties: { event: { const: "deployment" }, data: { type: "object" } }, additionalProperties: false }, completion: "Original deployment snapshots until client close, authority loss or plugin retirement.", cancellation: "Unsubscribe the original native deployment listener and join its pending observation." } }, default: { mediaType: "application/json", schema: failure } } }, handler(input) {
    try { const saved = check(input.request, input.url, {}); let wake: (() => void) | undefined, stopped = false; const queue: unknown[] = []; const controller = new AbortController();
      const unsubscribe = runtime.deployment.subscribe(snapshot => { if (stopped) return; try { saved.authority.assert(); if (queue.length >= 16) throw new Error("Deployment snapshot consumer stalled."); queue.push({ event: "deployment", data: snapshot }); wake?.(); } catch (cause) { controller.abort(cause); wake?.(); } }, cause => { controller.abort(cause); wake?.(); });
      let cancellation: Promise<void> | undefined; const cancel = () => cancellation ??= (async () => { stopped = true; wake?.(); await unsubscribe(); })();
      const frames = (async function* () { try { while (!stopped && !controller.signal.aborted) { if (!queue.length) await new Promise<void>(resolve => { wake = resolve; }); if (stopped || controller.signal.aborted) break; saved.authority.assert(); const frame = queue.shift(); if (frame) yield frame; } } finally { await cancel(); } })();
      return { status: 200, headers: { "cache-control": "no-cache" }, stream: { frames, signal: controller.signal, cancel } };
    } catch (cause) { return rejection(cause); }
  } });
  const proxies: ApiHttpProxyDefinition[] = [];
  const proxy = (name: string, suffix: string, pathSchema: ApiSchema, open: (input: Parameters<ApiHttpProxyDefinition["handler"]>[0]) => ReturnType<typeof runtime.artifactAccess.open> | ReturnType<typeof runtime.vacuumCloud.video.openStream>, options: Options = {}) => {
    const base = contract(name, "GET", suffix, pathSchema, options);
    proxies.push({ discovery: homeDiscovery(name), contract: { ...base, request: { ...base.request, body: { kind: "passthrough" } }, responses: { default: { mediaType: "*/*", passthrough: true } }, httpProxy: { wire: { dataFrameBytes: 65536, streamWindowBytes: 1048576, maxConcurrentStreams: 8 }, completion: "Native file EOF or original MP4 upstream completion; Range/status/media headers remain native.", cancellation: "Abort and join the original file/read stream or native sidecar upstream before releasing the operation lease." } }, async handler(input) {
      let content: Awaited<ReturnType<typeof open>> | undefined;
      const aborted = () => { void content?.cancel().catch(() => undefined); };
      input.signal.addEventListener("abort", aborted, { once: true });
      try { check(input.request, input.url, options); input.request.resume(); content = await open(input); input.assertCurrent(); input.prepareResponse(content.status, content.headers); input.response.writeHead(content.status, content.headers);
        for await (const chunk of content.frames) { input.assertCurrent(); if (!input.response.write(chunk)) await once(input.response, "drain", { signal: input.signal }); }
        input.assertCurrent(); input.response.end();
      } catch (cause) { if (input.response.headersSent) { input.response.destroy(); throw cause; } const result = rejection(cause); const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }; input.prepareResponse(result.status, headers); input.response.writeHead(result.status, headers); input.response.end(JSON.stringify(result.body)); }
      finally { input.signal.removeEventListener("abort", aborted); await content?.cancel(); }
    } });
  };
  proxy("artifact.content", "/artifacts/:artifactId/content", path("artifactId"), input => runtime.artifactAccess.open(input.request, input.path.artifactId, owner.recordingContentFence(input.url, input.path.artifactId)));
  for (const operation of ["stream", "frame"] as const) proxy("vacuum-cloud.video-" + operation, cloud + "/video/" + operation, empty, input => runtime.vacuumCloud.video.openStream(input.url.searchParams.get("sessionId") || "", operation === "frame", input.signal), cloudOptions(["sessionId"]));
  return Object.freeze({ operations: definitions, proxies,
    async searchSnapshot(request: ApiOperationInput["request"], signal: AbortSignal) {
      const authority = owner.prepare(request, new URL(root + "/devices", "http://manager.invalid"));
      const assert = () => { signal.throwIfAborted(); authority.assert(); context.assertRuntimeAvailable?.(); };
      assert();
      const directory = await runtime.client.listDevices({ ...authority, assert, signal });
      assert();
      return directory;
    }
  });
}
