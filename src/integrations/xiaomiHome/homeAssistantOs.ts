import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export type HomeAssistantOsStatus = Readonly<{
  state: "not_installed" | "installing" | "reboot_required" | "installed" | "error";
  message: string;
  version?: string;
  root?: string;
}>;

export interface HomeAssistantOsDriver {
  readonly installationPath?: string;
  inspect(): Promise<HomeAssistantOsStatus>;
  run(operation: "Install" | "Start", autoStart: boolean): Promise<HomeAssistantOsStatus>;
}

const execute = promisify(execFile);

/** Fixed local installer; the HTTP caller cannot supply commands, paths or image URLs. */
export class WindowsHomeAssistantOs implements HomeAssistantOsDriver {
  private readonly root: string;
  private readonly script = fileURLToPath(new URL("../../../scripts/Install-HomeAssistantOs.ps1", import.meta.url));

  constructor(runtimeDir: string) {
    this.root = path.resolve(runtimeDir, "home-assistant-os");
  }

  get installationPath(): string { return this.root; }

  async inspect(): Promise<HomeAssistantOsStatus> {
    if (process.platform !== "win32") return { state: "error", message: "自动安装 Home Assistant OS 需要 Windows 专业版与 Hyper-V。" };
    const filename = path.join(this.root, "status.json");
    if (!fs.existsSync(filename)) return { state: "not_installed", root: this.root, message: "点击安装将检查 Hyper-V；首次启用可能需要管理员确认和重启。" };
    const value = JSON.parse(await fs.promises.readFile(filename, "utf8")) as HomeAssistantOsStatus;
    if (!["not_installed", "installing", "reboot_required", "installed", "error"].includes(value.state) || typeof value.message !== "string") {
      throw new Error("Home Assistant OS 安装状态无效，请检查本机安装日志。");
    }
    return value;
  }

  async run(operation: "Install" | "Start", autoStart: boolean): Promise<HomeAssistantOsStatus> {
    if (process.platform !== "win32") return this.inspect();
    if (this.root.startsWith("\\\\") || !fs.existsSync(this.script)) throw new Error("Home Assistant OS 安装器必须从本机安装包运行。");
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Operation", operation, "-Root", this.root, "-AutoStart", autoStart ? "yes" : "no"],
    { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
    return this.inspect();
  }
}
