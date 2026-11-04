import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { listWorkbuddySessionDescriptors } from "../workbuddySessionStore.js";
import { workbuddyHomeDir } from "../workbuddyHome.js";


const WORKBUDDY_HOOK_PACKAGE = "rabi-workbuddy-context";


/**
 * Marker kept inside every WorkBuddy hook command. Re-running the installer must
 * replace our own entries while leaving hooks the user configured by hand alone,
 * and this is the only stable way to recognise ours after a config round-trip.
 */
const WORKBUDDY_HOOK_MARKER = "rabi-workbuddy-hook.mjs";


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


function workbuddySettingsPath(): string {
  const configured = process.env.RABI_WORKBUDDY_SETTINGS_FILE?.trim();
  if (configured) return configured;
  return path.join(workbuddyHomeDir(), "settings.json");
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


type WorkbuddyHookProbe = {
  ok: boolean;
  scriptPath: string;
  detail: string;
};


/**
 * Prove the installed hook actually runs, rather than trusting that the file
 * write succeeded. A settings file can be perfectly well-formed and still be
 * inert: the script may be missing after an interrupted copy, the Node runtime
 * may not resolve, or the Manager may be unreachable so every event silently
 * returns null. The hook's own `--self-check` mode walks that whole path and
 * reports one verdict, so this delegates instead of re-implementing the probe.
 */
const activeWorkbuddyProbes = new Map<string, ChildProcess>();


export async function probeWorkbuddyHook(installRoot: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorkbuddyHookProbe> {
  const scriptPath = path.join(installRoot, "scripts", WORKBUDDY_HOOK_MARKER);
  const failed = (detail: string): WorkbuddyHookProbe => ({ ok: false, scriptPath, detail });
  if (options.signal?.aborted) return failed("自检已取消");
  if (!fs.existsSync(scriptPath)) return failed("未找到 Hook 入口脚本");
  const key = path.resolve(scriptPath);
  if (activeWorkbuddyProbes.has(key)) return failed("上一次自检仍未确认退出，请稍后检查");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs!)) : getTimeoutMs("agent.hookProbe", 20000);
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(process.execPath, [scriptPath, "--self-check"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve(failed("无法启动自检进程")); return; }
    activeWorkbuddyProbes.set(key, child);
    let settled = false;
    let failure: string | undefined;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = (result: WorkbuddyHookProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); if (closeDeadline) clearTimeout(closeDeadline);
      options.signal?.removeEventListener("abort", aborted);
      stdout.length = 0; stderr.length = 0;
      resolve(result);
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      try { child.kill("SIGKILL"); } catch { /* Close confirmation, not kill's return value, is authoritative. */ }
      closeDeadline = setTimeout(() => {
        child.stdout?.pause(); child.stderr?.pause();
        // Keep the resource entry until close; another probe must not pile up.
        finish(failed("自检未能确认退出，已禁止重复启动"));
      }, getTimeoutMs("deadline.agentAdapters.hookInstallation.probeWorkbuddyHook", 1000));
    };
    const aborted = () => stop("自检已取消");
    const receive = (target: Buffer[], chunk: Buffer) => {
      if (settled || failure) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) { stop("自检输出超过安全上限"); return; }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.once("error", () => stop("自检进程执行失败"));
    child.once("close", (code, signal) => {
      if (activeWorkbuddyProbes.get(key) === child) activeWorkbuddyProbes.delete(key);
      if (settled) return;
      if (failure) { finish(failed(failure)); return; }
      if (code !== 0 || signal) { finish(failed(`自检进程未成功退出（${code ?? "signal"}）`)); return; }
      if (Buffer.concat(stderr).toString("utf8").includes("[rabi-workbuddy-context]")) { finish(failed("Hook 报告自检失败")); return; }
      try {
        const verdict = JSON.parse(Buffer.concat(stdout).toString("utf8").trim().split("\n").pop() || "null") as { ok?: unknown } | null;
        // Neither child output nor error messages are safe to echo into audit/UI diagnostics.
        finish(verdict?.ok === true ? { ok: true, scriptPath, detail: "自检通过" } : failed("自检未确认 Manager 可用，请检查 Host 与绑定状态"));
      } catch { finish(failed("自检没有返回有效结果")); }
    });
    const deadline = setTimeout(() => stop("自检超时"), timeoutMs);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
  });
}


