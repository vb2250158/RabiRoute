import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const execute = promisify(execFile);
type RunInstaller = (args: string[]) => Promise<unknown>;
const pending = new Map<string, Promise<{ message: string }>>();

const WORKBUDDY_HOOK_PACKAGE = "rabi-workbuddy-context";
const ANTIGRAVITY_HOOK_PACKAGE = "rabi-antigravity-context";

/**
 * Marker kept inside every WorkBuddy hook command. Re-running the installer must
 * replace our own entries while leaving hooks the user configured by hand alone,
 * and this is the only stable way to recognise ours after a config round-trip.
 */
const WORKBUDDY_HOOK_MARKER = "rabi-workbuddy-hook.mjs";

/**
 * Marker kept inside every Antigravity hook command, for the same reason as the
 * WorkBuddy marker: the installer must replace only its own entries.
 */
const ANTIGRAVITY_HOOK_MARKER = "rabi-antigravity-hook.mjs";

/**
 * Stable install root for the WorkBuddy hook scripts. It deliberately lives
 * outside the versioned release payload: `settings.json` records absolute script
 * paths, so a release that moved them would break every session until the user
 * reinstalled the hooks.
 */
function workbuddyHookInstallRoot(): string {
  const configured = process.env.RABI_WORKBUDDY_HOOK_ROOT?.trim();
  if (configured) return path.join(configured, WORKBUDDY_HOOK_PACKAGE);
  const base = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "RabiRoute", "agent-hooks", WORKBUDDY_HOOK_PACKAGE);
}

/**
 * CodeBuddy resolves its user-level settings through `WORKBUDDY_CONFIG_DIR`
 * (`~/.workbuddy`) in the desktop app, so that is the file RabiRoute writes.
 */
function workbuddySettingsPath(): string {
  const configured = process.env.RABI_WORKBUDDY_SETTINGS_FILE?.trim();
  if (configured) return configured;
  const configDir = process.env.WORKBUDDY_CONFIG_DIR?.trim();
  return path.join(configDir || path.join(os.homedir(), ".workbuddy"), "settings.json");
}

type HookCommand = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookCommand[] };
type HookDeclaration = Record<string, HookGroup[]>;

function isOurHookGroup(group: HookGroup): boolean {
  return (group?.hooks || []).some(hook => String(hook?.command || "").includes(WORKBUDDY_HOOK_MARKER));
}

/**
 * Turn the shipped plugin declaration into a user-level declaration. The plugin
 * form resolves its own files through `CODEBUDDY_PLUGIN_ROOT`; a settings-level
 * hook has no plugin root, so the install directory is substituted verbatim.
 */
function materializeHookDeclaration(declaration: HookDeclaration, installRoot: string): HookDeclaration {
  const materialized: HookDeclaration = {};
  for (const [event, groups] of Object.entries(declaration || {})) {
    materialized[event] = (groups || []).map(group => ({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: (group.hooks || []).map(hook => ({
        ...hook,
        command: String(hook.command || "").split("process.env.CODEBUDDY_PLUGIN_ROOT").join(JSON.stringify(installRoot))
      }))
    }));
  }
  return materialized;
}

function mergeHookDeclaration(existing: HookDeclaration, incoming: HookDeclaration): HookDeclaration {
  const merged: HookDeclaration = {};
  for (const [event, groups] of Object.entries(existing || {})) {
    const kept = (groups || []).filter(group => !isOurHookGroup(group));
    if (kept.length) merged[event] = kept;
  }
  for (const [event, groups] of Object.entries(incoming || {})) {
    if (!groups?.length) continue;
    merged[event] = [...(merged[event] || []), ...groups];
  }
  return merged;
}

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
 * WorkBuddy hook installation. CodeBuddy exposes the same lifecycle hooks as
 * Codex, but its plugin CLI costs roughly ninety seconds per invocation and its
 * executable path moves with every desktop upgrade, so RabiRoute installs into
 * the user-level settings file instead and keeps the plugin package available
 * for users who prefer `/plugin` management.
 */
