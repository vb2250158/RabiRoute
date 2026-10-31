import { getTimeoutMs } from "./timeout-settings.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { discoverWindowsHostIdentity } from './windows-host-discovery.mjs';

function loopbackManagerUrl(value) {
  const url = new URL(String(value || "").trim());
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname) || url.username || url.password) {
    throw new Error("Manager URL must be an HTTP loopback URL without credentials.");
  }
  return url.origin;
}

/** Address-free local Agent discovery. The cache is only a hint; /meta proves identity. */
export async function discoverManagerIdentity(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const timeoutMs = options.timeoutMs ?? getTimeoutMs("scripts.manager.discovery", 5000, env);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Manager discovery requires bounded timeoutMs.");
  const signal = AbortSignal.timeout(timeoutMs);
  const fetchImpl = options.fetch || fetch;
  async function verify(candidate, requireIdentity) {
    if (requireIdentity && (!candidate?.applicationGenerationId?.trim() || !candidate?.managerInstanceId?.trim())) throw new Error("Manager discovery identity is incomplete.");
    const managerBaseUrl = loopbackManagerUrl(candidate.managerBaseUrl);
    const response = await fetchImpl(`${managerBaseUrl}/meta`, { redirect: "error", signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Manager identity query failed (HTTP ${response.status}).`);
    const meta = await response.json();
    if (!meta.applicationGenerationId || !meta.managerInstanceId
      || (requireIdentity && (meta.applicationGenerationId !== candidate.applicationGenerationId || meta.managerInstanceId !== candidate.managerInstanceId))
      || loopbackManagerUrl(meta.managerBaseUrl) !== managerBaseUrl) throw new Error("Manager identity mismatch; rediscovery required.");
    if (meta.health?.live !== true || !["healthy", "degraded"].includes(meta.health?.state)) throw new Error("Manager is not ready for business requests.");
    return { managerBaseUrl, applicationGenerationId: meta.applicationGenerationId, managerInstanceId: meta.managerInstanceId };
  }
  const explicit = options.explicit || env.RABIROUTE_MANAGER_URL || env.GATEWAY_MANAGER_URL;
  if (explicit) return verify({ managerBaseUrl: explicit }, false);
  const cachePath = env.RABIROUTE_MANAGER_ENDPOINT_FILE || (platform === "win32" && env.LOCALAPPDATA
    ? path.join(path.dirname(installedHostExecutable(env)), "manager-endpoint.json") : "");
  if (cachePath) {
    try {
      const raw = await (options.readFile || fs.promises.readFile)(cachePath, "utf8");
      if (raw.length > 65536) throw new Error("Manager discovery cache is too large.");
      const cached = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (cached.schemaVersion !== 1) throw new Error("Unsupported Manager discovery cache.");
      return await verify(cached, true);
    } catch { /* Missing/stale cache: ask the sole lifecycle owner once, never scan ports. */ }
  }
  let executable; let args;
  if (platform === "win32") {
    executable = installedHostExecutable(env);
    args = ["--command", "status", "--json"];
  } else if (platform === "linux") {
    executable = process.execPath;
    args = [fileURLToPath(new URL("../linux-host.mjs", import.meta.url)), "--command", "status", "--json"];
  } else throw new Error("No local Host discovery is available on this platform.");
  if (!executable) {
    if (platform === 'win32') return discoverWindowsHostIdentity({ ...options, env, signal });
    throw new Error("RabiRoute Host is not installed.");
  }
  // execFile waits and captures redirected stdout even for a Windows GUI executable.
  let result;
  try {
    result = await (options.execFile || promisify(execFile))(executable, args, {
      windowsHide: true, encoding: "utf8", timeout: timeoutMs, signal, maxBuffer: 65536, env
    });
  } catch (error) {
    if (platform === 'win32' && error?.code === 'ENOENT') return discoverWindowsHostIdentity({ ...options, env, signal });
    throw error;
  }
  const status = JSON.parse(String(result.stdout || "").replace(/^\uFEFF/, ""));
  if (status.ok !== true) throw new Error("RabiRoute Host status is unavailable.");
  return verify(status, true);
}

function installedHostExecutable(env) {
  const explicit = String(env.RABIROUTE_HOST_EXE || env.RABIROUTE_HOST_EXECUTABLE || "").trim();
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
  const timeoutMs = options.timeoutMs ?? getTimeoutMs("scripts.manager.ready", 10000, env);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
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
