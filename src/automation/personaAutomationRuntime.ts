import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { config, rolePathsForRoute, type NotificationRule, type RouteProfile } from "../config.js";
import type { PersonaAutomationRuleDefinition } from "../shared/gatewayConfigModel.js";
import { notificationRuleMatches } from "../routing/routeDecision.js";
import type { ForwardRecord, ForwardRouteKind, ForwardTemplateValues } from "../routing/types.js";

export type ScheduledAutomationTask = {
  route: RouteProfile;
  rule: PersonaAutomationRuleDefinition & { trigger: { type: "schedule" } };
};

export type ScriptAutomationTask = {
  route: RouteProfile;
  rule: PersonaAutomationRuleDefinition & { action: { type: "run_script" } };
};

export type ScriptExecutionResult = {
  status: "completed" | "failed" | "skipped";
  reason?: string;
  command?: string;
  scriptPath?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

const outputLimit = 8_000;
const ledgerPath = path.join(config.dataDir, "automation-executions.jsonl");
const claimedRunIds = new Set<string>();
const runningRuleIds = new Set<string>();

function loadRecentClaims(): void {
  if (!fs.existsSync(ledgerPath)) return;
  try {
    const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-5000);
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as { runId?: unknown };
        if (typeof item.runId === "string" && item.runId) claimedRunIds.add(item.runId);
      } catch {
        // Ignore an incomplete final line; the next append remains recoverable.
      }
    }
  } catch {
    // A missing claim cache must not enable paths outside the configured script boundary.
  }
}

loadRecentClaims();

function appendClaim(record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function automationRunId(
  routeId: string,
  ruleId: string,
  source: { scheduledAt?: Date; record?: ForwardRecord }
): string {
  const sourceKey = source.scheduledAt
    ? `schedule:${source.scheduledAt.toISOString()}`
    : `message:${String(source.record?.messageId ?? "")}:${source.record?.time ?? 0}:${source.record?.rawMessage ?? ""}`;
  const digest = createHash("sha256").update(`${routeId}\n${ruleId}\n${sourceKey}`).digest("hex").slice(0, 24);
  return `${routeId}:${ruleId}:${digest}`;
}

export function claimAutomationRun(runId: string, metadata: Record<string, unknown> = {}): boolean {
  if (claimedRunIds.has(runId)) return false;
  claimedRunIds.add(runId);
  appendClaim({ time: new Date().toISOString(), runId, status: "started", ...metadata });
  return true;
}

export function finishAutomationRun(runId: string, status: string, metadata: Record<string, unknown> = {}): void {
  appendClaim({ time: new Date().toISOString(), runId, status, ...metadata });
}

export function collectScheduledAutomationTasks(routes: RouteProfile[]): ScheduledAutomationTask[] {
  const tasks: ScheduledAutomationTask[] = [];
  for (const route of routes) {
    if (route.enabled === false) continue;
    for (const rule of route.automationRules ?? []) {
      if (rule.enabled === false || rule.trigger.type !== "schedule" || rule.trigger.schedule.enabled === false) continue;
      tasks.push({ route, rule: rule as ScheduledAutomationTask["rule"] });
    }
  }
  return tasks;
}

function messageTriggerRule(rule: PersonaAutomationRuleDefinition): NotificationRule | null {
  if (rule.trigger.type !== "message") return null;
  return {
    id: rule.id,
    name: rule.name || rule.id,
    enabled: rule.enabled !== false,
    routeKinds: (rule.trigger.routeKinds ?? []) as NotificationRule["routeKinds"],
    targetGroupId: rule.trigger.targetGroupId,
    allowedSpeakerNames: rule.trigger.allowedSpeakerNames,
    regex: rule.trigger.regex,
    template: ""
  };
}

export function matchingMessageScriptAutomations(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues
): ScriptAutomationTask[] {
  return (route.automationRules ?? [])
    .filter((rule): rule is ScriptAutomationTask["rule"] => rule.enabled !== false
      && rule.trigger.type === "message"
      && rule.action.type === "run_script")
    .filter((rule) => {
      const matcher = messageTriggerRule(rule);
      return matcher ? notificationRuleMatches(matcher, routeKind, record, extraValues, route) : false;
    })
    .map((rule) => ({ route, rule }));
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolvePersonaScript(
  route: RouteProfile,
  configuredPath: string
): { scriptPath: string; command: string; argsPrefix: string[]; cwd: string } {
  if (!route.personaAutomationScriptsEnabled) {
    throw new Error("当前 Route 未允许人格自动化运行本机脚本。");
  }
  const relativeInput = String(configuredPath || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relativeInput || path.isAbsolute(relativeInput) || relativeInput.split("/").includes("..")) {
    throw new Error("脚本路径必须是人格 scripts 目录内的相对路径。");
  }
  const relativeScript = relativeInput.toLowerCase().startsWith("scripts/")
    ? relativeInput.slice("scripts/".length)
    : relativeInput;
  const roleDir = rolePathsForRoute(route).roleDir;
  const scriptsDir = path.resolve(roleDir, "scripts");
  const candidate = path.resolve(scriptsDir, relativeScript);
  if (!isInside(scriptsDir, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error("脚本不存在，或不在人格 scripts 目录内。");
  }
  const realRoleDir = fs.realpathSync(roleDir);
  const realScriptPath = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoleDir, realScriptPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || realRelative.split(path.sep)[0]?.toLowerCase() !== "scripts") {
    throw new Error("脚本链接指向了人格 scripts 目录之外，已停止执行。");
  }

  const extension = path.extname(realScriptPath).toLowerCase();
  if (extension === ".py") {
    return {
      scriptPath: realScriptPath,
      command: process.env.PYTHON?.trim() || (process.platform === "win32" ? "python.exe" : "python3"),
      argsPrefix: [realScriptPath],
      cwd: path.dirname(realScriptPath)
    };
  }
  if (extension === ".cmd" || extension === ".bat") {
    if (process.platform !== "win32") throw new Error(".cmd 和 .bat 脚本只能在 Windows 上运行。");
    return {
      scriptPath: realScriptPath,
      command: "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", realScriptPath],
      cwd: path.dirname(realScriptPath)
    };
  }
  throw new Error("只允许运行 .cmd、.bat 或 .py 脚本。");
}

function scriptEnvironment(task: ScriptAutomationTask, scriptPath: string): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "HOME", "LANG"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  env.RABI_ROUTE_ID = task.route.id;
  env.RABI_AUTOMATION_ID = task.rule.id;
  env.RABI_PERSONA_DIR = rolePathsForRoute(task.route).roleDir;
  env.RABI_SCRIPT_PATH = scriptPath;
  return env;
}

function stopProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref();
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* process may already be gone */ }
}

export async function executeScriptAutomation(task: ScriptAutomationTask): Promise<ScriptExecutionResult> {
  const runningKey = `${task.route.id}:${task.rule.id}`;
  if (runningRuleIds.has(runningKey)) return { status: "skipped", reason: "already_running" };
  runningRuleIds.add(runningKey);
  const startedAt = Date.now();
  try {
    const launch = resolvePersonaScript(task.route, task.rule.action.scriptPath || "");
    const timeoutSeconds = Math.min(3600, Math.max(5, Number(task.rule.action.timeoutSeconds || 300)));
    const args = [...launch.argsPrefix, ...(task.rule.action.arguments ?? [])];
    return await new Promise<ScriptExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(launch.command, args, {
        cwd: launch.cwd,
        env: scriptEnvironment(task, launch.scriptPath),
        windowsHide: true,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-outputLimit); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-outputLimit); });
      const timer = setTimeout(() => {
        timedOut = true;
        stopProcessTree(child.pid);
      }, timeoutSeconds * 1000);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          reason: error.message,
          command: launch.command,
          scriptPath: launch.scriptPath,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt
        });
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          status: !timedOut && exitCode === 0 ? "completed" : "failed",
          reason: timedOut ? "timeout" : exitCode === 0 ? undefined : `exit_code_${exitCode ?? "unknown"}`,
          command: launch.command,
          scriptPath: launch.scriptPath,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt
        });
      });
    });
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  } finally {
    runningRuleIds.delete(runningKey);
  }
}
