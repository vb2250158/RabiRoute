import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { VideoError } from "./service.mjs";
import { resolveWorkflow } from "./workflow.mjs";

const folders = { diffusion: "diffusion_models", textEncoder: "text_encoders", vae: "vae", audioVae: "vae", lora: "loras", lora4: "loras" };
async function availableSpace(root) {
  let existing = root;
  while (!await fs.stat(existing).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new VideoError("无法读取模型磁盘剩余空间。", 409);
    existing = parent;
  }
  const disk = await fs.statfs(existing);
  return disk.bavail * disk.bsize;
}
export async function safeTarget(root, relative) {
  const base = path.resolve(root), target = path.resolve(base, relative);
  const inside = path.relative(base, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new VideoError("模型文件路径无效。");
  // Reject junctions at every existing level, including partial files and the root.
  for (let current = target; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat?.isSymbolicLink()) throw new VideoError("模型目录不能包含符号链接或目录联接。");
    if (path.dirname(current) === current) break;
  }
  return target;
}
async function validSize(file, bytes) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== bytes) return false;
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(9); await handle.read(header, 0, 9, 0);
      const length = Number(header.readBigUInt64LE());
      return length > 2 && length < Math.min(bytes - 8, 100 * 1024 * 1024) && header[8] === 123;
    } finally { await handle.close(); }
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function downloadFile(url, target, bytes, sha256, signal, progress, fetcher = fetch) {
  const partial = `${target}.part`;
  const base = path.dirname(target);
  await safeTarget(base, path.basename(partial));
  await fs.mkdir(base, { recursive: true });
  // Exclusive creation preserves incomplete and unknown existing files on retry.
  const temporary = `${partial}.${randomUUID()}`;
  const handle = await fs.open(temporary, "wx");
  let count = 0;
  const hash = createHash("sha256");
  try {
    let response;
    for (let redirect = 0; redirect < 6; redirect++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
        !(parsed.hostname === "huggingface.co" || parsed.hostname.endsWith(".hf.co") || parsed.hostname.endsWith(".huggingface.co"))) throw new VideoError("模型下载地址不受信任。");
      response = await fetcher(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(4 * 60 * 60 * 1000)]) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = response.headers.get("location"); await response.body?.cancel();
      if (!next) throw new VideoError("模型下载重定向无效。");
      url = new URL(next, url).href;
    }
    if (!response?.ok || !response.body) throw new VideoError("模型下载失败，请稍后重试。");
    for await (const chunk of response.body) {
      signal.throwIfAborted(); count += chunk.length;
      if (count > bytes) throw new VideoError("模型下载大小超出清单。");
      hash.update(chunk); await handle.writeFile(chunk); progress(count);
    }
    if (count !== bytes || hash.digest("hex") !== sha256) throw new VideoError("模型大小或 SHA-256 校验失败。");
    await handle.sync(); await handle.close();
    await safeTarget(base, path.basename(target));
    // Hard-link publication is atomic and refuses to overwrite an existing model.
    await fs.link(temporary, target); await fs.unlink(temporary);
  } finally { await handle.close().catch(() => {}); }
}

