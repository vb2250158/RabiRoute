import { getTimeoutMs } from "../../shared/timeoutSettings.js";
import type { XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HomeAssistantInstallProgress } from "../../shared/homeAssistantDeploymentContract.js";

export type HomeAssistantOsStatus = Readonly<{
  state: "not_installed" | "installing" | "reboot_required" | "installed" | "error";
  message: string;
  version?: string;
  root?: string;
  progress?: HomeAssistantInstallProgress;
  installed?: boolean;
  endpoint?: Readonly<{ address: string; port: 80 | 8123; vmId: string; legacyBindingVerified: boolean }>;
}>;

export interface HomeAssistantOsDriver {
  readonly installationPath?: string;
  inspect(authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantOsStatus>;
  subscribe?(changed: () => void): () => void;
  run(operation: "Install" | "Start" | "Recover", autoStart: boolean, authority?: XiaomiHomeRequestAuthority, signal?: AbortSignal): Promise<HomeAssistantOsStatus>;
  /** Observe an owned running VM without starting, stopping, or modifying it. */
  observe?(signal?: AbortSignal): Promise<NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined>;
}

const execute = promisify(execFile);

/** The endpoint is accepted only from the completed, fixed-path privileged child, never from the status file. */
export function parseManagedHaEndpoint(stdout: string): NonNullable<HomeAssistantOsStatus["endpoint"]> {
  const prefix = "RABIROUTE_HA_ENDPOINT:";
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error("Managed Home Assistant endpoint is missing or ambiguous.");
  const value = JSON.parse(lines[0].slice(prefix.length)) as Record<string, unknown>;
  if (typeof value.address !== "string" || isIP(value.address) !== 4 || (value.port !== 80 && value.port !== 8123)
      || typeof value.vmId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.vmId)
      || typeof value.legacyBindingVerified !== "boolean") {
    throw new Error("Managed Home Assistant endpoint is invalid.");
  }
  return { address: value.address, port: value.port, vmId: value.vmId, legacyBindingVerified: value.legacyBindingVerified };
}

export function parseManagedHaObservation(stdout: string): NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined {
  const prefix = "RABIROUTE_HA_OBSERVATION:";
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error("Managed Home Assistant observation is missing or ambiguous.");
  const value = JSON.parse(lines[0].slice(prefix.length)) as Record<string, unknown>;
  if (value.ready === false && Object.keys(value).length === 1) return undefined;
  if (value.ready !== true) throw new Error("Managed Home Assistant observation is invalid.");
  return parseManagedHaEndpoint(`RABIROUTE_HA_ENDPOINT:${JSON.stringify(value)}`);
}

/** Fixed local installer; the HTTP caller cannot supply commands, paths or image URLs. */
export class WindowsHomeAssistantOs implements HomeAssistantOsDriver {
  private readonly root: string;
  private readonly script = fileURLToPath(new URL("../../../scripts/Install-HomeAssistantOs.ps1", import.meta.url));

  constructor(runtimeDir: string) {
    this.root = path.resolve(runtimeDir, "home-assistant-os");
  }

  get installationPath(): string { return this.root; }

  subscribe(changed: () => void): () => void {
    fs.mkdirSync(this.root, { recursive: true });
    const watcher = fs.watch(this.root, (_event, filename) => {
      if (filename?.toString() === "status.json") changed();
    });
    watcher.on("error", changed);
    return () => watcher.close();
  }

  async inspect(authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantOsStatus> {
    authority?.assert();
    if (process.platform !== "win32") return { state: "error", message: "自动安装 Home Assistant OS 需要 Windows 专业版与 Hyper-V。" };
    const filename = path.join(this.root, "status.json");
    if (!fs.existsSync(filename)) return { state: "not_installed", root: this.root, message: "点击安装将检查 Hyper-V；首次启用可能需要管理员确认和重启。" };
    const value = JSON.parse(await fs.promises.readFile(filename, "utf8")) as HomeAssistantOsStatus;
    authority?.assert();
    if (!["not_installed", "installing", "reboot_required", "installed", "error"].includes(value.state) || typeof value.message !== "string") {
      throw new Error("Home Assistant OS 安装状态无效，请检查本机安装日志。");
    }
    const { endpoint: _untrustedEndpoint, ...status } = value;
    return { ...status, installed: fs.existsSync(path.join(this.root, "image.json")) && fs.existsSync(path.join(this.root, "home-assistant.vhdx")) };
  }

  async run(operation: "Install" | "Start" | "Recover", autoStart: boolean, authority?: XiaomiHomeRequestAuthority, signal?: AbortSignal): Promise<HomeAssistantOsStatus> {
    authority?.assert();
    if (process.platform !== "win32") return this.inspect(authority);
    if (this.root.startsWith("\\\\") || !fs.existsSync(this.script)) throw new Error("Home Assistant OS 安装器必须从本机安装包运行。");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    authority?.dispatch();
    const result = await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Operation", operation, "-Root", this.root, "-AutoStart", autoStart ? "yes" : "no"],
    { windowsHide: true, timeout: getTimeoutMs("backend.integrations.xiaomiHome.homeAssistantOs.run.execute.timeout", 30 * 60 * 1000), maxBuffer: 1024 * 1024, signal });
    authority?.assert();
    const status = await this.inspect(authority);
    if (status.state !== "installed") return status;
    return { ...status, endpoint: parseManagedHaEndpoint(result.stdout) };
  }

  async observe(signal?: AbortSignal): Promise<NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined> {
    if (process.platform !== "win32") return undefined;
    if (this.root.startsWith("\\\\") || !fs.existsSync(this.script)) throw new Error("Home Assistant OS 安装器必须从本机安装包运行。");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Operation", "Observe", "-Root", this.root, "-AutoStart", "no"],
    { windowsHide: true, timeout: getTimeoutMs("backend.integrations.xiaomiHome.homeAssistantOs.observe.execute.timeout", 60000), maxBuffer: 1024 * 1024, signal });
    return parseManagedHaObservation(result.stdout);
  }
}
