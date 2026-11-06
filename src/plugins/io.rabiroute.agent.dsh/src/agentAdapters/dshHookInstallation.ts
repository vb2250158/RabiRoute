import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { runHookInstallation, type HookInstaller } from "@rabiroute/host-api/agentAdapters/hookInstallationShared";
const execute = promisify(execFile);

export function updateHooks(rootDir: string, run?: HookInstaller): Promise<{ message: string }> {
  return runHookInstallation(rootDir, "dsh", async () => {
    const packageRoot = path.join(rootDir, "dist", "agent-hooks", "plugins", "rabi-dsh-context");
    let cli = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!run) {
      const profileRequire = createRequire(path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "web", "package.json"));
      try { cli = path.join(path.dirname(profileRequire.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js"); }
      catch { throw new Error("未找到本机 DSH web profile 的 CLI，请先安装并配置 DSH。"); }
      if (!fs.existsSync(cli) || !fs.existsSync(path.join(packageRoot, "package.json"))) throw new Error("当前安装缺少 DSH Hook 安装包，请更新 RabiRoute 安装包后重试。");
    }
    const invoke = run ?? ((args: string[]) => execute(process.execPath, [cli, ...args], {
      cwd: rootDir, windowsHide: true, timeout: getTimeoutMs("backend.agentAdapters.hookInstallation.updateAgentHooks.execute.timeout", 60_000), maxBuffer: 1024 * 1024
    }));
    await invoke(["plugin", "--profile", "web", "add", packageRoot]);
    return { message: "Hook 已更新到本机 DSH web profile，重新加载该插件或重启 DSH 后生效。" };
  });
}
