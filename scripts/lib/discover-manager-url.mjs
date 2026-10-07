import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function loopbackManagerUrl(value) {
  const url = new URL(String(value || "").trim());
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname) || url.username || url.password) {
    throw new Error("Manager URL must be an HTTP loopback URL without credentials.");
  }
  return url.origin;
}

function installedHostExecutable(env) {
  const explicit = String(env.RABIROUTE_HOST_EXE || "").trim();
  if (explicit) return explicit;
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  return localAppData ? path.join(localAppData, "Programs", "RabiRoute", "RabiRouteHost.exe") : "";
}

export function discoverManagerBaseUrl(options = {}) {
  const env = options.env || process.env;
  const explicit = String(options.explicit || "").trim();
  if (explicit) return loopbackManagerUrl(explicit);

  for (const name of options.environmentNames || ["RABIROUTE_MANAGER_URL", "GATEWAY_MANAGER_URL"]) {
    const value = String(env[name] || "").trim();
    if (value) return loopbackManagerUrl(value);
  }

  const platform = options.platform || process.platform;
  if (platform !== "win32" && platform !== "linux") {
    throw new Error("Manager URL is not configured; set RABIROUTE_MANAGER_URL or GATEWAY_MANAGER_URL.");
  }

  const linuxHost = fileURLToPath(new URL("../linux-host.mjs", import.meta.url));
  const hostExecutable = platform === "linux" ? process.execPath : installedHostExecutable(env);
  if (!hostExecutable || !fs.existsSync(hostExecutable)) {
    throw new Error("RabiRoute Host is not installed; set RABIROUTE_MANAGER_URL explicitly.");
  }
  const args = platform === "linux" ? [linuxHost, "--command", "status", "--json"] : ["--command", "status", "--json"];
  const result = (options.spawnSync || spawnSync)(hostExecutable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    env
  });
  if (result.error) throw new Error(`RabiRoute Host status failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error("RabiRoute Host is offline or did not return a healthy status.");
  let status;
  try {
    status = JSON.parse(String(result.stdout || ""));
  } catch {
    throw new Error("RabiRoute Host returned invalid status JSON.");
  }
  const readyState = status?.state === "healthy" || (platform === "linux" && status?.state === "degraded");
  if (status?.ok !== true || !readyState || !status?.managerBaseUrl || !status?.applicationGenerationId || !status?.managerInstanceId) {
    throw new Error("RabiRoute Host has not published a healthy, complete Manager READY identity.");
  }
  return loopbackManagerUrl(status.managerBaseUrl);
}