/**
 * WorkBuddy reads its hook configuration once, when a session process starts,
 * and there is no settings watcher to reload it. An already-running task
 * therefore keeps the hook set it started with, no matter how many times the
 * installer runs. Rather than let the operator guess, name the tasks that are
 * still on the old set so "restart this one" is a concrete instruction.
 */
function workbuddyRestartGuidance(): string[] {
  try {
    const descriptors = listWorkbuddySessionDescriptors();
    // Only surfaces the operator actually recognises. `prewarm` and `teammate`
    // sessions are internal, and the CLI host helper carries its own temp cwd —
    // naming it would tell the user to restart something they never opened.
    const live = descriptors.filter(descriptor => {
      if (!descriptor.processAlive || descriptor.stale) return false;
      if (descriptor.kind === "prewarm" || descriptor.kind === "teammate") return false;
      const cwd: string | undefined = descriptor.cwd;
      return typeof cwd === "string" && cwd.length > 0 && !cwd.includes("__workbuddy_cli_host__");
    });
    if (live.length === 0) return ["当前没有正在运行的 WorkBuddy 任务，新开任务即会带上新 Hook。"];
    // Several sessions can share one workspace; the operator opens tasks by
    // project, so collapse them rather than naming the same path twice.
    const workspaces = [...new Set(live.map(descriptor => descriptor.cwd || descriptor.sessionId))];
    const names = workspaces.slice(0, 5);
    if (workspaces.length > names.length) names.push(`…另有 ${workspaces.length - names.length} 个工作目录`);
    return [
      `以下 ${workspaces.length} 个运行中的工作区仍在使用旧 Hook，需重启会话才会生效：`,
      ...names.map(name => `  · ${name}`),
      "新开任务会自动加载新 Hook，无需重启桌面端。"
    ];
  } catch {
    // Guidance is best-effort: failing to enumerate sessions must not fail an
    // otherwise successful install.
    return ["新开任务会自动加载新 Hook；已打开的任务需重启会话后生效。"];
  }
}


/**
 * WorkBuddy hook installation. CodeBuddy exposes the same lifecycle hooks as
 * Codex, but its plugin CLI costs roughly ninety seconds per invocation and its
 * executable path moves with every desktop upgrade, so RabiRoute installs into
 * the user-level settings file instead and keeps the plugin package available
 * for users who prefer `/plugin` management.
 */
export async function installWorkbuddyHooks(rootDir: string, options: { signal?: AbortSignal } = {}): Promise<{ message: string }> {
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

  const probe = await probeWorkbuddyHook(installRoot, options);
  const installedEvents = Object.keys(merged).filter(event => merged[event]?.length).join("、");
  const lines = [
    `Hook 已写入 WorkBuddy（${installedEvents}）。`,
    `脚本目录 ${installRoot}`,
    `配置文件 ${settingsPath}`,
    probe.ok
      ? `自检通过：${probe.detail}`
      : `自检未通过：${probe.detail}。Hook 配置已写入，但尚未确认可用；请检查 Host 与绑定状态。`,
    ...workbuddyRestartGuidance()
  ];
  return { message: lines.join("\n") };
}


/** Exposed for diagnostics and tests: where the WorkBuddy hook files land. */
export function workbuddyHookPaths(): { installRoot: string; settingsPath: string } {
  return { installRoot: workbuddyHookInstallRoot(), settingsPath: workbuddySettingsPath() };
}

import { runHookInstallation, type HookInstaller } from "./hookInstallationShared.js";

export function updateHooks(rootDir: string, _run?: HookInstaller, options: { signal?: AbortSignal } = {}): Promise<{ message: string }> {
  return runHookInstallation(rootDir, "workbuddy", () => installWorkbuddyHooks(rootDir, options));
}
