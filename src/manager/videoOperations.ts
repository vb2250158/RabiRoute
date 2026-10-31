import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { createVideoRuntime, VideoRequestAccess } from "./videoRuntime.js";
import { ApiContractError } from "./apiOperationContract.js";
import type { ApiHttpProxyDefinition, ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiOperationStream, ApiSchema, ApiMethod } from "./apiOperationContract.js";

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
  projects: { recordIssues?: readonly unknown[]; list(access: VideoRequestAccess): Promise<unknown[]>; create(body: unknown, access: VideoRequestAccess): Promise<unknown>; read(id: string, access: VideoRequestAccess): Promise<unknown>; save(id: string, body: unknown, access: VideoRequestAccess): Promise<{ revision: number }> };
  events: { compute(access: VideoRequestAccess): ApiOperationStream; job(service: VideoNativeService, job: VideoNativeJob, access: VideoRequestAccess): ApiOperationStream };
};
type Options = { body?: ApiOperationContract["request"]["body"]; status?: number; model?: boolean; compute?: boolean; noStore?: boolean; media?: boolean; assetMetadata?: boolean; rawRemainder?: string };
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

/** Fixed Video APIs, derived once for execution and discovery. No boolean HTTP dispatcher. */
export function createVideoOperations(context: VideoOperationsContext) {
  const { owner, service, models, assets, computeAssets, projects, events, contracts } = context, presentVideoError = owner.error;
  const operations: ApiOperationDefinition[] = [], proxies: ApiHttpProxyDefinition[] = [];
  const contract = (name: string, method: ApiMethod, suffix: string, options: Options = {}): ApiOperationContract => ({
    operationId: "manager.video." + name, ...(method === "*" ? {} : { aliases: [`video:${method}:${root}${suffix}`] }), contractVersion: "1.0.0", method, pathTemplate: root + suffix,
    exposure: "public", transport: "http", description: "Use the original video " + name + " owner.",
    request: { path: options.rawRemainder ? { type: "object", required: [options.rawRemainder], properties: { [options.rawRemainder]: { type: "string" } }, additionalProperties: false } : suffix.includes(":modelId") ? idSchema("modelId", "^[a-z0-9-]+$") : suffix.includes(":mediaId") ? idSchema("mediaId") : empty,
      ...(options.rawRemainder ? { pathRemainder: options.rawRemainder } : {}),
      query: { ...ignored, properties: { computeDeviceId: { type: "string", description: "Original selected peer; first query value is used, maximum 200 characters. Projects and saved outputs remain local." }, ...(name.endsWith("upload") ? { kind: { description: "Native image/video/audio selection; omitted value defaults to image. Original MIME, limits and inspection remain native." } } : {}), ...(options.assetMetadata ? { metadata: { description: "Only the first query value exactly equal to 1 selects JSON metadata; every other value keeps original media." } } : {}) } }, headers: { ...ignored, ...(name === "jobs.submit" || name === "compute.job-submit" ? { properties: { "idempotency-key": { description: "Required original 8–128 ASCII [A-Za-z0-9._:-] key. Native 400 for invalid key, 409 for same key with different normalized intent; workspace and compute scopes stay separate." } } } : {}) },
      body: options.body ?? { kind: "none", allowIgnoredBody: true } },
    responses: { [String(options.status ?? 200)]: { mediaType: "application/json", schema: contracts.responses[name] ?? { description: "Native exchange metadata; raw media and selected-peer extensions retain their own wire contract." } }, default: { mediaType: "application/json", schema: { type: "object", properties: { message: { type: "string" }, error: { type: "string" }, mutation: { enum: ["not_started", "unknown"] } }, additionalProperties: true } } },
    effects: { mode: method === "GET" ? options.compute ? "native-read-and-compute-retention" : "native-read" : "native-video-action", description: "Original service retains project revisions, job keys, resource ownership, read-only checks, process leases, model roots and background lifecycle." },
    recovery: { strategy: "inspect-original-project-job-or-model-operation", description: "Keep the original project revision, Idempotency-Key, workspace job, selected compute peer and remote receipt. Uncertain work is never automatically replayed or moved to local compute.", ...(name === "jobs.submit" || name === "compute.job-submit" ? { idempotencyHeader: "Idempotency-Key" } : {}) },
    validators: [...contracts.validators, { id: "video-native-owner", description: "Capture original request authority before body consumption; recheck in native queue/fs/process/network boundaries and before disclosure. Existing body caps and native DTO validators remain authoritative." }]
  });
  const add = (name: string, method: ApiMethod, suffix: string, invoke: (input: ApiOperationInput, saved: Admission) => unknown, options: Options = {}) => {
    const run = (input: ApiOperationInput, saved: Admission) => owner.result(saved, method, async () => { if (options.compute) await service.reapCompute(saved.access); return invoke(input, saved); }, options.status ?? 200, options.noStore || options.model ? { "cache-control": "no-store" } : undefined);
    const definition: ApiOperationDefinition = { contract: contract(name, method, suffix, options),
      prepare(input) { try { const saved = owner.prepare(input.request, input.url, options.model); return full => run(full, saved); } catch (cause) { return presentVideoError(cause, undefined, method); } },
      handler(input) { try { return run(input, owner.prepare(input.request, input.url, options.model)); } catch (cause) { return presentVideoError(cause, undefined, method); } }
    }; operations.push(definition); return definition;
  };
  add("projects.list", "GET", "/projects", (_, saved) => projects.list(saved.access).then((value: unknown) => ({ projects: value, recordIssues: projects.recordIssues ?? [] })), { noStore: true });
  add("projects.create", "POST", "/projects", (input, saved) => projects.create(input.body, saved.access), { body: json(4096, contracts.requests.projectCreate), noStore: true });
  add("project.read", "GET", "/projects/:mediaId", (input, saved) => projects.read(input.path.mediaId, saved.access), { noStore: true });
  add("project.save", "PUT", "/projects/:mediaId", async (input, saved) => ({ revision: (await projects.save(input.path.mediaId, input.body, saved.access)).revision }), { body: json(64 * 1024 ** 2, contracts.requests.projectSave), noStore: true });
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
    operations.push({ contract: streamContract,
      prepare(input) { try { const saved: Admission = owner.prepare(input.request, input.url); return full => run(full, saved); } catch (cause) { return presentVideoError(cause, undefined, "GET"); } },
      handler(input) { try { return run(input, owner.prepare(input.request, input.url)); } catch (cause) { return presentVideoError(cause, undefined, "GET"); } }
    });
  };
  sse("compute.events", "/compute/events", false); sse("compute.job-events", "/compute/jobs/:mediaId/events", true);
  const proxy = (name: string, method: ApiMethod, suffix: string, action: (input: Parameters<ApiHttpProxyDefinition["handler"]>[0], saved: Admission) => Promise<unknown>, options: Options = {}) => {
    const base = contract(name, method, suffix, options);
    proxies.push({ contract: { ...base, request: { ...base.request, body: { kind: "passthrough" } }, responses: { default: { mediaType: "*/*", passthrough: true } }, httpProxy: { wire: { dataFrameBytes: 65536, streamWindowBytes: 1048576, maxConcurrentStreams: 8 }, completion: "Native binary upload publication, file EOF or original selected-peer JSON result.", cancellation: "Abort the original request reader/native file and join service cleanup; no replay or alternate compute target." } }, async handler(input) {
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
