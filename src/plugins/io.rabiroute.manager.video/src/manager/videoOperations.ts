import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { createVideoRuntime, VideoRequestAccess } from "./videoRuntime.js";
import { ApiContractError } from "@rabiroute/host-api/manager/apiOperationContract";
import type { ApiHttpProxyDefinition, ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiOperationStream, ApiSchema, ApiMethod } from "@rabiroute/host-api/manager/apiOperationContract";

type Admission = Readonly<{ access: VideoRequestAccess; deviceId: string }>;
export type VideoNativeJob = { id: string; model: string; status: string; computeOnly?: boolean; [field: string]: unknown };
export type VideoNativeService = {
  jobs: Map<string, VideoNativeJob>;
  reapCompute(access: VideoRequestAccess): Promise<void>;
  snapshot(): { jobs: unknown[]; [field: string]: unknown };
  snapshotFor(deviceId: string, access: VideoRequestAccess): Promise<unknown>;
  startRemote(deviceId: string, access: VideoRequestAccess): Promise<unknown>;
  stop(access: VideoRequestAccess): Promise<unknown>;
  submit(body: unknown, key: unknown, access: VideoRequestAccess, options: { deviceId?: string; computeOnly?: boolean }): Promise<unknown>;
  view(job: VideoNativeJob): unknown;
  removeCompute(id: string, access: VideoRequestAccess): Promise<unknown>;
  cancel(id: string, access: VideoRequestAccess): Promise<unknown>;
  exclusive<T>(operation: () => T | Promise<T>, access: VideoRequestAccess): Promise<T>;
  remote: {
    json(deviceId: string, path: string, init: RequestInit, access: VideoRequestAccess): Promise<unknown>;
    inspect(deviceId: string, kind: string, file: string, access: VideoRequestAccess): Promise<unknown>;
  };
};
type VideoNativeAssets = { upload(request: IncomingMessage, kind: string | null, access: VideoRequestAccess, inspect?: (kind: string, file: string, access: VideoRequestAccess) => Promise<unknown>): Promise<unknown> };
export type VideoMediaContent = Readonly<{ status: number; headers: Readonly<Record<string, string>>; frames: AsyncIterable<Uint8Array>; cancel(): Promise<void> }>;
export type VideoOperationsOwner = {
  prepare(request: IncomingMessage, url: URL, model?: boolean): Admission;
  result(saved: Admission, method: string, operation: () => unknown | Promise<unknown>, status?: number, headers?: Readonly<Record<string, string>>): Promise<ApiOperationResult>;
  error(cause: unknown, access?: VideoRequestAccess, method?: string): ApiOperationResult;
  readModelBody(request: IncomingMessage, access: VideoRequestAccess): Promise<unknown>;
  computeStatus(): unknown;
  startLocal(access: VideoRequestAccess): Promise<unknown>;
  installRuntime(access: VideoRequestAccess): Promise<unknown>;
  remoteModel(saved: Admission, path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  unmatchedModel(): never;
  job(id: string, compute?: boolean): VideoNativeJob;
  removeComputeAsset(id: string, access: VideoRequestAccess): Promise<unknown>;
  assetContent(id: string, request: IncomingMessage, access: VideoRequestAccess, signal?: AbortSignal, metadata?: boolean): Promise<VideoMediaContent | { metadata: unknown }>;
  jobContent(id: string, kind: string, compute: boolean, request: IncomingMessage, access: VideoRequestAccess, signal?: AbortSignal): Promise<VideoMediaContent>;
};
export type VideoOperationsContext = {
  contracts: Readonly<{ requests: Readonly<Record<string, ApiSchema>>; responses: Readonly<Record<string, ApiSchema>>; validators: ApiOperationContract["validators"] }>;
  owner: VideoOperationsOwner;
  runtime: ReturnType<typeof createVideoRuntime>;
  catalog: { models: readonly { id: string; mode?: string; [field: string]: unknown }[]; states: Record<string, { terminal: boolean; [field: string]: unknown }> };
  service: VideoNativeService;
  models: {
    snapshot(access: VideoRequestAccess): Promise<unknown>;
    downloadPlan(ids: undefined, access: VideoRequestAccess): Promise<unknown>;
    initializeModels(body: unknown, access: VideoRequestAccess): Promise<unknown>;
    directories(): unknown;
    configure(body: unknown, access: VideoRequestAccess): Promise<unknown>;
    download(modelId: string, access: VideoRequestAccess): unknown | Promise<unknown>;
  };
  assets: VideoNativeAssets; computeAssets: VideoNativeAssets;
  projects: { recordIssues?: readonly unknown[]; definition?: unknown; list(access: VideoRequestAccess, timing?: ReadTiming): Promise<unknown[]>; create(body: unknown, access: VideoRequestAccess): Promise<unknown>; read(id: string, access: VideoRequestAccess): Promise<unknown>; save(id: string, body: unknown, access: VideoRequestAccess): Promise<{ revision: number }>;
    readProject(id: string, access: VideoRequestAccess): Promise<unknown>; createProjectV2(body: unknown, access: VideoRequestAccess): Promise<unknown>; saveProject(id: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
    readCanvas(project: string, canvas: string, access: VideoRequestAccess): Promise<unknown>; saveCanvas(project: string, canvas: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
    readCanvasThumbnail(project: string, canvas: string, revision: string, access: VideoRequestAccess): Promise<unknown>;
    listCanvases(project: string, query: unknown, access: VideoRequestAccess, timing?: ReadTiming): Promise<unknown>; createCanvas(project: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
    copyCanvas(project: string, body: unknown, access: VideoRequestAccess): Promise<unknown>; migrateProject(project: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
    importCanvas(project: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
    exportCanvas(project:string,canvas:string,format:string|null,access:VideoRequestAccess):Promise<unknown>;
    rebuildCanvasIndex(project: string, access: VideoRequestAccess): Promise<unknown>;
    readMediaEditor(project: string, canvas: string, access: VideoRequestAccess): Promise<unknown>; saveMediaEditor(project: string, canvas: string, body: unknown, access: VideoRequestAccess): Promise<unknown>;
  };
  events: { compute(access: VideoRequestAccess): ApiOperationStream; job(service: VideoNativeService, job: VideoNativeJob, access: VideoRequestAccess): ApiOperationStream };
  runs: {readTrigger(project:string,canvas:string,id:string):Promise<unknown>; trigger(project:string,canvas:string,body:unknown,access:VideoRequestAccess):Promise<unknown>; start(project:string,canvas:string,body:unknown,access:VideoRequestAccess):Promise<unknown>; list(project:string,canvas:string,query:unknown):Promise<unknown>; read(id:string):Promise<unknown>; refresh(id:string,access:VideoRequestAccess):Promise<unknown>; logs(id:string,after:number,limit:number):Promise<unknown>; cancel(id:string,access:VideoRequestAccess):Promise<unknown>; completeHuman(id:string,body:unknown,access:VideoRequestAccess):Promise<unknown>;artifactContent(id:string,artifactId:string,request:IncomingMessage,access:VideoRequestAccess,signal?:AbortSignal):Promise<VideoMediaContent>};
};
type ReadTiming = (stage: string, durationMs: number) => void;
type Options = { body?: ApiOperationContract["request"]["body"]; status?: number; model?: boolean; compute?: boolean; noStore?: boolean; media?: boolean; assetMetadata?: boolean; rawRemainder?: string; listTiming?: boolean };
const root = "/api/video", empty = { type: "object", additionalProperties: false }, ignored = { type: "object", additionalProperties: true };
const json = (maxBytes: number, schema: ApiSchema) => ({ kind: "json" as const, maxBytes, schema, emptyValue: {}, allowAnyContentType: true });
const nativeResult = { description: "Original native VideoService/Models/Projects result; provider/model/job fields remain owned and validated by the native services." };
const idSchema = (name: string, pattern = "^[a-f0-9-]{36}$") => ({ type: "object", required: [name], properties: { [name]: { type: "string", pattern } }, additionalProperties: false });
function isMediaContent(value: unknown): value is VideoMediaContent {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<VideoMediaContent>;
  return Number.isInteger(source.status) && Boolean(source.headers && typeof source.headers === "object")
    && typeof source.frames?.[Symbol.asyncIterator] === "function" && typeof source.cancel === "function";
}
function assetMetadata(value: unknown): unknown {
  if (value && typeof value === "object" && "metadata" in value) return value.metadata;
  throw new Error("Native asset owner returned invalid metadata.");
}


const videoPurposes: Record<string, string> = {
  "projects.list": "查询视频项目列表",
  "projects.create": "创建视频项目",
  "project.read": "读取视频项目",
  "project.save": "保存视频项目",
  "workbench.definition": "查询视频工作台能力与画布格式",
  "workbench.projects-create": "创建工作台项目",
  "workbench.project-read": "读取工作台项目",
  "workbench.project-save": "保存工作台项目",
  "workbench.project-migrate": "迁移工作台项目格式",
  "workbench.canvases-list": "查询项目画布列表",
  "workbench.canvas-create": "创建项目画布",
  "workbench.canvas-copy": "复制项目画布",
  "workbench.canvas-import": "导入项目画布",
  "workbench.canvas-read": "读取项目画布",
  "workbench.canvas-thumbnail": "读取画布缩略图",
  "workbench.canvas-export": "导出项目画布",
  "workbench.canvas-save": "保存项目画布",
  "workbench.media-read": "读取画布媒体编辑信息",
  "workbench.media-save": "保存画布媒体编辑信息",
  "workbench.index-rebuild": "重建项目画布索引",
  "workbench.run-create": "开始执行画布生成任务",
  "workbench.trigger": "按期次触发工作台模板",
  "workbench.trigger-read": "查询原工作台触发回执",
  "workbench.runs-list": "查询画布生成任务",
  "workbench.run-read": "读取画布任务状态",
  "workbench.run-refresh": "刷新画布任务状态",
  "workbench.run-logs": "查询画布任务日志",
  "workbench.run-cancel": "取消画布任务",
  "workbench.run-human": "提交画布人工步骤结果",
  "workbench.artifact-content": "读取画布任务产物",
  "compute.status": "查询视频计算节点状态",
  "compute.runtime-start": "启动视频计算环境",
  "compute.runtime-stop": "停止视频计算环境",
  "compute.assets-upload": "上传视频计算素材",
  "compute.asset-remove": "删除视频计算素材",
  "compute.job-submit": "提交视频计算任务",
  "compute.job-read": "查询视频计算任务",
  "compute.job-remove": "删除视频计算任务",
  "compute.events": "订阅视频计算节点事件",
  "compute.job-events": "订阅视频计算任务事件",
  "compute.job-image": "读取视频计算任务图片",
  "compute.job-video": "读取视频计算任务视频",
  "models.read": "查询可用视频模型",
  "models.initialization": "查询视频模型安装计划",
  "models.initialize": "安装视频模型与依赖",
  "models.settings-read": "查询视频模型存储目录",
  "models.settings-save": "配置视频模型存储目录",
  "models.runtime-install": "安装视频生成运行环境",
  "model.download": "下载指定视频模型",
  "models.remote-exchange": "访问选定视频计算节点的模型服务",
  "status": "查询视频工作站状态",
  "runtime.start": "启动视频生成服务",
  "runtime.stop": "停止视频生成服务",
  "jobs.submit": "提交视频生成任务",
  "jobs.list": "查询视频生成任务列表",
  "job.read": "查询视频生成任务状态",
  "job.cancel": "取消视频生成任务",
  "job-image": "读取生成任务图片",
  "job-video": "读取生成任务视频",
  "assets.upload": "上传图片视频音频素材",
  "asset.content": "读取已上传媒体素材"
};
function videoDiscovery(name: string): ApiOperationDefinition["discovery"] {
  const title = videoPurposes[name];
  if (!title) return undefined;
  return { title, summary: title + (name === "jobs.submit" || name === "compute.job-submit" ? "。先读取模型与素材目录，提交后保留任务 ID 和原 Idempotency-Key，通过任务状态确认结果。" : "。"),
    category: { id: "video", title: "视频生成与媒体工作台", parentId: "runtime" }, keywords: [title, name.replace(/[.-]/g, " "), "video"],
    ...(name === "jobs.submit" || name === "compute.job-submit" ? { inputSources: [{ field: "body.model", operationId: "manager.video.models.read", resultPath: "/models", valuePath: "/id" }], relatedOperations: ["manager.video.models.read", "manager.video.assets.upload", "manager.video.jobs.list"] }
      : name === "job.read" || name === "job.cancel" || name === "job-image" || name === "job-video" ? { inputSources: [{ field: "path.mediaId", operationId: "manager.video.jobs.list", resultPath: "/jobs", valuePath: "/id" }] }
      : name.startsWith("workbench.") && name !== "workbench.definition" ? { relatedOperations: ["manager.video.workbench.definition", "manager.video.projects.list"] }
      : name.startsWith("models.") && name !== "models.read" ? { relatedOperations: ["manager.video.models.read", "manager.video.models.initialization"] } : {}) };
}

/** Fixed Video APIs, derived once for execution and discovery. No boolean HTTP dispatcher. */
export function createVideoOperations(context: VideoOperationsContext) {
  const { owner, service, models, assets, computeAssets, projects, runs, events, contracts } = context, presentVideoError = owner.error;
  const operations: ApiOperationDefinition[] = [], proxies: ApiHttpProxyDefinition[] = [];
  const contract = (name: string, method: ApiMethod, suffix: string, options: Options = {}): ApiOperationContract => ({
    operationId: "manager.video." + name, ...(method === "*" ? {} : { aliases: [`video:${method}:${root}${suffix}`] }), contractVersion: "1.0.0", method, pathTemplate: root + suffix,
    exposure: "public", transport: "http", description: "Use the original video " + name + " owner.",
    request: { path: options.rawRemainder ? { type: "object", required: [options.rawRemainder], properties: { [options.rawRemainder]: { type: "string" } }, additionalProperties: false } : suffix.includes(":projectId") ? { type:"object", required: ["projectId", ...(suffix.includes(":canvasId") ? ["canvasId"] : []), ...(suffix.includes(":mediaId") ? ["mediaId"] : [])], properties: {projectId:{type:"string",pattern:"^[a-f0-9-]{36}$"}, ...(suffix.includes(":canvasId") ? {canvasId:{type:"string",pattern:"^[a-f0-9-]{36}$"}} : {}), ...(suffix.includes(":mediaId") ? {mediaId:{type:"string",pattern:"^[a-f0-9-]{36}$"}} : {})}, additionalProperties:false } : suffix.includes(":modelId") ? idSchema("modelId", "^[a-z0-9-]+$") : suffix.includes(":mediaId") ? idSchema("mediaId") : empty,
      ...(options.rawRemainder ? { pathRemainder: options.rawRemainder } : {}),
      query: { ...ignored, properties: { computeDeviceId: { type: "string", description: "Original selected peer; first query value is used, maximum 200 characters. Projects and saved outputs remain local." }, ...(name.endsWith("upload") ? { kind: { description: "Native image/video/audio selection; omitted value defaults to image. Original MIME, limits and inspection remain native." } } : {}), ...(options.assetMetadata ? { metadata: { description: "Only the first query value exactly equal to 1 selects JSON metadata; every other value keeps original media." } } : {}) } }, headers: { ...ignored, ...(name === "jobs.submit" || name === "compute.job-submit" ? { properties: { "idempotency-key": { description: "Required original 8–128 ASCII [A-Za-z0-9._:-] key. Native 400 for invalid key, 409 for same key with different normalized intent; workspace and compute scopes stay separate." } } } : {}) },
      body: options.body ?? { kind: "none", allowIgnoredBody: true } },
    responses: { [String(options.status ?? 200)]: { mediaType: "application/json", schema: contracts.responses[name] ?? { description: "Native exchange metadata; raw media and selected-peer extensions retain their own wire contract." } }, default: { mediaType: "application/json", schema: { type: "object", properties: { message: { type: "string" }, error: { type: "string" }, mutation: { enum: ["not_started", "unknown"] } }, additionalProperties: true } } },
    effects: { mode: method === "GET" ? options.compute ? "native-read-and-compute-retention" : "native-read" : "native-video-action", description: "Original service retains project revisions, job keys, resource ownership, read-only checks, process leases, model roots and background lifecycle." },
    recovery: { strategy: "inspect-original-project-job-or-model-operation", description: "Keep the original project revision, Idempotency-Key, workspace job, selected compute peer and remote receipt. Uncertain work is never automatically replayed or moved to local compute.", ...(name === "jobs.submit" || name === "compute.job-submit" ? { idempotencyHeader: "Idempotency-Key" } : {}) },
    validators: [...contracts.validators, { id: "video-native-owner", description: "Capture original request authority before body consumption; recheck in native queue/fs/process/network boundaries and before disclosure. Existing body caps and native DTO validators remain authoritative." }]
  });
  const add = (name: string, method: ApiMethod, suffix: string, invoke: (input: ApiOperationInput, saved: Admission, timing?: ReadTiming) => unknown, options: Options = {}) => {
    const run = (input: ApiOperationInput, saved: Admission) => {
      const headers: Record<string, string> | undefined = options.noStore || options.model ? { "cache-control": "no-store" } : undefined;
      return owner.result(saved, method, async () => {
        if (options.compute) await service.reapCompute(saved.access);
        if (!options.listTiming || !headers) return invoke(input, saved);
        const started = performance.now(), stages: Record<string, number> = {};
        let failed = true;
        try {
          const body = await invoke(input, saved, (stage, ms) => { stages[stage] = Math.round(ms); });
          failed = false;
          return body;
        } finally {
          stages.total = Math.round(performance.now() - started);
          headers["server-timing"] = Object.entries(stages).map(([stage, ms]) => `${stage};dur=${ms}`).join(", ");
          if (failed || stages.total >= 1000) context.runtime.reportWorkbenchRead?.(name, input.path.projectId ?? "projects", stages, failed);
        }
      }, options.status ?? 200, headers);
    };
    const definition: ApiOperationDefinition = { contract: contract(name, method, suffix, options), discovery: videoDiscovery(name),
      prepare(input) { try { const saved = owner.prepare(input.request, input.url, options.model); return full => run(full, saved); } catch (cause) { return presentVideoError(cause, undefined, method); } },
      handler(input) { try { return run(input, owner.prepare(input.request, input.url, options.model)); } catch (cause) { return presentVideoError(cause, undefined, method); } }
    }; operations.push(definition); return definition;
  };
  add("projects.list", "GET", "/projects", (_, saved, timing) => projects.list(saved.access, timing).then((value: unknown) => ({ projects: value, recordIssues: projects.recordIssues ?? [] })), { noStore: true, listTiming: true });
  add("projects.create", "POST", "/projects", (input, saved) => projects.create(input.body, saved.access), { body: json(4096, contracts.requests.projectCreate), noStore: true });
  add("project.read", "GET", "/projects/:mediaId", (input, saved) => projects.read(input.path.mediaId, saved.access), { noStore: true });
  add("project.save", "PUT", "/projects/:mediaId", async (input, saved) => ({ revision: (await projects.save(input.path.mediaId, input.body, saved.access)).revision }), { body: json(64 * 1024 ** 2, contracts.requests.projectSave), noStore: true });
  const workbenchBody = { body: json(64 * 1024 ** 2, ignored), noStore:true };
  add("workbench.definition", "GET", "/v2/definition", () => projects.definition, { noStore:true });
  add("workbench.projects-create", "POST", "/v2/projects", (input,saved) => projects.createProjectV2(input.body,saved.access), workbenchBody);
  add("workbench.project-read", "GET", "/v2/projects/:projectId", (input,saved) => projects.readProject(input.path.projectId,saved.access), {noStore:true});
  add("workbench.project-save", "PUT", "/v2/projects/:projectId", (input,saved) => projects.saveProject(input.path.projectId,input.body,saved.access), workbenchBody);
  add("workbench.project-migrate", "POST", "/v2/projects/:projectId/migrate", (input,saved) => projects.migrateProject(input.path.projectId,input.body,saved.access), workbenchBody);
  add("workbench.canvases-list", "GET", "/v2/projects/:projectId/canvases", (input, saved, timing) => projects.listCanvases(input.path.projectId, Object.fromEntries(input.url.searchParams), saved.access, timing), { noStore: true, listTiming: true });
  add("workbench.canvas-create", "POST", "/v2/projects/:projectId/canvases", (input,saved) => projects.createCanvas(input.path.projectId,input.body,saved.access), workbenchBody);
  add("workbench.canvas-copy", "POST", "/v2/projects/:projectId/canvases/copy", (input,saved) => projects.copyCanvas(input.path.projectId,input.body,saved.access), workbenchBody);
  add("workbench.canvas-import", "POST", "/v2/projects/:projectId/canvases/import", (input,saved) => projects.importCanvas(input.path.projectId,input.body,saved.access), workbenchBody);
  add("workbench.canvas-read", "GET", "/v2/projects/:projectId/canvases/:canvasId", (input, saved) => projects.readCanvas(input.path.projectId, input.path.canvasId, saved.access), { noStore: true });
  add("workbench.canvas-thumbnail", "GET", "/v2/projects/:projectId/canvases/:canvasId/thumbnail", (input, saved) =>
    projects.readCanvasThumbnail(input.path.projectId, input.path.canvasId, input.url.searchParams.get("revision") ?? "", saved.access), { noStore: true });
  add("workbench.canvas-export", "GET", "/v2/projects/:projectId/canvases/:canvasId/export", (input,saved) => projects.exportCanvas(input.path.projectId,input.path.canvasId,input.url.searchParams.get("format"),saved.access), {noStore:true});
  add("workbench.canvas-save", "PUT", "/v2/projects/:projectId/canvases/:canvasId", (input,saved) => projects.saveCanvas(input.path.projectId,input.path.canvasId,input.body,saved.access), workbenchBody);
  add("workbench.media-read", "GET", "/v2/projects/:projectId/canvases/:canvasId/editor", (input,saved) => projects.readMediaEditor(input.path.projectId,input.path.canvasId,saved.access), {noStore:true});
  add("workbench.media-save", "PUT", "/v2/projects/:projectId/canvases/:canvasId/editor", (input,saved) => projects.saveMediaEditor(input.path.projectId,input.path.canvasId,input.body,saved.access), workbenchBody);
  add("workbench.index-rebuild", "POST", "/v2/projects/:projectId/index/rebuild", (input,saved) => projects.rebuildCanvasIndex(input.path.projectId,saved.access), {noStore:true});
  add("workbench.trigger-read", "GET", "/v2/projects/:projectId/canvases/:canvasId/triggers/:mediaId", input => runs.readTrigger(input.path.projectId,input.path.canvasId,input.path.mediaId), {noStore:true});
  add("workbench.trigger", "POST", "/v2/projects/:projectId/canvases/:canvasId/trigger", (input,saved) => runs.trigger(input.path.projectId,input.path.canvasId,input.body,saved.access), {...workbenchBody,status:202});
  add("workbench.run-create", "POST", "/v2/projects/:projectId/canvases/:canvasId/runs", (input,saved) => runs.start(input.path.projectId,input.path.canvasId,input.body,saved.access), {...workbenchBody,status:202});
  add("workbench.runs-list", "GET", "/v2/projects/:projectId/canvases/:canvasId/runs", input => runs.list(input.path.projectId,input.path.canvasId,Object.fromEntries(input.url.searchParams)), {noStore:true});
  add("workbench.run-read", "GET", "/v2/runs/:mediaId", input => runs.read(input.path.mediaId), {noStore:true});
  add("workbench.run-refresh", "POST", "/v2/runs/:mediaId/refresh", (input,saved) => runs.refresh(input.path.mediaId,saved.access), {noStore:true});
  add("workbench.run-logs", "GET", "/v2/runs/:mediaId/logs", input => runs.logs(input.path.mediaId,Number(input.url.searchParams.get("after")||0),Number(input.url.searchParams.get("limit")||100)), {noStore:true});
  add("workbench.run-cancel", "POST", "/v2/runs/:mediaId/cancel", (input,saved) => runs.cancel(input.path.mediaId,saved.access), {noStore:true});
  add("workbench.run-human", "POST", "/v2/runs/:mediaId/complete", (input,saved) => runs.completeHuman(input.path.mediaId,input.body,saved.access), workbenchBody);
  add("compute.status", "GET", "/compute/status", () => owner.computeStatus(), { compute: true });
  add("compute.runtime-start", "POST", "/compute/runtime/start", async (_, saved) => { await owner.startLocal(saved.access); return owner.computeStatus(); }, { compute: true });
  add("compute.runtime-stop", "POST", "/compute/runtime/stop", async (_, saved) => { await service.stop(saved.access); return owner.computeStatus(); }, { compute: true });
  add("compute.asset-remove", "DELETE", "/compute/assets/:mediaId", (input, saved) => owner.removeComputeAsset(input.path.mediaId, saved.access), { compute: true });
  add("compute.job-submit", "POST", "/compute/jobs", (input, saved) => service.submit(input.body, input.request.headers["idempotency-key"], saved.access, { computeOnly: true }), { body: json(25 * 1024 ** 2, contracts.requests.command), status: 202, compute: true });
  add("compute.job-read", "GET", "/compute/jobs/:mediaId", (input) => service.view(owner.job(input.path.mediaId, true)), { compute: true });
  add("compute.job-remove", "DELETE", "/compute/jobs/:mediaId", (input, saved) => { owner.job(input.path.mediaId, true); return service.removeCompute(input.path.mediaId, saved.access); }, { compute: true });
  const model = (name: string, method: ApiMethod, suffix: string, local: (input: ApiOperationInput, saved: Admission) => unknown, body?: Options["body"]) => add(name, method, suffix, (input, saved) => saved.deviceId ? owner.remoteModel(saved, input.url.pathname.slice(root.length), method, ["POST", "PATCH"].includes(method) ? input.body : undefined, input.signal) : local(input, saved), { model: true, ...(body ? { body } : {}) });
  model("models.read", "GET", "/models", (_, saved) => models.snapshot(saved.access));
  model("models.initialization", "GET", "/models/initialization", (_, saved) => models.downloadPlan(undefined, saved.access));
  model("models.initialize", "POST", "/models/initialize", (input, saved) => service.exclusive(() => models.initializeModels(input.body, saved.access), saved.access), json(4096, contracts.requests.initialization));
  model("models.settings-read", "GET", "/models/settings", () => models.directories());
  model("models.settings-save", "PATCH", "/models/settings", (input, saved) => service.exclusive(() => models.configure(input.body, saved.access), saved.access), json(4096, contracts.requests.settings));
  add("status", "GET", "/status", (_, saved) => service.snapshotFor(saved.deviceId, saved.access));
  add("runtime.start", "POST", "/runtime/start", (_, saved) => saved.deviceId ? service.startRemote(saved.deviceId, saved.access) : owner.startLocal(saved.access));
  add("runtime.stop", "POST", "/runtime/stop", async (_, saved) => { if (!saved.deviceId) return service.stop(saved.access); await service.remote.json(saved.deviceId, "/compute/runtime/stop", { method: "POST" }, saved.access); return service.snapshotFor(saved.deviceId, saved.access); });
  add("jobs.submit", "POST", "/jobs", (input, saved) => service.submit(input.body, input.request.headers["idempotency-key"], saved.access, { deviceId: saved.deviceId }), { status: 202, body: json(25 * 1024 ** 2, contracts.requests.command) });
  add("jobs.list", "GET", "/jobs", () => ({ jobs: service.snapshot().jobs }));
  add("job.read", "GET", "/jobs/:mediaId", input => service.view(owner.job(input.path.mediaId)));
  add("job.cancel", "POST", "/jobs/:mediaId/cancel", (input, saved) => { owner.job(input.path.mediaId); return service.cancel(input.path.mediaId, saved.access); });
  const sse = (name: string, suffix: string, computeJob: boolean) => {
    const nativeContract = contract(name, "GET", suffix, { compute: computeJob });
    const streamContract: ApiOperationContract = { ...nativeContract, transport: "sse", responses: { "200": { mediaType: "text/event-stream", stream: { framing: "bytes", maxFrameBytes: 1024 * 1024, completion: "Native compute notifications; job stream completes at its terminal receipt.", cancellation: "Detach native publish subscriptions and heartbeat timers, unblock iterator and join cleanup." } }, default: nativeContract.responses.default! } };
    const run = async (input: ApiOperationInput, saved: Admission) => {
      let stream: ApiOperationStream | undefined;
      try {
        saved.access.assert(); if (computeJob) await service.reapCompute(saved.access);
        stream = computeJob ? events.job(service, owner.job(input.path.mediaId, true), saved.access) : events.compute(saved.access);
        saved.access.assert(); return { status: 200, headers: { "cache-control": "no-store" }, stream };
      } catch (cause) { await stream?.cancel(cause); return presentVideoError(cause, saved.access, "GET"); }
    };
    operations.push({ contract: streamContract, discovery: videoDiscovery(name),
      prepare(input) { try { const saved: Admission = owner.prepare(input.request, input.url); return full => run(full, saved); } catch (cause) { return presentVideoError(cause, undefined, "GET"); } },
      handler(input) { try { return run(input, owner.prepare(input.request, input.url)); } catch (cause) { return presentVideoError(cause, undefined, "GET"); } }
    });
  };
  sse("compute.events", "/compute/events", false); sse("compute.job-events", "/compute/jobs/:mediaId/events", true);
  const proxy = (name: string, method: ApiMethod, suffix: string, action: (input: Parameters<ApiHttpProxyDefinition["handler"]>[0], saved: Admission) => Promise<unknown>, options: Options = {}) => {
    const base = contract(name, method, suffix, options);
    proxies.push({ discovery: videoDiscovery(name), contract: { ...base, request: { ...base.request, body: { kind: "passthrough" } }, responses: { default: { mediaType: "*/*", passthrough: true } }, httpProxy: { wire: { dataFrameBytes: 65536, streamWindowBytes: 1048576, maxConcurrentStreams: 8 }, completion: "Native binary upload publication, file EOF or original selected-peer JSON result.", cancellation: "Abort the original request reader/native file and join service cleanup; no replay or alternate compute target." } }, async handler(input) {
      let saved: Admission | undefined, content: VideoMediaContent | undefined;
      const aborted = () => { if (content) void content.cancel().catch(() => undefined); if (!input.request.complete) input.request.destroy(); };
      input.signal.addEventListener("abort", aborted, { once: true });
      try {
        const admission: Admission = owner.prepare(input.request, input.url, options.model); saved = admission;
        if (options.compute) await service.reapCompute(admission.access);
        const value = await action(input, admission);
        const metadata = options.assetMetadata && input.url.searchParams.get("metadata") === "1";
        if (options.media && !metadata) { if (!isMediaContent(value)) throw new Error("Native media owner returned an invalid stream."); content = value; }
        admission.access.assert(); input.assertCurrent();
        if (content) {
          input.prepareResponse(content.status, content.headers); input.response.writeHead(content.status, content.headers); for await (const chunk of content.frames) { admission.access.assert(); input.assertCurrent(); if (!input.response.write(chunk)) await once(input.response, "drain", { signal: input.signal }); } admission.access.assert(); input.assertCurrent(); input.response.end();
        } else {
          const headers = { "content-type": "application/json; charset=utf-8", ...(options.model ? { "cache-control": "no-store" } : {}) };
          input.prepareResponse(options.status ?? 200, headers); input.response.writeHead(options.status ?? 200, headers);
          input.response.end(JSON.stringify(metadata ? assetMetadata(value) : value));
        }
      } catch (cause) {
        if (input.response.headersSent) { input.response.destroy(); throw cause; }
        const error = presentVideoError(cause, saved?.access, input.request.method ?? method), outcome = error.mutationOutcome;
        // Only the original access owner classifies dispatch. Preserve that trusted evidence
        // through the common authority fence without disclosing any native business result.
        if (outcome === "not_started" || outcome === "unknown") throw new ApiContractError(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization", base.operationId, outcome === "unknown", outcome);
        const headers = { "content-type": "application/json; charset=utf-8", ...(error.headers ?? {}) }; input.prepareResponse(error.status, headers); input.response.writeHead(error.status, headers); input.response.end(JSON.stringify(error.body));
      }
      finally { input.signal.removeEventListener("abort", aborted); await content?.cancel?.(); }
    } });
  };
  proxy("assets.upload", "POST", "/assets", (input, saved) => assets.upload(input.request, input.url.searchParams.get("kind"), saved.access, saved.deviceId ? (kind: string, file: string, access: VideoRequestAccess) => service.remote.inspect(saved.deviceId, kind, file, access) : undefined), { status: 201 });
  proxy("asset.content", "GET", "/assets/:mediaId", (input, saved) => owner.assetContent(input.path.mediaId, input.request, saved.access, input.signal, input.url.searchParams.get("metadata") === "1"), { media: true, assetMetadata: true });
  proxy("compute.assets-upload", "POST", "/compute/assets", (input, saved) => computeAssets.upload(input.request, input.url.searchParams.get("kind"), saved.access), { compute: true, status: 201 });
  for (const compute of [false, true]) for (const kind of ["image", "video"]) proxy((compute ? "compute." : "") + "job-" + kind, "GET", (compute ? "/compute" : "") + "/jobs/:mediaId/" + kind, (input, saved) => owner.jobContent(input.path.mediaId, kind, compute, input.request, saved.access, input.signal), { compute, media: true });
  const modelProxy = (name: string, suffix: string, local: (saved: Admission, input: Parameters<ApiHttpProxyDefinition["handler"]>[0]) => Promise<unknown>) => proxy(name, "POST", suffix, async (input, saved) => {
    if (!saved.deviceId) { input.request.resume(); return local(saved, input); }
    return owner.remoteModel(saved, input.url.pathname.slice(root.length), "POST", await owner.readModelBody(input.request, saved.access), input.signal);
  }, { model: true });
  modelProxy("models.runtime-install", "/models/runtime", saved => owner.installRuntime(saved.access));
  proxy("workbench.artifact-content","GET","/v2/runs/:mediaId/artifacts",(input,saved)=>runs.artifactContent(input.path.mediaId,input.url.searchParams.get("artifact")||"",input.request,saved.access,input.signal),{media:true});
  modelProxy("model.download", "/models/:modelId/download", (saved, input) => service.exclusive(() => models.download(input.path.modelId, saved.access), saved.access));
  proxy("models.remote-exchange", "*", "/models:suffix", async (input, saved) => {
    if (!saved.deviceId) { input.request.resume(); return owner.unmatchedModel(); }
    const method = input.request.method ?? "GET";
    const body = ["POST", "PATCH"].includes(method) ? await owner.readModelBody(input.request, saved.access) : undefined;
    if (body === undefined) input.request.resume();
    return owner.remoteModel(saved, input.url.pathname.slice(root.length), method, body, input.signal);
  }, { model: true, rawRemainder: "suffix" });
  return Object.freeze({ operations, proxies, owner });
}