async function installWorkbuddyHooks(rootDir: string): Promise<{ message: string }> {
  const packageRoot = path.join(rootDir, "dist", "agent-hooks", "plugins", WORKBUDDY_HOOK_PACKAGE);
  const declarationFile = path.join(packageRoot, "hooks", "hooks.json");
  if (!fs.existsSync(declarationFile)) {
    throw new Error("当前安装缺少 WorkBuddy Hook 安装包，请更新 RabiRoute 安装包后重试。");
  }
  const declaration = JSON.parse(fs.readFileSync(declarationFile, "utf8")) as { hooks?: HookDeclaration };
  if (!declaration.hooks || typeof declaration.hooks !== "object") {
    throw new Error("WorkBuddy Hook 安装包的 hooks.json 缺少 hooks 声明。");
  }

  const installRoot = workbuddyHookInstallRoot();
  fs.mkdirSync(path.dirname(installRoot), { recursive: true });
  await fs.promises.cp(packageRoot, installRoot, { recursive: true, force: true });

  const settingsPath = workbuddySettingsPath();
  const settings = readSettingsFile(settingsPath);
  const existing = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as HookDeclaration;
  const merged = mergeHookDeclaration(existing, materializeHookDeclaration(declaration.hooks, installRoot));
  if (Object.keys(merged).length === 0) {
    throw new Error("WorkBuddy Hook 声明为空，已停止写入。");
  }
  writeSettingsFile(settingsPath, { ...settings, hooks: merged });

  return {
    message: `Hook 已更新到本机 WorkBuddy（脚本目录 ${installRoot}，配置 ${settingsPath}）。`
      + "新开的 WorkBuddy 任务会自动加载；已打开的任务需要重启会话后生效。"
  };
}

/** Install only the Rabi context plugin through the Agent's own plugin manager. */
export function updateAgentHooks(rootDir: string, adapter: string, run?: RunInstaller): Promise<{ message: string }> {
  if (adapter !== "codex" && adapter !== "dsh" && adapter !== "workbuddy" && adapter !== "antigravity") {
    return Promise.reject(new Error("当前 Agent 尚未提供 Hook 更新安装包。"));
  }
  const key = `${path.resolve(rootDir)}:${adapter}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    if (adapter === "workbuddy") {
      const result = await installWorkbuddyHooks(rootDir);
      recordDataMutationAudit({ group: "config", event: "agent_hooks_updated", owner: "agent-hook-installer",
        action: "update-hooks", dataSource: { kind: "file", id: `plugins/${WORKBUDDY_HOOK_PACKAGE}` }, target: { type: "agent", id: adapter }, outcome: "committed" });
      return result;
    }
    if (adapter === "antigravity") {
      const result = await installAntigravityHooks(rootDir);
      recordDataMutationAudit({ group: "config", event: "agent_hooks_updated", owner: "agent-hook-installer",
        action: "update-hooks", dataSource: { kind: "file", id: `plugins/${ANTIGRAVITY_HOOK_PACKAGE}` }, target: { type: "agent", id: adapter }, outcome: "committed" });
      return result;
    }
    let cli = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const bundleRoot = path.join(rootDir, "dist", "agent-hooks");
    const packageRoot = path.join(bundleRoot, "plugins", adapter === "codex" ? "rabi-codex-context" : "rabi-dsh-context");
    const manifest = path.join(packageRoot, adapter === "codex" ? ".codex-plugin/plugin.json" : "package.json");
    if (adapter === "dsh" && !run) {
      const profileRequire = createRequire(path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "web", "package.json"));
      try { cli = path.join(path.dirname(profileRequire.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js"); }
      catch { throw new Error("未找到本机 DSH web profile 的 CLI，请先安装并配置 DSH。"); }
    }
    if (!run && (!fs.existsSync(cli) || !fs.existsSync(manifest))) {
      throw new Error("当前安装缺少 Codex Hook 安装包，请更新 RabiRoute 安装包后重试。");
    }
    const invoke = run ?? ((args: string[]) => execute(process.execPath, [cli, ...args], {
      cwd: rootDir, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024
    }));
    if (adapter === "codex") {
      await invoke(["plugin", "marketplace", "add", bundleRoot]);
      await invoke(["plugin", "add", "rabi-codex-context@rabiroute-local", "--json"]);
    } else {
      await invoke(["plugin", "--profile", "web", "add", packageRoot]);
    }
    recordDataMutationAudit({ group: "config", event: "agent_hooks_updated", owner: "agent-hook-installer",
      action: "update-hooks", dataSource: { kind: "file", id: `plugins/rabi-${adapter}-context` }, target: { type: "agent", id: adapter }, outcome: "committed" });
    return { message: adapter === "codex"
      ? "Hook 已更新到 Codex。新任务加载插件后，在 /hooks 中审阅信任命令。"
      : "Hook 已更新到本机 DSH web profile，重新加载该插件或重启 DSH 后生效。" };
  })().catch(error => {
    recordDataMutationAudit({ group: "config", event: "agent_hooks_update_failed", owner: "agent-hook-installer",
      action: "update-hooks", dataSource: { kind: "file", id: "plugins/rabi-codex-context" }, target: { type: "agent", id: adapter }, outcome: "failed", error });
    throw error;
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

/** Exposed for diagnostics and tests: where the WorkBuddy hook files land. */
export function workbuddyHookPaths(): { installRoot: string; settingsPath: string } {
  return { installRoot: workbuddyHookInstallRoot(), settingsPath: workbuddySettingsPath() };
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
async function installAntigravityHooks(rootDir: string): Promise<{ message: string }> {
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
