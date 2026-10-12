import fs from "node:fs/promises";
import path from "node:path";
import { validateCommand } from "./workflow.mjs";
import { assetTypes } from "./assets.mjs";
import { VideoError } from "./service.mjs";
import { safeTarget } from "./models.mjs";

// The workspace remains local. Peer records are execution receipts and temporary inputs only.
export class RemoteVideoCompute {
  constructor(runtime, catalog, publish, jobs = []) {
    this.runtime = runtime; this.catalog = catalog; this.publish = publish;
    this.blocked = new Set([...jobs].filter(job=>job.computeDeviceId && job.computeOutcome === "unknown" && !job.computeResumedAt).map(job=>job.computeDeviceId));
  }
  async response(deviceId, route, init = {}, access) {
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 200) throw new VideoError("模型服务电脑编号无效。");
    access?.assert();
    if (this.runtime.readOnly && init.method && !["GET","HEAD"].includes(init.method)) throw new VideoError("只读模式下不能操作远端算力。",423);
    if (init.method && !["GET", "HEAD"].includes(init.method)) access?.beforeMutation();
    const timeout = route.endsWith("/events") ? 2 * 60 * 60 * 1000 : 120000;
    let response;
    try {
      response = await this.runtime.peerFetch(deviceId, `/api/video${route}`, {
        ...init, signal: init.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      });
    } catch {access?.assert();throw new VideoError("远端模型服务连接失败，请检查所选电脑。",502);}
    access?.assert();
    if (!response.ok) {
      const body = await response.json().catch(() => ({})); access?.assert();
      throw new VideoError(body.message || `远端模型服务请求失败（HTTP ${response.status}）。`, response.status);
    }
    return response;
  }
  async json(deviceId, route, init, access) {
    const value = await (await this.response(deviceId, route, init, access)).json(); access?.assert(); return value;
  }
  async status(deviceId, access) {
    const value = await this.json(deviceId, "/compute/status", {}, access);
    if (value.computeProtocol !== 1 || !Array.isArray(value.availableWorkflows)) throw new VideoError("该电脑需要更新媒体算力接口。", 426);
    return { ...value, online: value.online && !this.blocked.has(deviceId), ...(this.blocked.has(deviceId) ? {computeError:"该电脑有结果未确认的推理，请核对原回执后再启动。"} : {}) };
  }
  async start(deviceId, access) {
    const value = await this.json(deviceId, "/compute/runtime/start", { method: "POST" }, access);
    this.blocked.delete(deviceId); return value;
  }
  async upload(deviceId, kind, file, access) {
    const type = assetTypes[kind];
    if (!type) throw new VideoError("参考素材类型无效。");
    const bytes = await fs.readFile(file); access?.assert();
    if (bytes.length > type.maxBytes) throw new VideoError("参考素材过大。", 413);
    const record = await this.json(deviceId, `/compute/assets?kind=${kind}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes }, access);
    if (!/^[a-f0-9-]{36}$/.test(record.id) || record.kind !== kind || record.size !== bytes.length) throw new VideoError("远端临时输入回执无效。",502);
    return record;
  }
  async inspect(deviceId, kind, file, access) {
    const record = await this.upload(deviceId, kind, file, access);
    await this.json(deviceId, `/compute/assets/${record.id}`, { method: "DELETE" }, access).catch(()=>{access?.assert();});
    const { id, size, kind: ignored, ...metadata } = record;
    return metadata;
  }
  async run(job, assets, save, signal) {
    const deviceId = job.computeDeviceId;
    let remoteId;
    let submissionAttempted = false;
    const references = [];
    try {
      const command = validateCommand(Object.fromEntries(Object.entries(job).filter(([key]) => ["model","prompt","width","height","frames","seed","firstFrame","lastFrame","references","generateAudio","referenceVideoSound","quickGeneration"].includes(key))), this.catalog);
      for (const id of command.references || []) {
        const {record, file} = await assets.file(id);
        references.push((await this.upload(deviceId, record.kind, file)).id);
      }
      if (command.references) command.references = references;
      submissionAttempted = true;
      const submitted = await this.json(deviceId, "/compute/jobs", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": `compute:${job.id}` }, body: JSON.stringify(command), signal
      });
      if (!/^[a-f0-9-]{36}$/.test(submitted.id)) throw new VideoError("远端推理回执无效。", 502);
      remoteId = submitted.id; job.providerJobId = remoteId; await save(job);
      let state = submitted;
      if (!this.catalog.states[state.status]?.terminal) {
        const response = await this.response(deviceId, `/compute/jobs/${remoteId}/events`, {signal});
        if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw new VideoError("远端推理事件接口无效。",502);
        const decoder = new TextDecoder();let buffer="";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk,{stream:true});
          let boundary;
          while ((boundary=buffer.indexOf("\n\n")) >= 0) {
            if (boundary > 65536) throw new VideoError("远端推理事件过大。",502);
            const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const data=event.split("\n").find(line=>line.startsWith("data: "));
            if (!data) continue;
            state=JSON.parse(data.slice(6));
            if (state.id !== remoteId || !this.catalog.states[state.status]) throw new VideoError("远端推理事件归属无效。",502);
            const patch = Object.fromEntries(["progress","progressStage","progressValue","progressMax","progressUnit"].filter(key => state[key] !== undefined).map(key => [key, state[key]]));
            Object.assign(job, patch); this.publish("video.progress", { jobId: job.id, startedAt: job.startedAt, ...patch });
          }
          if (buffer.length > 65536) throw new VideoError("远端推理事件过大。",502);
          if (this.catalog.states[state.status]?.terminal) break;
        }
        if (!this.catalog.states[state.status]?.terminal) throw new VideoError("远端推理事件中断，任务未自动重试。",502);
      }
      job.computeOutcome = state.status;
      if (state.outputPurged) throw new VideoError("远端推理结果已清理，原任务未重新执行。",410);
      if (state.status !== "succeeded") throw new VideoError(state.error || "远端推理失败，任务未自动重试。", 502);
      const image = this.catalog.models.find(row => row.id === job.model)?.mode === "image";
      const response = await this.response(deviceId, `/compute/jobs/${remoteId}/${image ? "image" : "video"}`, {signal});
      const root = path.join(this.runtime.stateRoot, "provider-output"); await fs.mkdir(root, {recursive:true});
      const filename = `${job.id}.${image ? "png" : "mp4"}`, temporary = await safeTarget(root, `${filename}.tmp`);
      let size = 0;
      const handle = await fs.open(temporary, "wx");
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 512 * 1024 ** 2) throw new VideoError("远端输出超出文件大小限制。", 413);
          await handle.writeFile(chunk);
        }
      } catch (error) { await handle.close(); await fs.rm(temporary, {force:true}); throw error; }
      finally { await handle.close().catch(() => {}); }
      await fs.rename(temporary, await safeTarget(root, filename));
      job.output = { filename, subfolder: "" };
      // The local queue verifies the container before marking the workspace job successful.
    } catch (error) {
      // No fallback or replay after an uncertain write. Explicit start is required to resume this target.
      this.blocked.add(deviceId);
      if (submissionAttempted && !this.catalog.states[job.computeOutcome]?.terminal) job.computeOutcome = "unknown";
      throw error;
    } finally {
      // Assets can be removed only after a terminal receipt; unknown work retains its inputs.
      if (!submissionAttempted) for (const id of references) await this.json(deviceId, `/compute/assets/${id}`, {method:"DELETE"}).catch(() => {});
    }
  }
  async finish(job) {
    // Cleanup failure does not invalidate a verified, durable workspace result.
    await this.json(job.computeDeviceId, `/compute/jobs/${job.providerJobId}`, {method:"DELETE"}).catch(()=>{});
  }
}