export class VideoModels {
  constructor(runtime, catalog, publish, dependencies = {}) {
    this.runtime = runtime; this.catalog = catalog; this.publish = publish;
    this.availableSpace = dependencies.availableSpace ?? availableSpace;
    this.downloadFile = dependencies.downloadFile ?? downloadFile;
    this.file = path.join(runtime.stateRoot, "model-directory.json");
    this.settings = { revision: 0, modelRoot: null, layout: "flat" }; this.job = null; this.flight = null;
    this.controller = new AbortController(); this.closed = false;
  }
  async initialize() {
    const text = await fs.readFile(this.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (text) {
      const value = JSON.parse(text);
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.modelRoot === null || typeof value.modelRoot === "string")) throw new Error("Invalid video model settings");
      if (value.layout !== undefined && !["flat", "categorized"].includes(value.layout)) throw new Error("Invalid model layout");
      this.settings = { layout: "flat", ...value };
    }
  }
  root() { return this.settings.modelRoot || this.runtime.defaultModelRoot; }
  modelRoot(model) { return this.settings.layout === "categorized" ? path.join(this.root(), model.directory) : this.root(); }
  runtimeRoots() { return [...new Set(this.catalog.models.map(model => this.modelRoot(model)))]; }
  directories() { return { ...this.settings, effectiveModelRoot: this.root(), defaultModelRoot: this.runtime.defaultModelRoot }; }
  guard() {
    if (this.runtime.readOnly) throw new VideoError("只读模式下不能安装或配置模型。", 423);
    if (this.closed || this.flight || this.runtime.alive()) throw new VideoError("请先停止视频服务并等待安装结束。", 409);
  }
  async configure(body) {
    this.guard();
    if (!body || Object.keys(body).some(key => !["modelRoot", "expectedRevision", "layout"].includes(key)) || body.expectedRevision !== this.settings.revision || !("modelRoot" in body)) throw new VideoError("目录设置已改变，请刷新后重试。", 409);
    if (body.layout !== undefined && !["flat", "categorized"].includes(body.layout)) throw new VideoError("模型目录布局无效。");
    const modelRoot = await this.runtime.validateModelRoot(body.modelRoot);
    if (modelRoot) await safeTarget(modelRoot, "model-directory-check");
    this.guard();
    const target = { revision: this.settings.revision + 1, modelRoot, layout: modelRoot ? (body.layout ?? this.settings.layout) : "flat" };
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(target), { flag: "wx" });
    await fs.rename(temp, this.file); this.settings = target;
    return this.directories();
  }
  async snapshot() {
    const models = await Promise.all(this.catalog.models.map(async model => {
      const files = await Promise.all(Object.entries(model.files).map(async ([key, name]) => {
        const target = await safeTarget(this.root(), path.relative(this.root(), path.join(this.modelRoot(model), folders[key], name)));
        const installed = await validSize(target, model.expectedBytes[key]);
        const exists = installed || !!await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        return { key, name, bytes: model.expectedBytes[key], installed, state: installed ? "installed" : exists ? "invalid" : "missing" };
      }));
      const workflows = model.workflows ? Object.entries(model.workflows).map(([id, profile]) => {
        const required = resolveWorkflow(model, { workflowId: id }).files;
        const missingFiles = files.filter(file => Object.values(required).includes(file.name) && !file.installed).map(file => file.name);
        return { id, label: profile.label, installed: !missingFiles.length, missingFiles };
      }) : undefined;
      return { id: model.id, label: model.label, files, workflows, installed: files.every(file => file.installed), bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    }));
    return { runtimeInstalled: await this.runtime.installed(), models, job: this.job };
  }
  async assertStartable() {
    const ready = await this.snapshot();
    if (!ready.runtimeInstalled) throw new VideoError("视频运行环境尚未安装，请在模型管理中安装运行环境。", 409);
    if (ready.models.some(model => model.installed || model.workflows?.some(workflow => workflow.installed))) return;
    const missing = [...new Set(ready.models.flatMap(model => model.files.filter(file => !file.installed).map(file => file.name)))];
    throw new VideoError(`当前模型目录没有可用工作流。缺失或损坏：${missing.join("、")}。请检查模型主目录或初始化所需模型。`, 409);
  }
  async downloadPlan(ids = this.catalog.models.map(model => model.id)) {
    await this.runtime.validateModelRoot(this.root());
    const snapshot = await this.snapshot(), files = new Map();
    for (const model of snapshot.models.filter(model => ids.includes(model.id))) {
      const definition = this.catalog.models.find(row => row.id === model.id);
      for (const file of model.files) {
        const relative = path.relative(this.root(), path.join(this.modelRoot(definition), folders[file.key], file.name));
        if (!files.has(relative)) files.set(relative, { ...file, relative });
      }
    }
    const availableBytes = await this.availableSpace(this.root());
    const entries = [...files.values()], missing = entries.filter(file => !file.installed);
    const downloadBytes = missing.reduce((sum, file) => sum + file.bytes, 0);
    const errors = [];
    if (!snapshot.runtimeInstalled) errors.push("请先安装运行环境；此处空间预算仅包含模型权重。");
    if (missing.some(file => file.state === "invalid")) errors.push(`已有文件损坏或大小不符，请先检查，不能覆盖：${missing.filter(file => file.state === "invalid").map(file => file.name).join("、")}`);
    if (downloadBytes > availableBytes) errors.push("模型目录所在磁盘空间不足，请释放空间或更换主目录。");
    return { revision: this.settings.revision, modelRoot: this.root(), files: entries, downloadBytes, additionalBytes: downloadBytes, availableBytes, errors, canDownload: !errors.length };
  }
  async initializeModels(body) {
    this.guard();
    if (!body || Object.keys(body).some(key => key !== "expectedRevision") || body.expectedRevision !== this.settings.revision) throw new VideoError("模型目录已改变，请重新查看下载空间。", 409);
    const plan = await this.downloadPlan();
    if (!plan.canDownload) throw new VideoError(plan.errors.join("\n"), 409);
    return this.begin("models", () => this.downloadModels(this.catalog.models));
  }
  begin(kind, operation) {
    this.guard(); this.job = { kind, state: "running", bytes: 0, total: 0 };
    this.flight = Promise.resolve().then(operation).then(() => { this.job.state = "completed"; }, error => { this.job.state = "failed"; this.job.message = `${this.job.currentFile ? `${this.job.currentFile}：` : ""}${error instanceof VideoError ? error.message : "安装或下载失败，请检查网络、磁盘权限和运行日志。"} 已有模型和未完成下载均已保留。`; }).finally(() => { this.flight = null; this.publish(); });
    this.publish(); return this.job;
  }
  installRuntime() { return this.begin("runtime", () => this.runtime.install()); }
  download(id) {
    const model = this.catalog.models.find(row => row.id === id);
    if (!model) throw new VideoError("未知视频模型。");
    return this.begin("model", () => this.downloadModels([model]));
  }
  async downloadModels(models) {
      if (!await this.runtime.installed()) throw new VideoError("请先安装视频运行环境。", 409);
      const plan = await this.downloadPlan(models.map(model => model.id));
      if (!plan.canDownload) throw new VideoError(plan.errors.join("\n"), 409);
      this.job.total = plan.downloadBytes;
      let completed = 0, lastEvent = 0;
      for (const model of models) {
      for (const [key, name] of Object.entries(model.files)) {
        const relative = path.relative(this.root(), path.join(this.modelRoot(model), folders[key], name));
        const target = await safeTarget(this.root(), relative);
        const bytes = model.expectedBytes[key];
        if (!await validSize(target, bytes)) {
          this.job.currentFile = name;
          if (await this.availableSpace(this.root()) < bytes) throw new VideoError("磁盘剩余空间不足，下载已停止。", 409);
          if (await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; })) throw new VideoError("已有模型文件不完整，请保留并人工检查后重试。");
          await this.downloadFile(`${model.downloadBase || "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main"}/${folders[key]}/${name}`, target, bytes, model.sha256[key], this.controller.signal, count => {
            this.job.bytes = completed + count;
            if (Date.now() - lastEvent > 1000) { lastEvent = Date.now(); this.publish(); }
          });
          completed += bytes; this.job.bytes = completed; this.publish();
        }
      }
      }
      this.job.currentFile = undefined;
  }
  async close() { this.closed = true; this.controller.abort(); await this.runtime.stopInstaller(); await this.flight; }
}
