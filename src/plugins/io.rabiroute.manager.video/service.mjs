import { validJobView } from "./contracts.mjs";
import fs from "node:fs/promises";
import { checkedFs } from "./requestAccess.mjs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildWorkflow, validateCommand, resolveWorkflow } from "./workflow.mjs";
import { readProgressEvent } from "./progress.mjs";

export class VideoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class VideoService {
  constructor(runtime, catalog, publish, dependencies = {}) {
    this.runtime = runtime;
    this.catalog = catalog;
    this.publish = publish;
    this.fetch = dependencies.fetch ?? fetch;
    this.WebSocket = dependencies.WebSocket ?? WebSocket;
    this.jobs = new Map();
    this.ownsJobState = false;
    this.recordIssues = [];
    this.reservedKeys = new Set();
    this.unknownKeyScopes = new Set();
    this.endpoint = "";
    this.online = false;
    this.frameAdaptationAvailable = false;
    this.closing = false;
    this.active = undefined;
    this.serial = Promise.resolve();
    this.controller = new AbortController();
    this.unsubscribeExit = runtime.onExit?.(() => { this.online = false; this.publish("video.changed", { online: false }); });
  }
  exclusive(action, access) {
    access?.assert();
    const next = this.serial.then(() => { access?.assert(); return action(); });
    this.serial = next.catch(() => {});
    return next;
  }
  async initialize({ recover = true } = {}) {
    // Candidate validation may load existing records, but only the published owner
    // may recover or persist them. Reload after the previous owner actually drains.
    this.jobs.clear(); this.recordIssues = []; this.reservedKeys.clear(); this.unknownKeyScopes.clear();
    this.ownsJobState = recover && !this.runtime.readOnly;
    if (this.ownsJobState) await fs.mkdir(path.join(this.runtime.stateRoot, "jobs"), { recursive: true });
    if (this.ownsJobState) await fs.mkdir(path.join(this.runtime.stateRoot, "compute", "jobs"), { recursive: true });
    const records = [], byId = new Map(), byKey = new Map();
    const keyOf = job => typeof job?.keyHash === "string" && /^[a-f0-9]{64}$/.test(job.keyHash) ? job.keyHash : undefined;
    const isolate = (record, code) => {
      if (!record.issue) { record.issue = code; this.recordIssues.push({ id: record.id, scope: record.scope, code }); }
      const key = keyOf(record.job);
      if (key) this.reservedKeys.add(record.scope + ":" + key);
      else this.unknownKeyScopes.add(record.scope);
    };
    for (const scope of ["jobs", "compute"]) {
      const directory = scope === "jobs" ? "jobs" : path.join("compute", "jobs");
      const files = await fs.readdir(path.join(this.runtime.stateRoot, directory)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const file of files) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const record = { id: file.slice(0, -5), scope }; records.push(record);
        try { record.job = JSON.parse(await fs.readFile(path.join(this.runtime.stateRoot, directory, file), "utf8")); }
        catch { isolate(record, "unreadable_record"); }
        const previous = byId.get(record.id);
        if (previous) { isolate(previous, "duplicate_id"); isolate(record, "duplicate_id"); }
        else byId.set(record.id, record);
        const job = record.job, key = keyOf(job);
        if (key) {
          const identity = scope + ":" + key, previousKey = byKey.get(identity);
          if (previousKey) { isolate(previousKey, "duplicate_key"); isolate(record, "duplicate_key"); }
          else byKey.set(identity, record);
        }
        if (record.issue) continue;
        if (!job || typeof job !== "object" || Array.isArray(job) || job.id !== record.id
          || typeof job.status !== "string" || !Object.hasOwn(this.catalog.states, job.status)
          || Boolean(job.computeOnly) !== (scope === "compute") || typeof job.createdAt !== "string"
          || typeof job.model !== "string" || !job.model || !validJobView(this.view(job))
          || (job.references !== undefined && (!Array.isArray(job.references) || job.references.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))))) {
          isolate(record, "invalid_record"); continue;
        }
        // Legacy readable jobs may lack a usable key; they remain readable, but
        // cannot prove that an unmatched caller key is a new operation.
        if (!key) this.unknownKeyScopes.add(scope);
      }
    }
    // Check all identities before recovering any file. Conflicting rows stay untouched.
    for (const record of records) {
      if (record.issue) continue;
      const job = record.job;
      if (this.ownsJobState && !this.catalog.states[job.status].terminal) {
        if (job.computeDeviceId && job.status === "running" && !this.catalog.states[job.computeOutcome]?.terminal) job.computeOutcome = "unknown";
        job.status = "interrupted";
        job.error = "服务重启，任务未自动重试。";
        try { await this.save(job); } catch { isolate(record, "recovery_failed"); continue; }
      }
      this.jobs.set(job.id, job);
    }
  }

  async save(job, access) {
    const fs = checkedFs(access);
    if (this.runtime.readOnly) throw new VideoError("只读模式下不能修改视频任务。", 423);
    access?.assert();
    job.updatedAt = new Date().toISOString();
    const target = path.join(this.runtime.stateRoot, ...(job.computeOnly ? ["compute"] : []), "jobs", `${job.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job), { flag: "wx" });
    await fs.rename(temporary, target);
    access?.assert();
    this.publish("video.changed", { jobId: job.id, status: job.status });
  }
  view(job) {
    const { keyHash, commandHash, firstFrame, lastFrame, output, ...value } = job;
    const image = this.catalog.models.find(row=>row.id===job.model)?.mode === "image";
    const prefix = job.computeOnly ? "/api/video/compute/jobs" : "/api/video/jobs";
    return { ...value, mediaKind: image ? "image" : "video", imageUrl: image && job.status === "succeeded" && !job.outputPurged ? `${prefix}/${job.id}/image` : undefined, hasFirstFrame: Boolean(firstFrame), hasLastFrame: Boolean(lastFrame), videoUrl: !image && job.status === "succeeded" && !job.outputPurged ? `${prefix}/${job.id}/video` : undefined };
  }
  snapshot() {
    return { recordIssues: this.recordIssues.map(issue => ({ ...issue })), online: this.online && this.runtime.alive(), availableModels: this.availableModels || [], availableWorkflows: this.availableWorkflows || [], models: this.catalog.models, states: this.catalog.states,
      jobs: [...this.jobs.values()].filter(job => !job.computeOnly).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(job => this.view(job)) };
  }
  async snapshotFor(deviceId, access) {
    if (!deviceId) return this.snapshot();
    try {
      const remote = await this.remote.status(deviceId, access);
      return {...remote, jobs:this.snapshot().jobs, states:this.catalog.states, models:this.catalog.models};
    } catch (error) {
      access?.assert();
      return {...this.snapshot(),online:false,availableModels:[],availableWorkflows:[],computeError:error instanceof VideoError ? error.message : "模型服务电脑连接失败，请检查连接。"};
    }
  }
  async startRemote(deviceId,access) {
    return this.exclusive(async()=>{
      try {
        await this.remote.start(deviceId,access);
        for (const job of this.jobs.values()) if (job.computeDeviceId === deviceId && job.computeOutcome === "unknown" && !job.computeResumedAt) {
          job.computeResumedAt = new Date().toISOString();
          try {await this.save(job,access);} catch (error) {delete job.computeResumedAt;throw error;}
        }
        return this.snapshotFor(deviceId,access);
      } catch (error) {this.remote.blocked.add(deviceId);throw error;}
    },access);
  }
  async removeCompute(id, access) {
    return this.exclusive(async () => {
      if (this.runtime.readOnly) throw new VideoError("只读模式下不能清理推理记录。",423);
      const job = this.jobs.get(id);
      if (!job?.computeOnly) throw new VideoError("推理回执不存在。",404);
      if (!this.catalog.states[job.status].terminal) throw new VideoError("推理尚未结束。",409);
      if (job.outputPurged) return {removed:true};
      const fs = checkedFs(access); access?.beforeMutation();
      if (job.output) await fs.rm(await this.outputPath(job, access), {force:true});
      for (const assetId of job.references || []) {
        const other = [...this.jobs.values()].some(row => row.id !== id && (row.references || []).includes(assetId));
        if (!other) await this.computeAssets.remove(assetId, access);
      }
      // ComfyUI receives private copies whose names are generated by this service.
      for (const field of ["firstFrame","lastFrame"]) if (job[field]) await fs.rm(path.join(this.runtime.stateRoot,"provider-input",`${job.id}-${field}.png`),{force:true});
      for (const assetId of job.references || []) for (const extension of ["png","mp4","wav"]) await fs.rm(path.join(this.runtime.stateRoot,"provider-input",`${assetId}.${extension}`),{force:true});
      const receipt = Object.fromEntries(["id","model","keyHash","commandHash","status","createdAt"].map(key=>[key,job[key]]));
      Object.assign(receipt,{computeOnly:true,outputPurged:true});
      await this.save(receipt,access);this.jobs.set(id,receipt);return {removed:true};
    },access);
  }
  async reapCompute(access) {
    if (this.runtime.readOnly || Date.now() - (this.lastComputeReap || 0) < 60000) return;
    this.lastComputeReap = Date.now();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const job of [...this.jobs.values()]) if (job.computeOnly && !job.outputPurged && this.catalog.states[job.status].terminal && Date.parse(job.updatedAt) < cutoff) await this.removeCompute(job.id,access);
    const fs = checkedFs(access);
    const root = this.computeAssets.root;
    const entries = await fs.readdir(root).catch(error=>{access?.assert();if(error.code==="ENOENT")return [];throw error;});
    for (const filename of entries) {
      const match = /^([a-f0-9-]{36})\.(json|png|mp4|wav)$/.exec(filename);
      if (!match || [...this.jobs.values()].some(job=>job.computeOnly && job.references?.includes(match[1]))) continue;
      const file = path.join(root,filename);
      if ((await fs.stat(file)).mtimeMs < cutoff) {access?.beforeMutation();await fs.rm(file,{force:true});}
    }
  }
  async request(route, init = {}, access) {
    access?.assert();
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) access?.beforeMutation();
    const response = await this.fetch(`${this.endpoint}${route}`, { ...init, redirect: "error", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout((this.runtime.getTimeoutMs?.("video.runtime.request", 20000) ?? 20000))]) });
    access?.assert();
    if (!response.ok) throw new VideoError(`H3 服务请求失败（HTTP ${response.status}）。`, 502);
    const value = await response.json(); access?.assert(); return value;
  }
  async start(modelRoot, beforeStart = () => {}, access) {
    return this.exclusive(async () => {
      access?.assert(); await beforeStart(); access?.assert();
      if (this.closing) throw new VideoError("视频插件正在停止。", 503);
      if (this.online && this.runtime.alive()) return this.snapshot();
      this.endpoint = await this.runtime.start(typeof modelRoot === "function" ? modelRoot() : modelRoot, access);
      access?.assert();
      try {
        const deadline = Date.now() + (this.runtime.getTimeoutMs?.("video.runtime.start", 120000) ?? 120000);
        while (true) {
          if (!this.runtime.alive()) throw new VideoError("H3 进程已退出，请检查视频服务日志。", 503);
          try { await this.request("/system_stats", {}, access); break; } catch (error) {
            access?.assert();
            if (Date.now() >= deadline || this.closing) throw error;
            await delay(1000, undefined, { signal: this.controller.signal }); access?.assert();
          }
        }
        const info = await this.request("/object_info", {}, access);
        this.frameAdaptationAvailable = Boolean(info.LoadImage && info.ResizeAndPadImage);
        this.availableModels=[];
        this.availableWorkflows=[];
        for (const model of this.catalog.models) {
          for (const workflowId of model.workflows ? Object.keys(model.workflows) : [undefined]) {
            for (const generateAudio of model.mode === "image" ? [false] : [false, true]) {
              const command = { id:"check", prompt:"check", width:512, height:512, frames:22, seed:1, workflowId, generateAudio };
              const workflow = buildWorkflow(model, command);
              const resolved = resolveWorkflow(model, command);
              if (Object.values(workflow).some(node => !info[node.class_type])) continue;
              const files = [["UNETLoader","unet_name",resolved.files.diffusion],["CLIPLoader","clip_name",resolved.files.textEncoder],["VAELoader","vae_name",resolved.files.vae],["VAELoader","vae_name",resolved.files.audioVae],["LoraLoaderModelOnly","lora_name",resolved.files.lora]].filter(row=>row[2]);
              if (!files.every(([node,field,file])=>info[node]?.input?.required?.[field]?.[0]?.includes(file))) continue;
              this.availableWorkflows.push({model:model.id, workflowId:resolved.workflowId, generateAudio});
              if (!this.availableModels.includes(model.id)) this.availableModels.push(model.id);
            }
          }
        }
        if(!this.availableModels.length) throw new VideoError("没有已安装完整的生成模型，请打开模型管理。",409);
        this.online = true;
        this.publish("video.changed", { online: true });
        return this.snapshot();
      } catch (error) { access?.assert(); await this.runtime.stop(access); this.endpoint = ""; this.online = false; access?.assert(); throw error; }
    }, access);
  }
  async stop(access) {
    return this.exclusive(async () => {
      if ([...this.jobs.values()].some(job => !job.computeDeviceId && !this.catalog.states[job.status].terminal)) throw new VideoError("仍有生成任务，请等待完成或取消排队任务。", 409);
      await this.runtime.stop(access); access?.assert();
      this.endpoint = "";
      this.online = false;
      this.publish("video.changed", { online: false });
      return this.snapshot();
    }, access);
  }
  async submit(input, key, access, options = {}) {
    access?.assert();
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new VideoError("请提供 8–128 字符的 Idempotency-Key。");
    let command;
    try { command = validateCommand(input, this.catalog); } catch (error) { throw new VideoError(error.message); }
    const hash = value => createHash("sha256").update(value).digest("hex");
    const deviceId = options.deviceId || "";
    const keyHash = hash(`${options.computeOnly ? "compute:" : ""}${key}`), commandHash = hash(JSON.stringify(deviceId ? {...command, computeDeviceId:deviceId} : command));
    return this.exclusive(async () => {
      const scope = options.computeOnly ? "compute" : "jobs";
      if (this.reservedKeys.has(scope + ":" + keyHash)) throw new VideoError("原任务记录损坏或存在重复身份，请先核对原回执；不会重新执行。", 409);
      const previous = [...this.jobs.values()].find(job => job.keyHash === keyHash && Boolean(job.computeOnly) === Boolean(options.computeOnly));
      if (previous) {
        if (previous.commandHash !== commandHash) throw new VideoError("同一个幂等键已用于不同参数。", 409);
        return this.view(previous);
      }
      if (this.unknownKeyScopes.has(scope)) throw new VideoError("该任务目录存在无法识别幂等键的原记录，请恢复原文件后再提交；已有回执仍可查询。", 409);
      const capability = deviceId ? await this.remote.status(deviceId, access) : null;
      if (this.closing || (capability ? !capability.online : !this.online || !this.runtime.alive())) throw new VideoError("请先启动所选电脑的视频生成服务。", 503);
      if ((command.firstFrame || command.lastFrame) && !(capability ? capability.frameAdaptationAvailable : this.frameAdaptationAvailable)) throw new VideoError("视频运行环境缺少 ResizeAndPadImage 自动适配节点，请更新 ComfyUI 后重启视频服务。", 409);
      const availableModels = capability?.availableModels ?? this.availableModels;
      const availableWorkflows = capability?.availableWorkflows ?? this.availableWorkflows;
      if(availableModels && !availableModels.includes(command.model)) throw new VideoError("所选模式的模型尚未安装，请打开模型管理。",409);
      let resolved;
      const routingCommand = {...command};

      if(command.references) {
        const references=await Promise.all(command.references.map(id=>(options.computeOnly ? this.computeAssets : this.assets).read(id, access)));
        routingCommand.referenceKinds = references.map(asset=>asset.kind);
        for(const [kind,limit] of [["image",9],["video",3],["audio",3]]) if(references.filter(a=>a.kind===kind).length>limit) throw new VideoError("参考素材数量超出模式限制。");
      }
      try { resolved = resolveWorkflow(this.catalog.models.find(model=>model.id===command.model), routingCommand, availableWorkflows); }
      catch(error) { throw new VideoError(error.message,409); }
      if (availableWorkflows && !availableWorkflows.some(row=>row.model===command.model && row.workflowId===resolved.workflowId && row.generateAudio===!!command.generateAudio)) throw new VideoError("工作流依赖尚未就绪。",409);
      if ([...this.jobs.values()].filter(job => !this.catalog.states[job.status].terminal).length >= 8) throw new VideoError("生成队列已满，最多接受 8 个待完成任务。", 429);
      const job = { ...command, ...(deviceId ? {computeDeviceId:deviceId} : {}), ...(options.computeOnly ? {computeOnly:true} : {}), workflowId: resolved.workflowId, samplingSteps: resolved.steps, id: randomUUID(), keyHash, commandHash, status: "queued", createdAt: new Date().toISOString(), progress: 0 };
      await this.save(job, access);
      access?.beforeMutation();
      this.jobs.set(job.id, job);
      this.pump();
      return this.view(job);
    }, access);
  }
  async cancel(id, access) {
    return this.exclusive(async () => {
      if (this.runtime.readOnly) throw new VideoError("只读模式下不能修改视频任务。", 423);
      const job = this.jobs.get(id);
      if (!job) throw new VideoError("任务不存在。", 404);
      if (job.status !== "queued") throw new VideoError("只能取消尚未开始的任务。", 409);
      access?.beforeMutation();
      job.status = "cancelled";
      await this.save(job, access);
      return this.view(job);
    }, access);
  }
  pump() {
    if (this.active || this.closing) return;
    this.active = this.runQueue().finally(() => { this.active = undefined; });
    // Observe persistence failures too; never leave an unhandled background promise.
    this.active.catch(() => { this.online = false; this.publish("video.changed", { online: false, error: "任务记录写入失败，请检查磁盘后重启服务。" }); });
  }
  async runQueue() {
    while (!this.closing) {
      const job = await this.exclusive(async () => {
        const next = [...this.jobs.values()].find(item => item.status === "queued");
        if (next) { next.status = "running"; next.startedAt = new Date().toISOString(); next.progressStage = "准备素材"; await this.save(next); }
        return next;
      });
      if (!job) return;
      try {
        const model = this.catalog.models.find(item => item.id === job.model);
        const isImage = model.mode === "image";
        if (job.computeDeviceId) {
          await this.remote.run(job, this.assets, value => this.save(value), this.controller.signal);
        } else {
        const images = [];
        for (const field of ["firstFrame", "lastFrame"]) {
          if (!job[field]) { images.push(undefined); continue; }
          const name = `${job.id}-${field}.png`;
          const form = new FormData();
          form.append("image", new Blob([Buffer.from(job[field], "base64")], { type: "image/png" }), name);
          const uploaded = await this.request("/upload/image", { method: "POST", body: form });
          if (uploaded.name !== name || uploaded.subfolder) throw new VideoError("H3 图片上传回执不匹配。", 502);
          images.push(name);
        }
        const references=[];
        for(const id of job.references || []) {
          const {record,file}=await (job.computeOnly ? this.computeAssets : this.assets).file(id);
          const name=path.basename(file);
          const form=new FormData(); form.append("image",new Blob([await fs.readFile(file)]),name);
          const uploaded=await this.request("/upload/image",{method:"POST",body:form});
          if(uploaded.name!==name || uploaded.subfolder) throw new VideoError("参考素材上传回执不匹配。",502);
          references.push({...record,filename:name});
        }
        const history = await this.generate(job, buildWorkflow(model, job, ...images, references));
        const output = Object.values(history.outputs ?? {}).flatMap(node => [...(node.images ?? []), ...(node.videos ?? [])]).find(item => item.type === "output" && item.filename?.endsWith(isImage ? ".png" : ".mp4"));
        if (!output) throw new VideoError("生成服务未返回预期格式的文件。", 502);
        job.output = { filename: output.filename, subfolder: output.subfolder || "" };
        }
        const file = await this.outputPath(job);
        const handle = await fs.open(file, "r");
        try {
          const signature = Buffer.alloc(12);
          const { bytesRead } = await handle.read(signature, 0, 12, 0);
          if (bytesRead !== 12 || (isImage ? signature.subarray(0,8).toString("hex") !== "89504e470d0a1a0a" : signature.toString("ascii", 4, 8) !== "ftyp")) throw new VideoError("输出不是有效的 MP4 容器。", 502);
        } finally { await handle.close(); }
        job.status = "succeeded";
        job.progress = 1;
      } catch (error) {
        job.status = this.closing ? "interrupted" : "failed";
        job.error = job.computeOutcome === "unknown" ? "远端推理结果未确认；原任务未重投，请核对原推理回执。" : error instanceof VideoError ? error.message : this.closing ? "插件停止，生成已中断。" : "生成失败，请检查视频服务日志；任务未自动重试。";
        // A lost result does not prove that GPU work stopped. Terminate our own
        // provider before accepting another job, rather than stacking unknown work.
        if (!job.computeDeviceId) { this.online = false; await this.runtime.stop(); }
        else this.remote.blocked.add(job.computeDeviceId);
        for (const queued of this.jobs.values()) if (queued.status === "queued" && (queued.computeDeviceId || "") === (job.computeDeviceId || "")) {
          queued.status = "interrupted";
          queued.error = "生成服务停止，任务未自动重试。";
          await this.save(queued);
        }
      }
      await this.save(job);
      if (job.computeDeviceId && job.status === "succeeded") await this.remote.finish(job);
      if (!job.computeDeviceId && !this.online) return;
    }
  }
  async generate(job, workflow) {
    const clientId = randomUUID();
    const socket = new this.WebSocket(`${this.endpoint.replace("http:", "ws:")}/ws?clientId=${clientId}`);
    let settle, rejectResult, promptId;
    const earlyEvents = [];
    const result = new Promise((resolve, reject) => { settle = resolve; rejectResult = reject; });
    // The result can fail while the submission HTTP request is still pending.
    result.catch(() => {});
    const abort = () => rejectResult(new VideoError("插件停止，生成已中断。", 503));
    const timer = setTimeout(() => rejectResult(new VideoError("生成超过配置的等待时间，任务未自动重试。", 504)), (this.runtime.getTimeoutMs?.("video.generation", 7200000) ?? 7200000));
    this.controller.signal.addEventListener("abort", abort, { once: true });
    const inspect = async () => {
      if (!promptId) return;
      const record = (await this.request(`/history/${encodeURIComponent(promptId)}`))[promptId];
      if (record?.status?.status_str === "error") rejectResult(new VideoError("H3 执行失败，请检查视频服务日志。", 502));
      else if (record?.status?.completed) settle(record);
    };
    const handleEvent = ({ type, data }) => {
        if (!data?.prompt_id) return;
        if (!promptId) { if (earlyEvents.length >= 128) earlyEvents.shift(); earlyEvents.push({ type, data }); return; }
        if (data?.prompt_id !== promptId) return;
        const patch = readProgressEvent(job, workflow, this.catalog.progressStages, type, data);
        if (patch) {
          Object.assign(job, patch);
          this.publish("video.progress", { jobId: job.id, startedAt: job.startedAt, ...patch });
        }
        if (type === "execution_error" || type === "execution_interrupted") rejectResult(new VideoError("H3 执行失败或中断。", 502));
        if (type === "execution_success" || (type === "executing" && data.node === null)) inspect().catch(rejectResult);
    };
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      try { handleEvent(JSON.parse(event.data));
      } catch { rejectResult(new VideoError("H3 进度事件格式无效。", 502)); }
    });
    socket.addEventListener("error", () => rejectResult(new VideoError("H3 进度连接失败。", 502)));
    socket.addEventListener("close", () => rejectResult(new VideoError("H3 进度连接中断；任务未重复提交。", 502)));
    try {
      await Promise.race([new Promise(resolve => socket.addEventListener("open", resolve, { once: true })), result]);
      const submitted = await this.request("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
      if (!submitted.prompt_id || Object.keys(submitted.node_errors ?? {}).length) throw new VideoError("H3 拒绝了生成工作流。", 502);
      promptId = submitted.prompt_id;
      job.providerJobId = promptId;
      for (const event of earlyEvents.splice(0)) handleEvent(event);
      await this.save(job);
      await inspect();
      return await result;
    } finally { clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort); socket.close(); }
  }
  async outputPath(job, access) {
    const fs = checkedFs(access);
    if (!job.output || /[\\/]/.test(job.output.filename) || !job.output.filename.startsWith(job.id)) throw new VideoError("视频输出引用无效。", 409);
    const root = await fs.realpath(path.join(this.runtime.stateRoot, "provider-output"));
    const target = path.resolve(root, job.output.subfolder, job.output.filename);
    const inside = candidate => { const relative = path.relative(root, candidate); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
    if (!inside(target) || !inside(await fs.realpath(target))) throw new VideoError("视频输出超出服务目录。", 409);
    return target;
  }
  async close() {
    this.closing = true;
    this.controller.abort();
    await this.active?.catch(() => {});
    await this.serial;
    await this.runtime.stop();
    this.unsubscribeExit?.();
    for (const job of this.jobs.values()) if (this.ownsJobState && !this.catalog.states[job.status].terminal) { job.status = "interrupted"; job.error = "插件停止，任务未自动重试。"; await this.save(job); }
    this.online = false;
  }
}
