import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ANTIGRAVITY_HOOK_PACKAGE = "rabi-antigravity-context";


type HookCommand = { type?: string; command?: string; timeout?: number };

type HookGroup = { matcher?: string; hooks?: HookCommand[] };

type HookDeclaration = Record<string, HookGroup[]>;


function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings root must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${filePath} 不是有效的 JSON，已停止写入以避免覆盖用户配置：${error instanceof Error ? error.message : String(error)}`);
  }
}


/** Write through a sibling temp file so an interrupted write cannot truncate settings. */
function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.rabi-tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}


/**
 * Antigravity shares `~/.gemini/config/` between the desktop app and the CLI, so
 * a single plugin directory serves both. Unlike Codex, its plugin CLI is not
 * needed: enabling a plugin is one key in `config.json`.
 */
function antigravityConfigDir(): string {
  const configured = process.env.RABI_ANTIGRAVITY_CONFIG_DIR?.trim();
  if (configured) return configured;
  const geminiHome = process.env.GEMINI_CONFIG_DIR?.trim()
    || path.join(os.homedir(), ".gemini");
  return path.join(geminiHome, "config");
}


/** Exposed for diagnostics and tests: where the Antigravity hook files land. */
export function antigravityHookPaths(): { installRoot: string; configPath: string } {
  return {
    installRoot: path.join(antigravityConfigDir(), "plugins", ANTIGRAVITY_HOOK_PACKAGE),
    configPath: path.join(antigravityConfigDir(), "config.json")
  };
}


/**
 * Install the Rabi context hooks into Antigravity.
 *
 * Two writes are required and neither is optional: the scripts must exist under
 * `plugins/<name>/`, and the plugin name must appear in `config.json`'s
 * `plugins` map. A plugin directory that is present but not registered is
 * silently ignored by the host — that combination was verified during probing
 * and produced no hook invocations at all. Registration is also hot-loaded, so
 * no restart is needed after this runs.
 *
 * The declaration is copied verbatim: Antigravity runs hook commands with the
 * plugin directory as the working directory, so relative `node scripts/...`
 * paths resolve without substituting an install root.
 */
export async function installAntigravityHooks(rootDir: string): Promise<{ message: string }> {
  const packageRoot = path.join(rootDir, "dist", "agent-hooks", "plugins", ANTIGRAVITY_HOOK_PACKAGE);
  const declarationFile = path.join(packageRoot, "hooks.json");
  if (!fs.existsSync(declarationFile)) {
    throw new Error("当前安装缺少 Antigravity Hook 安装包，请更新 RabiRoute 安装包后重试。");
  }
  const declaration = JSON.parse(fs.readFileSync(declarationFile, "utf8")) as { hooks?: HookDeclaration };
  if (!declaration.hooks || typeof declaration.hooks !== "object") {
    throw new Error("Antigravity Hook 安装包的 hooks.json 缺少 hooks 声明。");
  }

  const { installRoot, configPath } = antigravityHookPaths();
  fs.mkdirSync(path.dirname(installRoot), { recursive: true });
  await fs.promises.cp(packageRoot, installRoot, { recursive: true, force: true });

  const config = readSettingsFile(configPath);
  const existingPlugins = config.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
    ? config.plugins as Record<string, unknown>
    : {};
  const previous = existingPlugins[ANTIGRAVITY_HOOK_PACKAGE];
  const previousEntry = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  writeSettingsFile(configPath, {
    ...config,
    plugins: {
      ...existingPlugins,
      // Merge rather than replace: the host stores per-plugin settings beyond
      // `enabled`, and dropping them would reset the user's other choices.
      [ANTIGRAVITY_HOOK_PACKAGE]: { ...previousEntry, enabled: true }
    }
  });

  return {
    message: `Hook 已更新到 Antigravity（脚本目录 ${installRoot}，配置 ${configPath}）。`
      + "Antigravity 热加载插件配置，无需重启桌面端；下一次对话即生效。"
  };
}

import { runHookInstallation, type HookInstaller } from "@rabiroute/host-api/agentAdapters/hookInstallationShared";

export function updateHooks(rootDir: string, _run?: HookInstaller, options: { signal?: AbortSignal } = {}): Promise<{ message: string }> {
  return runHookInstallation(rootDir, "antigravity", () => installAntigravityHooks(rootDir));
}
