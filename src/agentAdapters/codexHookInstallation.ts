import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { runHookInstallation, type HookInstaller } from "./hookInstallationShared.js";
const execute = promisify(execFile);

export function updateHooks(rootDir: string, run?: HookInstaller): Promise<{ message: string }> {
  return runHookInstallation(rootDir, "codex", async () => {
    const cli = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const bundleRoot = path.join(rootDir, "dist", "agent-hooks");
    const manifest = path.join(bundleRoot, "plugins", "rabi-codex-context", ".codex-plugin", "plugin.json");
    if (!run && (!fs.existsSync(cli) || !fs.existsSync(manifest))) {
      throw new Error("当前安装缺少 Codex Hook 安装包，请更新 RabiRoute 安装包后重试。");
    }
    const invoke = run ?? ((args: string[]) => execute(process.execPath, [cli, ...args], {
      cwd: rootDir, windowsHide: true, timeout: getTimeoutMs("backend.agentAdapters.hookInstallation.updateAgentHooks.execute.timeout", 60_000), maxBuffer: 1024 * 1024
    }));
    await invoke(["plugin", "marketplace", "add", bundleRoot]);
    await invoke(["plugin", "add", "rabi-codex-context@rabiroute-local", "--json"]);
    return { message: "Hook 已更新到 Codex。新任务加载插件后，在 /hooks 中审阅信任命令。" };
  });
}
