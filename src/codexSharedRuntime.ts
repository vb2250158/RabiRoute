import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_SHARED_RUNTIME_URL = "ws://127.0.0.1:4510";
export const CODEX_SHARED_RUNTIME_READY_URL = "http://127.0.0.1:4510/readyz";

export function codexSharedRuntimeCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url)),
      "app-server",
      "--listen",
      CODEX_SHARED_RUNTIME_URL
    ]
  };
}

export function buildCodexRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] || "";
  return {
    ...env,
    [pathKey]: [path.dirname(process.execPath), currentPath].filter(Boolean).join(path.delimiter),
    CODEX_APP_SERVER_WS_URL: CODEX_SHARED_RUNTIME_URL
  };
}
