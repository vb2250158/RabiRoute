import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HomeAssistantDeploymentConfig, HomeAssistantDeploymentSnapshot } from "../../shared/homeAssistantDeploymentContract.js";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import { KeyedAsyncLock } from "../../shared/keyedAsyncLock.js";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { WindowsHomeAssistantOs, type HomeAssistantOsDriver } from "./homeAssistantOs.js";

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
  ready(baseUrl: string): Promise<boolean>;
};
const driver: HomeAssistantDeploymentDriver = {
  async run(args) {
    // Never follow a user's remote Docker context or DOCKER_HOST for a local startup action.
    const endpoint = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
    const result = await runFile("docker", ["--host", endpoint, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  },
  async ready(baseUrl) {
    try {
      const response = await fetch(`${baseUrl}/api/`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.text()).includes("API running")) return true;
      if (response.status !== 401) return false;
      const manifest = await fetch(`${baseUrl}/manifest.json`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      return manifest.ok && (await manifest.json()).name === "Home Assistant";
    } catch { return false; }
  }
};

function invalid(message: string): never {
  throw new XiaomiHomeManagerApiError(400, "home_assistant_deployment_invalid", message);
}
function normalize(input: HomeAssistantDeploymentConfig): HomeAssistantDeploymentConfig {
  if (!input || !["external", "docker", "haos"].includes(input.mode) || typeof input.autoStart !== "boolean") invalid("请选择 Home Assistant 部署方式。");
  const name = String(input.containerName ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) invalid("请填写有效的 Docker 容器名称。");
  return Object.freeze({ mode: input.mode, containerName: name, autoStart: input.mode !== "external" && input.autoStart });
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

  async save(input: HomeAssistantDeploymentConfig, revision: string): Promise<HomeAssistantDeploymentSnapshot> {
    const saved = await this.operations.run("deployment", async () => {
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      const config = normalize(input);
      withFileLockSync(`${this.file}.lock`, () => {
        this.requireRevision(revision);
        atomicWriteFileSync(this.file, `${JSON.stringify({ schemaVersion: 1, config }, null, 2)}\n`);
      });
      this.failure = "";
      this.audit("configure", "committed");
      return this.inspect();
    });
    if (!saved.config.autoStart || saved.config.mode === "haos") return saved;
    try { return await this.ensureReady(saved.revision); }
    catch (error) {
      this.failure = error instanceof XiaomiHomeManagerApiError ? error.message : "Home Assistant 自动启动失败，请重新检测。";
      this.audit("auto-start", "failed");
      return this.inspect();
    }
  }

  private async container(config: HomeAssistantDeploymentConfig): Promise<Container | undefined> {
    // Query only the explicitly named container, never infer installation from a dead HTTP port.
    const ids = (await this.io.run(["container", "ls", "-a", "--filter", `name=^/${config.containerName}$`, "--format", "{{.ID}}"])).trim();
    if (!ids) return undefined;
    const values = JSON.parse(await this.io.run(["container", "inspect", config.containerName])) as Container[];
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

  async inspect(): Promise<HomeAssistantDeploymentSnapshot> {
    const saved = this.read();
    const base = { schemaVersion: 1 as const, ...saved, configured: fs.existsSync(this.file), baseUrl: this.baseUrl(), canStart: false, haosInstallPath: this.os.installationPath };
    if (saved.config.mode === "haos") {
      try {
        const status = await this.os.inspect();
        const installed = status.state === "installed";
        const ready = installed && await this.io.ready("http://127.0.0.1:8123");
        return { ...base, baseUrl: "http://127.0.0.1:8123", installation: installed ? "installed" : "not_found",
          state: this.failure ? "error" : this.installing || status.state === "installing" ? "installing" : ready ? "ready" : status.state === "reboot_required" ? "reboot_required" : status.state === "error" ? "error" : installed ? "starting" : "stopped",
          message: this.failure || (ready ? "Home Assistant OS 已就绪。" : status.message),
          image: status.version ? `Home Assistant OS ${status.version}` : undefined,
          installationPath: status.root, canInstall: !this.installing, canStart: installed && !this.installing };
      } catch {
        return { ...base, installation: "unknown", state: "error", message: "无法读取 Home Assistant OS 安装状态，请检查本机安装日志。" };
      }
    }
    if (saved.config.mode === "external") {
      const ready = await this.io.ready(base.baseUrl);
      return { ...base, installation: "external", state: ready ? "ready" : "unavailable",
        message: ready ? "Home Assistant 已就绪，安装与启动由外部管理。" : "外部 Home Assistant 不可达；请检查地址或启动所在电脑上的服务。" };
    }
    try {
      const value = await this.container(saved.config);
      if (!value) return { ...base, installation: "not_found", state: "stopped", message: "未找到指定的 Home Assistant 容器，请先安装或填写已有容器名称。" };
      const bound = this.matchesEndpoint(value);
      const ready = bound && value.State.Running && await this.io.ready(base.baseUrl);
      const installationPath = (await this.io.run(["info", "--format", "{{.DockerRootDir}}"])).trim();
      return {
        ...base, installation: "installed", state: this.failure ? "error" : ready ? "ready" : value.State.Running ? "starting" : "stopped",
        message: this.failure || (!bound ? "已找到容器，但地址与容器的本机端口映射不一致，请先修正 Home Assistant 地址。" : ready ? "Home Assistant 已就绪。" : value.State.Running ? "容器已运行，Home Assistant 尚未就绪。" : "Home Assistant 已安装，尚未启动。"),
        image: value.Config.Image, containerId: value.Id,
        installationPath,
        configPath: value.Mounts.find(mount => mount.Destination === "/config")?.Source,
        canStart: bound
      };
    } catch (error) {
      return { ...base, installation: "unknown", state: "unavailable", canStart: process.platform === "win32" && !(error instanceof XiaomiHomeManagerApiError), message: this.failure || (error instanceof XiaomiHomeManagerApiError ? error.message : "无法检测安装状态：请确认 Docker 已安装且引擎已启动。") };
    }
  }

  ensureReady(revision: string): Promise<HomeAssistantDeploymentSnapshot> {
    return this.operations.run("deployment", async () => {
      this.requireRevision(revision);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      this.failure = "";
      if (this.read().config.mode === "haos") {
        return this.runOs("Start");
      }
      let before = await this.inspect();
      if (before.installation === "unknown" && before.canStart && process.platform === "win32") {
        try { await this.io.run(["desktop", "start"]); }
        catch { invalid("Docker Desktop 未能启动，请检查 Docker 安装与运行状态。"); }
        if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
        before = await this.inspect();
      }
      if (before.state === "ready") return before;
      if (!before.canStart || !before.containerId) invalid(before.message);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      this.audit("start", "started");
      try {
        // Start the verified immutable ID; a renamed/replaced container is never started by name.
        if (before.state === "stopped") await this.io.run(["container", "start", before.containerId]);
        const deadline = Date.now() + 60000;
        while (!this.stopped && Date.now() < deadline) {
          if (await this.io.ready(before.baseUrl)) {
            this.audit("start", "committed");
            return this.inspect();
          }
          // Bounded startup readiness wait, not a background business-state poll.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error("startup timeout");
      } catch {
        this.failure = this.stopped ? "启动等待已取消。" : "Home Assistant 启动未就绪，请检查 Docker 和容器日志后重试。";
        this.audit("start", "failed");
        return this.inspect();
      }
    });
  }

  install(revision: string): Promise<HomeAssistantDeploymentSnapshot> {
    return this.operations.run("deployment", async () => {
      this.requireRevision(revision);
      if (this.stopped) invalid("米家模块正在停止，请刷新页面。");
      if (this.read().config.mode !== "haos") invalid("请选择 Home Assistant OS（Hyper-V）后安装。");
      return this.runOs("Install");
    });
  }

  private async runOs(operation: "Install" | "Start"): Promise<HomeAssistantDeploymentSnapshot> {
    this.installing = true;
    this.failure = "";
    this.audit(operation.toLowerCase(), "started");
    try {
      const result = await this.os.run(operation, this.read().config.autoStart);
      if (result.state === "reboot_required") this.audit("enable-hyper-v", "committed");
      else this.audit(operation.toLowerCase(), result.state === "installed" ? "committed" : "failed");
    } catch {
      this.failure = "安装操作未能完成，请重新检测进度；不要删除已有虚拟机或磁盘。";
      this.audit(operation.toLowerCase(), "failed");
    } finally {
      this.installing = false;
    }
    return this.inspect();
  }

  start(): void {
    this.stopped = false;
    const saved = this.read();
    if (saved.config.mode !== "docker" || !saved.config.autoStart) return;
    this.flight = this.ensureReady(saved.revision).then(() => undefined).catch(() => {
      this.failure = "自动启动失败，请检查部署状态后重试。";
      this.audit("auto-start", "failed");
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.operations.run("deployment", async () => undefined);
    await this.flight;
  }

  private audit(action: string, outcome: "started" | "committed" | "failed"): void {
    recordDataMutationAudit({ group: "xiaomi-home", event: `home_assistant_${action}`, owner: "home-assistant-deployment",
      action, target: { type: this.read().config.mode === "haos" ? "virtual-machine" : "container", id: this.read().config.mode === "haos" ? "RabiRoute-HomeAssistant" : this.read().config.containerName },
      dataSource: { kind: "runtime", id: "home-assistant-deployment" }, outcome });
  }
}
