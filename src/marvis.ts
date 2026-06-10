import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";

type MarvisState = {
  agentAdapterType: "marvis";
  monitorThreadId?: string;
  monitorThreadName: string;
  monitorThreadSource: string;
  bound: boolean;
  handoffOnly?: boolean;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
  lastPromptPath?: string;
  lastCopiedToClipboard?: boolean;
  lastOpenedAppId?: string;
  lastOpenedUrl?: string;
};

const defaultMarvisUrl = "https://marvis.qq.com/";
const defaultMarvisAppId = "Tencent.Marvis";
let memoryState: MarvisState | null = null;

function marvisUrl(): string {
  return process.env.MARVIS_URL?.trim() || defaultMarvisUrl;
}

function marvisAppId(): string {
  return process.env.MARVIS_APP_ID?.trim() || defaultMarvisAppId;
}

function shouldOpenMarvis(): boolean {
  return process.env.MARVIS_OPEN_ON_NOTIFY !== "0";
}

function shouldOpenDesktopApp(): boolean {
  return process.env.MARVIS_OPEN_DESKTOP_APP !== "0";
}

function shouldCopyToClipboard(): boolean {
  return process.env.MARVIS_COPY_TO_CLIPBOARD !== "0";
}

function baseState(): MarvisState {
  return {
    agentAdapterType: "marvis",
    monitorThreadName: "Marvis",
    monitorThreadSource: marvisUrl(),
    bound: false,
    handoffOnly: true
  };
}

function readState(): MarvisState {
  memoryState ??= baseState();
  return memoryState;
}

function writeState(state: MarvisState): void {
  memoryState = state;
  reportAgentState("marvis", state);
}

function writePrompt(message: string): string {
  const now = new Date();
  const id = `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
  const promptPath = path.join(config.dataDir, "marvis-prompts", `${id}.txt`);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, message, "utf8");
  return promptPath;
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function openUrl(url: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}

function openDesktopApp(appId: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  spawnDetached("explorer.exe", [`shell:AppsFolder\\${appId}`]);
  return true;
}

function copyPromptToClipboard(promptPath: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Set-Clipboard -Value (Get-Content -LiteralPath $args[0] -Raw)",
      promptPath
    ], {
      windowsHide: true
    });

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        reject(new Error(`Failed to copy Marvis prompt to clipboard: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      resolve(true);
    });
  });
}

export async function notifyMarvis(message: string): Promise<void> {
  const state = readState();
  const now = new Date();
  const promptPath = writePrompt(message);
  const url = marvisUrl();
  const appId = marvisAppId();

  try {
    const copied = shouldCopyToClipboard() ? await copyPromptToClipboard(promptPath) : false;
    let openedApp = false;
    if (shouldOpenMarvis()) {
      openedApp = shouldOpenDesktopApp() ? openDesktopApp(appId) : false;
      if (!openedApp) {
        openUrl(url);
      }
    }
    writeState({
      ...state,
      monitorThreadSource: openedApp ? appId : url,
      notificationCount: (state.notificationCount ?? 0) + 1,
      lastNotificationAt: now.toISOString(),
      lastNotificationError: undefined,
      lastNotificationErrorAt: undefined,
      lastPromptPath: promptPath,
      lastCopiedToClipboard: copied,
      lastOpenedAppId: openedApp ? appId : undefined,
      lastOpenedUrl: shouldOpenMarvis() && !openedApp ? url : undefined
    });
  } catch (error) {
    writeState({
      ...state,
      monitorThreadSource: appId || url,
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString(),
      lastPromptPath: promptPath
    });
    throw error;
  }
}
