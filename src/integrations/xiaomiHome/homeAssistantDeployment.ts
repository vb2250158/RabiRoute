import { execFile } from "node:child_process";
import { rethrowXiaomiHomeAuthorityError, type XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HomeAssistantDeploymentConfig, HomeAssistantDeploymentSnapshot } from "../../shared/homeAssistantDeploymentContract.js";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import { KeyedAsyncLock } from "../../shared/keyedAsyncLock.js";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { WindowsHomeAssistantOs, type HomeAssistantOsDriver } from "./homeAssistantOs.js";
import { NapcatSupervisorService } from "../../manager/napcatSupervisorService.js";

const runFile = promisify(execFile);
type Container = {
  Id: string;
  Config: { Image: string };
  State: { Running: boolean };
  Mounts: Array<{ Type: string; Source: string; Destination: string }>;
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
};
export type HomeAssistantDeploymentDriver = {
  run(args: string[]): Promise<string>;
  ready(baseUrl: string, authority?: XiaomiHomeRequestAuthority): Promise<boolean>;
};
const driver: HomeAssistantDeploymentDriver = {
  async run(args) {
    // Never follow a user's remote Docker context or DOCKER_HOST for a local startup action.
    const endpoint = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
    const result = await runFile("docker", ["--host", endpoint, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  },
  async ready(baseUrl, authority) {
    try {
      authority?.assert();
      const response = await fetch(`${baseUrl}/api/`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      authority?.assert();
      if (response.ok) {
        const text = await response.text();
        authority?.assert();
        if (text.includes("API running")) return true;
      }
      if (response.status !== 401) return false;
      authority?.assert();
      const manifest = await fetch(`${baseUrl}/manifest.json`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      authority?.assert();
      if (!manifest.ok) return false;
      const body = await manifest.json();
      authority?.assert();
      return body.name === "Home Assistant";
    } catch (error) {
      authority?.assert();
      rethrowXiaomiHomeAuthorityError(error);
      return false;
    }
  }
};

function invalid(message: string): never {
  throw new XiaomiHomeManagerApiError(400, "home_assistant_deployment_invalid", message);
}
function normalize(input: HomeAssistantDeploymentConfig): HomeAssistantDeploymentConfig {
  if (!input || !["external", "docker", "haos"].includes(input.mode) || typeof input.autoStart !== "boolean") invalid("请选择 Home Assistant 部署方式。");
  const name = String(input.containerName ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) invalid("请填写有效的 Docker 容器名称。");
  for (const [value, minimum, maximum] of [
    [input.healthCheckIntervalMs ?? 30000, 1000, 3600000],
    [input.recoveryCooldownMs ?? 300000, 1000, 3600000],
    [input.recoveryMaxAttempts ?? 3, 1, 10]
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) invalid("Home Assistant 恢复参数无效。");
  }
  return Object.freeze({ mode: input.mode, containerName: name, autoStart: input.mode !== "external" && input.autoStart,
    healthCheckIntervalMs: input.healthCheckIntervalMs ?? 30000,
    recoveryCooldownMs: input.recoveryCooldownMs ?? 300000,
    recoveryMaxAttempts: input.recoveryMaxAttempts ?? 3 });
}

/** Local deployment ownership is separate from HA credentials and shared Route policy. */
export class HomeAssistantDeployment {
  private readonly file: string;
  private readonly operations = new KeyedAsyncLock();
  private stopped = false;
  private failure = "";
  private flight?: Promise<void>;
  private readonly os: HomeAssistantOsDriver;
  private installing = false;
  private readonly changes = new EventEmitter();
  private recovery?: Promise<void>;
  private nextRecoveryAt = 0;
  private recoveryController?: AbortController;
  private supervisor?: NapcatSupervisorService<void>;
  private recoveryAttempts = 0;
  private healthState?: "unavailable" | "ready" | "exhausted";

  constructor(runtimeDir: string, private readonly baseUrl: () => string, private readonly io = driver, os?: HomeAssistantOsDriver) {
    this.file = path.join(runtimeDir, "home-assistant-deployment.json");
    this.os = os ?? new WindowsHomeAssistantOs(runtimeDir);
  }

  private read(): { config: HomeAssistantDeploymentConfig; revision: string } {
    let config = normalize({ mode: process.platform === "win32" ? "haos" : "docker", containerName: "homeassistant", autoStart: false });
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.schemaVersion !== 1) invalid("Home Assistant 部署配置版本无效。");
      config = normalize(saved.config);
    }
    return { config, revision: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
  }

  private requireRevision(revision: string): void {
    if (revision !== this.read().revision) throw new XiaomiHomeManagerApiError(409, "home_assistant_deployment_changed", "部署配置已变化，请重新检测后保存。");
  }

  async save(input: HomeAssistantDeploymentConfig, revision: string, authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantDeploymentSnapshot> {
    const saved = await this.operations.run("deployment", async () => {
      authority?.assert();
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      const config = normalize(input);
      withFileLockSync(`${this.file}.lock`, () => {
        this.requireRevision(revision);
        authority?.dispatch();
        atomicWriteFileSync(this.file, `${JSON.stringify({ schemaVersion: 1, config }, null, 2)}\n`);
      });
      this.failure = "";
      this.audit("configure", "committed");
      return this.inspect(authority);
    });
    if (!saved.config.autoStart || saved.config.mode === "haos") return saved;
    try { return await this.ensureReady(saved.revision, authority); }
    catch (error) {
      authority?.assert();
      rethrowXiaomiHomeAuthorityError(error);
      this.failure = error instanceof XiaomiHomeManagerApiError ? error.message : "Home Assistant 自动启动失败，请重新检测。";
      this.audit("auto-start", "failed");
      return this.inspect(authority);
    }
  }

  private async container(config: HomeAssistantDeploymentConfig, authority?: XiaomiHomeRequestAuthority): Promise<Container | undefined> {
    // Query only the explicitly named container, never infer installation from a dead HTTP port.
    const ids = (await this.run(["container", "ls", "-a", "--filter", `name=^/${config.containerName}$`, "--format", "{{.ID}}"], authority)).trim();
    if (!ids) return undefined;
    const values = JSON.parse(await this.run(["container", "inspect", config.containerName], authority)) as Container[];
    const value = values[0];
    if (!value || !/^(ghcr\.io\/home-assistant\/home-assistant|homeassistant\/home-assistant)(:|@)/.test(value.Config.Image)) {
      invalid("该容器不是 Home Assistant 官方镜像，请核对容器名称。");
    }
    return value;
  }

  private matchesEndpoint(container: Container): boolean {
    const url = new URL(this.baseUrl());
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
    return Boolean(container.NetworkSettings.Ports["8123/tcp"]?.some(port =>
      port.HostPort === (url.port || "80") && ["0.0.0.0", "127.0.0.1", "::", "::1"].includes(port.HostIp)));
  }

  async inspect(authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantDeploymentSnapshot> {
    authority?.assert();
    const saved = this.read();
    const base = { schemaVersion: 1 as const, ...saved, configured: fs.existsSync(this.file), baseUrl: this.baseUrl(), canStart: false, haosInstallPath: this.os.installationPath,
      recoveryAttempts: this.recoveryAttempts, recoveryExhausted: this.recoveryAttempts >= (saved.config.recoveryMaxAttempts ?? 3) };
    const privilege = process.env.RABIROUTE_HOST_ELEVATED === "1" ? "administrator" : process.env.RABIROUTE_HOST_ELEVATED === "0" ? "limited" : "unknown";
    const privilegeState = { privilege } as const;
    if (saved.config.mode === "haos") {
      try {
        const status = await this.checked(() => this.os.inspect(authority), authority);
        const installed = status.state === "installed" || status.installed === true;
        const ready = installed && await this.ready("http://127.0.0.1:8123", authority);
        return { ...base, ...privilegeState, baseUrl: "http://127.0.0.1:8123", installation: installed ? "installed" : "not_found",
          state: this.failure ? "error" : this.installing || status.state === "installing" ? "installing" : ready ? "ready" : status.state === "reboot_required" ? "reboot_required" : status.state === "error" ? "error" : installed ? "starting" : "stopped",
          message: this.failure || (ready ? "Home Assistant OS 已就绪。" : status.message),
          image: status.version ? `Home Assistant OS ${status.version}` : undefined,
          progress: status.progress,
          installationPath: status.root, canInstall: !this.installing && status.state !== "installing", canStart: installed && !this.installing };
      } catch (error) {
        authority?.assert();
        rethrowXiaomiHomeAuthorityError(error);
        return { ...base, installation: "unknown", state: "error", message: "无法读取 Home Assistant OS 安装状态，请检查本机安装日志。" };
      }
    }
    if (saved.config.mode === "external") {
      const ready = await this.ready(base.baseUrl, authority);
      return { ...base, installation: "external", state: ready ? "ready" : "unavailable",
        message: ready ? "Home Assistant 已就绪，安装与启动由外部管理。" : "外部 Home Assistant 不可达；请检查地址或启动所在电脑上的服务。" };
    }
    try {
      const value = await this.container(saved.config, authority);
      if (!value) return { ...base, installation: "not_found", state: "stopped", message: "未找到指定的 Home Assistant 容器，请先安装或填写已有容器名称。" };
      const bound = this.matchesEndpoint(value);
      const ready = bound && value.State.Running && await this.ready(base.baseUrl, authority);
      const installationPath = (await this.run(["info", "--format", "{{.DockerRootDir}}"], authority)).trim();
      return {
        ...base, installation: "installed", state: this.failure ? "error" : ready ? "ready" : value.State.Running ? "starting" : "stopped",
        message: this.failure || (!bound ? "已找到容器，但地址与容器的本机端口映射不一致，请先修正 Home Assistant 地址。" : ready ? "Home Assistant 已就绪。" : value.State.Running ? "容器已运行，Home Assistant 尚未就绪。" : "Home Assistant 已安装，尚未启动。"),
        image: value.Config.Image, containerId: value.Id,
        installationPath,
        configPath: value.Mounts.find(mount => mount.Destination === "/config")?.Source,
        canStart: bound
      };
    } catch (error) {
      authority?.assert();
      rethrowXiaomiHomeAuthorityError(error);
      return { ...base, installation: "unknown", state: "unavailable", canStart: process.platform === "win32" && !(error instanceof XiaomiHomeManagerApiError), message: this.failure || (error instanceof XiaomiHomeManagerApiError ? error.message : "无法检测安装状态：请确认 Docker 已安装且引擎已启动。") };
    }
  }

  ensureReady(revision: string, authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantDeploymentSnapshot> {
    return this.operations.run("deployment", async () => {
      authority?.assert();
      this.requireRevision(revision);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      this.failure = "";
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      if (this.read().config.mode === "haos") {
        return this.runOs("Start", authority);
      }
      let before = await this.inspect(authority);
      if (before.installation === "unknown" && before.canStart && process.platform === "win32") {
        try { await this.run(["desktop", "start"], authority); }
        catch (error) {
          authority?.assert();
          rethrowXiaomiHomeAuthorityError(error);
          invalid("Docker Desktop 未能启动，请检查 Docker 安装与运行状态。");
        }
        if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
        before = await this.inspect(authority);
      }
      if (before.state === "ready") return before;
      if (!before.canStart || !before.containerId) invalid(before.message);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      this.audit("start", "started");
      try {
        // Start the verified immutable ID; a renamed/replaced container is never started by name.
        if (before.state === "stopped") await this.run(["container", "start", before.containerId], authority);
        const deadline = Date.now() + 60000;
        while (!this.stopped && Date.now() < deadline) {
          if (await this.ready(before.baseUrl, authority)) {
            this.audit("start", "committed");
            return this.inspect(authority);
          }
          // Bounded startup readiness wait, not a background business-state poll.
          await this.checked(() => new Promise(resolve => setTimeout(resolve, 1000)), authority);
        }
        throw new Error("startup timeout");
      } catch (error) {
        authority?.assert();
        rethrowXiaomiHomeAuthorityError(error);
        this.failure = this.stopped ? "启动等待已取消。" : "Home Assistant 启动未就绪，请检查 Docker 和容器日志后重试。";
        this.audit("start", "failed");
        return this.inspect(authority);
      }
    });
  }

  install(revision: string, authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantDeploymentSnapshot> {
    return this.operations.run("deployment", async () => {
      authority?.assert();
      this.requireRevision(revision);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      if (this.read().config.mode !== "haos") invalid("请选择 Home Assistant OS（Hyper-V）后安装。");
      return this.runOs("Install", authority);
    });
  }

  subscribe(listener: (snapshot: HomeAssistantDeploymentSnapshot) => void): () => void {
    let closed = false;
    let reading = false;
    let pending = false;
    const changed = async () => {
      pending = true;
      if (reading || closed) return;
      reading = true;
      try {
        do {
          pending = false;
          const snapshot = await this.inspect();
          if (!closed) listener(snapshot);
        } while (pending && !closed);
      } finally { reading = false; }
    };
    const unsubscribe = this.os.subscribe?.(() => { void changed(); });
    this.changes.on("changed", changed);
    void changed();
    return () => { closed = true; this.changes.off("changed", changed); unsubscribe?.(); };
  }

  private async runOs(operation: "Install" | "Start" | "Recover", authority?: XiaomiHomeRequestAuthority, signal?: AbortSignal): Promise<HomeAssistantDeploymentSnapshot> {
    this.installing = true;
    this.failure = "";
    this.audit(operation.toLowerCase(), "started");
    try {
      const result = await this.checked(() => this.os.run(operation, this.read().config.autoStart, authority, signal), authority, true);
      if (result.state === "reboot_required") this.audit("enable-hyper-v", "committed");
      else this.audit(operation.toLowerCase(), result.state === "installed" ? "committed" : "failed");
    } catch (error) {
      authority?.assert();
      rethrowXiaomiHomeAuthorityError(error);
      this.failure = this.stopped ? "恢复等待已取消。" : operation === "Recover"
        ? "自动恢复未完成，请检查 Rabi Host 的管理员权限及 HA Core 状态。已有虚拟机和磁盘已保留。"
        : "HA 操作未能完成，请检查 Rabi 启动权限并重新检测；不要删除已有虚拟机或磁盘。";
      this.audit(operation.toLowerCase(), "failed");
    } finally {
      this.installing = false;
      this.changes.emit("changed");
    }
    return this.inspect(authority);
  }

  start(): void {
    if (this.supervisor?.isActive()) return;
    this.stopped = false;
    this.nextRecoveryAt = 0;
    this.flight = this.recover();
    this.supervisor = new NapcatSupervisorService({
      run: () => this.recover(),
      repeatDelayMs: () => this.read().config.healthCheckIntervalMs ?? 30000,
      restartDelayMs: this.read().config.healthCheckIntervalMs,
      onError: () => { this.audit("health-check", "failed"); }
    });
    void this.supervisor.start();
  }

  /** Startup and transport failures share one bounded recovery; never replay device commands. */
  recover(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.recovery) return this.recovery;
    const saved = this.read();
    if (!saved.config.autoStart || saved.config.mode === "external") return Promise.resolve();
    const controller = new AbortController();
    this.recoveryController = controller;
    this.recovery = (async () => {
      try {
        const endpoint = saved.config.mode === "haos" ? "http://127.0.0.1:8123" : this.baseUrl();
        if (await this.io.ready(endpoint)) {
          this.failure = "";
          this.recoveryAttempts = 0;
          this.healthChanged("ready");
          return;
        }
        this.healthChanged("unavailable");
        if (this.stopped || controller.signal.aborted || this.recoveryAttempts >= (saved.config.recoveryMaxAttempts ?? 3)) {
          if (!this.stopped) this.healthChanged("exhausted");
          return;
        }
        if (Date.now() < this.nextRecoveryAt) return;
        this.nextRecoveryAt = Date.now() + (saved.config.recoveryCooldownMs ?? 300000);
        this.recoveryAttempts++;
        if (saved.config.mode === "haos") {
          // Installation is never implicit, and background recovery never opens UAC.
          const status = await this.os.inspect();
          if (status.state !== "installed" && status.installed !== true) return;
          await this.operations.run("deployment", async () => {
            if (this.stopped) return;
            this.requireRevision(saved.revision);
            await this.runOs("Recover", undefined, controller.signal);
          });
        } else {
          const attempts = this.recoveryAttempts;
          await this.ensureReady(saved.revision);
          this.recoveryAttempts = attempts;
        }
        if (!this.stopped && await this.io.ready(endpoint)) {
          this.failure = "";
          this.recoveryAttempts = 0;
          this.healthChanged("ready");
        } else if (!this.stopped) {
          this.failure ||= "Home Assistant Core 尚未就绪，请检查虚拟机内服务。";
          if (this.recoveryAttempts >= (saved.config.recoveryMaxAttempts ?? 3)) this.healthChanged("exhausted");
        }
      } catch {
        this.failure = "自动恢复失败，请检查部署状态后重试。";
        this.audit("recover", "failed");
        if (!this.stopped && this.recoveryAttempts >= (saved.config.recoveryMaxAttempts ?? 3)) this.healthChanged("exhausted");
      }
    })().finally(() => { this.recovery = undefined; this.recoveryController = undefined; });
    return this.recovery;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.recoveryController?.abort();
    await this.supervisor?.stop();
    await this.operations.run("deployment", async () => undefined);
    await this.flight;
    await this.recovery;
  }

  private healthChanged(state: "unavailable" | "ready" | "exhausted"): void {
    if (this.healthState === state || (this.healthState === "exhausted" && state === "unavailable")) return;
    this.healthState = state;
    this.audit(`health-${state}`, state === "ready" ? "committed" : "failed");
    this.changes.emit("health", state);
  }

  onHealthChange(listener: (state: "unavailable" | "ready" | "exhausted") => void): () => void {
    this.changes.on("health", listener);
    return () => { this.changes.off("health", listener); };
  }

  private async checked<T>(operation: () => Promise<T>, authority?: XiaomiHomeRequestAuthority, mutation = false): Promise<T> {
    authority?.assert();
    if (mutation) authority?.dispatch();
    try {
      const result = await operation();
      authority?.assert();
      return result;
    } catch (error) {
      authority?.assert();
      throw error;
    }
  }

  private run(args: string[], authority?: XiaomiHomeRequestAuthority): Promise<string> {
    const mutation = args[0] === "desktop" || args[1] === "start";
    return this.checked(() => this.io.run(args), authority, mutation);
  }

  private ready(baseUrl: string, authority?: XiaomiHomeRequestAuthority): Promise<boolean> {
    return this.checked(() => this.io.ready(baseUrl, authority), authority);
  }
  private audit(action: string, outcome: "started" | "committed" | "failed"): void {
    recordDataMutationAudit({ group: "xiaomi-home", event: `home_assistant_${action}`, owner: "home-assistant-deployment",
      action, target: { type: this.read().config.mode === "haos" ? "virtual-machine" : "container", id: this.read().config.mode === "haos" ? "RabiRoute-HomeAssistant" : this.read().config.containerName },
      dataSource: { kind: "runtime", id: "home-assistant-deployment" }, outcome });
  }
}
