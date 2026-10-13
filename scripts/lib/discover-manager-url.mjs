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
  const timeoutMs = options.timeoutMs ?? 10000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10000) {
    throw new Error("Manager discovery requires bounded timeoutMs and pollIntervalMs.");
  }
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = now() + timeoutMs;
  let lastState = "unknown";
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`RabiRoute Host has not published a complete Manager READY identity within ${timeoutMs} ms (state=${lastState}); startup or recovery is still pending.`);
    const result = (options.spawnSync || spawnSync)(hostExecutable, args, {
      encoding: "utf8", windowsHide: true, timeout: Math.max(1, Math.ceil(remaining)), env
    });
    if (result.error?.code === "ETIMEDOUT") throw new Error("RabiRoute Host status query timed out.");
    if (result.error) throw new Error(`RabiRoute Host status query failed (${result.error.code || "process error"}).`);
    if (result.status !== 0) throw new Error(`RabiRoute Host is offline or its status command failed (exit=${result.status ?? "unknown"}).`);
    let status;
    try { status = JSON.parse(String(result.stdout || "")); }
    catch { throw new Error("RabiRoute Host returned invalid status JSON."); }
    if (status?.ok !== true) throw new Error("RabiRoute Host status is unavailable (ok is not true).");
    // Host owns publication. Aggregate state is diagnostic, not another API grant.
    if ([status.managerBaseUrl, status.applicationGenerationId, status.managerInstanceId]
      .every(value => typeof value === "string" && value.trim())) return loopbackManagerUrl(status.managerBaseUrl);
    lastState = String(status.state || "unknown").slice(0, 64);
    const wait = Math.min(pollIntervalMs, deadline - now());
    if (wait > 0) sleep(wait);
  }
}
