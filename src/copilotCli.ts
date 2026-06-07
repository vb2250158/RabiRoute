import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

type CopilotCliState = {
  agentAdapterType: "copilotCli";
  monitorThreadId: string;
  monitorThreadName: string;
  monitorThreadSource: string;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
  lastPromptPath?: string;
  lastOutputPath?: string;
  lastExitCode?: number | null;
  lastSignal?: NodeJS.Signals | null;
  lastStdoutPreview?: string;
  lastStderrPreview?: string;
};

let notificationQueue: Promise<void> = Promise.resolve();

const statePath = path.join(config.dataDir, "copilot-state.json");
const defaultArgs = ["--silent", "--allow-all-tools", "--no-ask-user", "--prompt", "{prompt}"];

// State is kept in memory only. On startup we overwrite any stale state file so
// the manager never reads a stale error from a previous process run.
let memoryState: CopilotCliState = baseState();
flushState(memoryState);

function readState(): CopilotCliState {
  return memoryState;
}

function writeState(state: CopilotCliState): void {
  memoryState = state;
  flushState(state);
}

function flushState(state: CopilotCliState): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch { /* non-fatal */ }
}

function baseState(): CopilotCliState {
  return {
    agentAdapterType: "copilotCli",
    monitorThreadId: "copilot-cli",
    monitorThreadName: "Copilot CLI",
    monitorThreadSource: copilotCommand()
  };
}

function copilotCommand(): string {
  if (process.env.COPILOT_CLI_BIN?.trim()) return process.env.COPILOT_CLI_BIN.trim();
  const fs = require("fs") as typeof import("fs");
  const p = require("path") as typeof import("path");
  // winget install GitHub.Copilot -> native .exe (preferred, no execution policy issues)
  if (process.env.LOCALAPPDATA) {
    const wingetBase = p.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(wingetBase)) {
        if (entry.startsWith("GitHub.Copilot")) {
          const exe = p.join(wingetBase, entry, "copilot.exe");
          if (fs.existsSync(exe)) return exe;
        }
      }
    } catch { /* skip */ }
  }
  // Fallback: npm global .cmd wrapper (requires shell: true on Windows)
  const npmGlobal = process.env.APPDATA
    ? p.join(process.env.APPDATA, "npm", "copilot.cmd")
    : null;
  if (npmGlobal && fs.existsSync(npmGlobal)) return npmGlobal;
  return "copilot";
}

function copilotCwd(): string {
  return process.env.COPILOT_CWD?.trim() || config.codexCwd;
}

function copilotTimeoutMs(): number {
  const value = Number(process.env.COPILOT_CLI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

function parseCopilotArgs(): string[] {
  const raw = process.env.COPILOT_CLI_ARGS?.trim();
  if (!raw) {
    return defaultArgs;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to shell-like splitting.
  }

  return splitArgs(raw);
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    args.push(current);
  }
  return args;
}

function copilotSessionName(): string {
  return process.env.CODEX_THREAD_NAME?.trim() || "";
}

function argsForPrompt(message: string): { args: string[]; writePromptToStdin: boolean } {
  const baseArgs = parseCopilotArgs();

  // Prepend: [-C <cwd>] [--resume=<name>]
  const prefix: string[] = [];
  const cwd = copilotCwd();
  if (cwd) prefix.push("-C", cwd);
  const sessionName = copilotSessionName();
  if (sessionName) {
    // --resume by name; if session doesn't exist yet, copilot starts a new one
    prefix.push(`--resume=${sessionName}`);
  }

  const args = [...prefix, ...baseArgs];
  let replaced = false;
  const next = args.map((arg) => {
    if (!arg.includes("{prompt}")) return arg;
    replaced = true;
    return arg.replace(/\{prompt\}/g, message);
  });

  return { args: next, writePromptToStdin: !replaced };
}

function shouldUseShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function truncate(value: string, maxLength = 4000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function appendJsonl(filePath: string, item: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(item)}\n`, "utf8");
}

async function runCopilotCli(message: string): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  const command = copilotCommand();
  const { args, writePromptToStdin } = argsForPrompt(message);
  const cwd = copilotCwd();
  const timeoutMs = copilotTimeoutMs();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: shouldUseShell(command),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Copilot CLI timed out after ${timeoutMs}ms. Command: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Copilot CLI failed to start. Set COPILOT_CLI_BIN to the CLI executable path. ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code && code !== 0) {
        reject(new Error(`Copilot CLI exited with code ${code}: ${truncate(stderr || stdout)}`));
        return;
      }
      resolve({ stdout, stderr, code, signal });
    });

    if (writePromptToStdin) {
      child.stdin.end(message);
    } else {
      child.stdin.end();
    }
  });
}

export async function notifyCopilotCli(message: string): Promise<void> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(() => notifyCopilotCliInternal(message));

  return notificationQueue;
}

async function notifyCopilotCliInternal(message: string): Promise<void> {
  const state = readState();
  const now = new Date();
  const id = `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
  const promptPath = path.join(config.dataDir, "copilot-prompts", `${id}.txt`);
  const outputPath = path.join(config.dataDir, "copilot-output.jsonl");

  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, message, "utf8");

  try {
    const result = await runCopilotCli(message);
    appendJsonl(outputPath, {
      id,
      time: now.toISOString(),
      cwd: copilotCwd(),
      promptPath,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      signal: result.signal
    });
    writeState({
      ...state,
      monitorThreadSource: copilotCommand(),
      notificationCount: (state.notificationCount ?? 0) + 1,
      lastNotificationAt: new Date().toISOString(),
      lastNotificationError: undefined,
      lastNotificationErrorAt: undefined,
      lastPromptPath: promptPath,
      lastOutputPath: outputPath,
      lastExitCode: result.code,
      lastSignal: result.signal,
      lastStdoutPreview: truncate(result.stdout, 1200),
      lastStderrPreview: truncate(result.stderr, 1200)
    });
  } catch (error) {
    writeState({
      ...state,
      monitorThreadSource: copilotCommand(),
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString(),
      lastPromptPath: promptPath
    });
    throw error;
  }
}
