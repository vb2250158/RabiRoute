import { spawnSync } from "node:child_process";
import { CODEX_SHARED_RUNTIME_URL } from "../src/codexSharedRuntime.js";

if (process.platform !== "win32") throw new Error("This desktop configuration entry is for Windows only.");
const escaped = CODEX_SHARED_RUNTIME_URL.replace(/'/g, "''");
const result = spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','${escaped}','User')`
], { stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exitCode = result.status ?? 1;
else console.log(`Codex/ChatGPT Desktop will use ${CODEX_SHARED_RUNTIME_URL} after its next restart.`);
