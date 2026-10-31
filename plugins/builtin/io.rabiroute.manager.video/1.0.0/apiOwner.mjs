import path from "node:path";
import { checkedFs, checkedReadBody } from "./requestAccess.mjs";
import { VideoError } from "./service.mjs";
import { assetTypes } from "./assets.mjs";
import { openMedia } from "./media.mjs";

export function presentVideoError(cause, access, method = "GET") {
  try { access?.assert(); } catch (denied) { cause = denied; }
  if (cause?.code === "VIDEO_REQUEST_FORBIDDEN" || access?.denied) return {
    status: 403, headers: { "cache-control": "no-store" },
    ...(method !== "GET" ? { mutationOutcome: access?.mutationStarted ? "unknown" : "not_started" } : {}),
    body: { error: "forbidden", message: "视频请求权限已失效。", ...(method !== "GET" ? { mutation: access?.mutationStarted ? "unknown" : "not_started" } : {}) }
  };
  return { status: cause instanceof VideoError ? cause.status : 503, body: { message: cause instanceof VideoError ? cause.message : "视频服务不可用，请检查运行环境与视频服务日志。" } };
}

/** Original services own all state, queues, files, processes and durable receipts. */
export function createVideoOperationsOwner(context) {
  const { runtime, service, models, assets, computeAssets, projects, catalog, events } = context;
  return Object.freeze({
    runtime, service, models, assets, computeAssets, projects, catalog, events,
    error: presentVideoError,
    readModelBody(request, access) { return checkedReadBody(context, request, 4096, access); },
    prepare(request, url, model = false) {
      const access = runtime.requestAccess(request); access.assert();
      context.assertReady?.();
      const deviceId = url.searchParams.get("computeDeviceId") || "";
      if (deviceId.length > 200) throw new VideoError("模型服务电脑编号无效。");
      if (model && !runtime.localSettingsAllowed(request)) throw new VideoError("模型管理仅允许本机页面或已认证启用的 Agent 访问。", 403);
      return { access, deviceId };
    },
    async result(saved, method, operation, status = 200, headers) {
      try { saved.access.assert(); const body = await operation(); saved.access.assert(); return { status, body, ...(headers ? { headers } : {}) }; }
      catch (cause) { return presentVideoError(cause, saved.access, method); }
    },
    computeStatus() { const { jobs, ...status } = service.snapshot(); return { ...status, computeProtocol: 1, frameAdaptationAvailable: service.frameAdaptationAvailable }; },
    async startLocal(access) {
      if (models.flight) throw new VideoError("请等待安装结束。", 409);
      return service.start(() => models.runtimeRoots(), async () => { if (models.flight) throw new VideoError("请等待安装结束。", 409); await models.assertStartable(access); }, access);
    },
    async installRuntime(access) {
      return service.exclusive(async () => {
        models.guard(); const fs = checkedFs(access);
        await fs.mkdir(runtime.componentRoot, { recursive: true });
        await fs.copyFile(new URL("./install-runtime.ps1", import.meta.url), path.join(runtime.componentRoot, "install-runtime.ps1"));
        return models.installRuntime(access);
      }, access);
    },
    remoteModel(saved, route, method, body, signal) {
      return service.remote.json(saved.deviceId, route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ...(signal ? { signal } : {}) }, saved.access);
    },
    unmatchedModel() { throw new VideoError("模型管理接口不存在。", 404); },
    job(id, compute = false) {
      const job = service.jobs.get(id);
      if (!job || Boolean(job.computeOnly) !== compute) throw new VideoError(compute ? "推理接口或回执不存在。" : "视频 API 或任务不存在。", 404);
      return job;
    },
    async removeComputeAsset(id, access) {
      if ([...service.jobs.values()].some(job => !catalog.states[job.status].terminal && job.references?.includes(id))) throw new VideoError("推理仍在使用该输入。", 409);
      await computeAssets.remove(id, access); return { removed: true };
    },
    async assetContent(id, request, access, signal, metadata = false) { const { record, file } = await assets.file(id, access); return metadata ? { metadata: record } : openMedia(request, file, assetTypes[record.kind].mime, undefined, access, { signal }); },
    async jobContent(id, kind, compute, request, access, signal) {
      const job = this.job(id, compute);
      if (compute && job.outputPurged) throw new VideoError("推理结果已清理，原任务不会重新执行。", 410);
      const image = catalog.models.find(row => row.id === job.model)?.mode === "image";
      if (job.status !== "succeeded" || compute && kind !== (image ? "image" : "video")) throw new VideoError(compute ? "推理结果未就绪或类型不匹配。" : "视频尚未生成。", 409);
      if (kind !== (image ? "image" : "video")) throw new VideoError("结果类型不匹配。", 404);
      return openMedia(request, await service.outputPath(job, access), image ? "image/png" : "video/mp4", compute ? undefined : `${job.id}.${image ? "png" : "mp4"}`, access, { signal });
    }
  });
}

/** Native publish subscriptions; no state polling and no duplicate job store. */
export function createVideoApiEvents(catalog) {
  const computeListeners = new Set(), jobListeners = new Map(), streams = new Set(); let closed = false;
  const subscribe = (access, event, snapshot, terminal, jobId) => {
    if (closed) throw new VideoError("视频服务正在停止。", 503);
    if ((jobId ? streams.size : computeListeners.size) >= 64) throw new VideoError(jobId ? "推理订阅过多。" : "模型状态订阅过多。", 429);
    let wake, stopped = false, ended = false; const queue = [], controller = new AbortController();
    const enqueue = value => { if (stopped) return; try { access.assert(); if (queue.length >= 64) throw new Error("Video event consumer stalled."); queue.push(Buffer.from(value)); wake?.(); } catch (cause) { controller.abort(cause); wake?.(); } };
    const send = name => { try { access.assert(); enqueue(`event: ${event}\ndata: ${JSON.stringify(snapshot(name))}\n\n`); if (terminal?.()) { ended = true; wake?.(); } } catch (cause) { controller.abort(cause); wake?.(); } };
    const listeners = jobId ? jobListeners.get(jobId) || new Set() : computeListeners;
    if (jobId) jobListeners.set(jobId, listeners); listeners.add(send);
    const cancel = async () => { if (stopped) return; stopped = true; clearInterval(heartbeat); listeners.delete(send); if (jobId && !listeners.size) jobListeners.delete(jobId); streams.delete(cancel); queue.length = 0; wake?.(); };
    const heartbeat = setInterval(() => { if (jobId) enqueue(": heartbeat\n\n"); else send("heartbeat"); }, 20000); heartbeat.unref?.();
    streams.add(cancel); send("video.models");
    const frames = (async function* () { try { while (!stopped && !controller.signal.aborted) { if (!queue.length) { if (ended) break; await new Promise(resolve => { wake = resolve; }); } if (stopped || controller.signal.aborted) break; const frame = queue.shift(); if (frame) { access.assert(); yield frame; } } } finally { await cancel(); } })();
    return { frames, signal: controller.signal, cancel };
  };
  return Object.freeze({
    publish(name, data) {
      if (["video.models", "video.changed"].includes(name)) for (const listener of [...computeListeners]) listener(name);
      if (data?.jobId && ["video.changed", "video.progress"].includes(name)) for (const listener of [...(jobListeners.get(data.jobId) || [])]) listener();
    },
    compute(access) { return subscribe(access, "compute", name => ({ name })); },
    job(service, job, access) { return subscribe(access, "progress", () => service.view(job), () => catalog.states[job.status].terminal, job.id); },
    async close() { closed = true; await Promise.all([...streams].map(cancel => cancel())); },
    active() { return streams.size; }
  });
}
