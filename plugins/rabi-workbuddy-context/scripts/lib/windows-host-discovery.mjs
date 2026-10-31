import { configureTimeouts, getTimeoutMs } from "./timeout-settings.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Host paths and endpoint files are hints. Current Host status and /meta establish identity. */
export async function discoverWindowsHostIdentity(options = {}) {
  const env = options.env || process.env;
  const run = options.execFile || promisify(execFile);
  const readFile = options.readFile || fs.readFile;
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? getTimeoutMs("hooks.manager.discovery", 8000, env);
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  const runOptions = { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 65536, signal, env };
  const explicit = options.explicit || env.RABIROUTE_MANAGER_URL || env.RABI_MANAGER_URL || env.RABI_CODEX_MANAGER_URL || env.GATEWAY_MANAGER_URL;
  async function verify(candidate, requireIdentity) {
    const url = new URL(candidate.managerBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Manager requires an HTTP(S) address without embedded credentials.');
    const response = await fetchImpl(`${url.origin}/meta`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Manager identity query returned HTTP ${response.status}.`);
    const rawMeta = await response.json();
    const meta = rawMeta?.code === 0 && rawMeta.data ? rawMeta.data : rawMeta;
    if (!meta.applicationGenerationId || !meta.managerInstanceId || (requireIdentity &&
      (candidate.applicationGenerationId !== meta.applicationGenerationId || candidate.managerInstanceId !== meta.managerInstanceId))) throw new Error('Manager identity mismatch; discover the current Host again.');
    if (!options.diagnostic && (!meta.health?.live || !['healthy', 'degraded'].includes(meta.health?.state))) throw new Error('Manager is not ready for business requests.');
    configureTimeouts(meta.timeoutOverrides);
    return { managerBaseUrl: url.origin, applicationGenerationId: meta.applicationGenerationId, managerInstanceId: meta.managerInstanceId,
      ...(options.includeMeta ? { meta } : {}) };
  }
  if (explicit) return verify({ managerBaseUrl: explicit }, false);
  const configured = env.RABIROUTE_HOST_EXE || env.RABIROUTE_HOST_EXECUTABLE;
  const standard = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe');
  const endpointFile = env.RABIROUTE_MANAGER_ENDPOINT_FILE || ((configured || standard) && path.join(path.dirname(configured || standard), 'manager-endpoint.json'));
  if (endpointFile) {
    try {
      const raw = await readFile(endpointFile, 'utf8');
      if (raw.length <= 65536) {
        const descriptor = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (descriptor.schemaVersion === 1) return await verify(descriptor, true);
      }
    } catch { /* A missing or stale hint does not establish that Host is stopped. */ }
  }
  const attempted = new Set();
  let lastError;
  async function attempt(executable) {
    if (!executable || attempted.has(executable)) return;
    attempted.add(executable);
    try {
      signal.throwIfAborted();
      const result = await run(executable, ['--command', 'status', '--json'], runOptions);
      const status = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, ''));
      if (status.ok !== true || !status.applicationGenerationId || !status.managerInstanceId) throw new Error('Host did not publish a current Manager identity.');
      return await verify(status, true);
    } catch (error) { lastError = error; }
  }
  const selected = await attempt(configured || standard);
  if (selected) return selected;
  // An explicit installation selects an owner. Do not silently switch to another installation.
  if (!configured && (options.platform || process.platform) === 'win32' && !signal.aborted) {
    try {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name = 'RabiRouteHost.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress"], runOptions);
      const parsed = JSON.parse(String(result.stdout || '[]').trim() || '[]');
      const found = [];
      for (const executable of (Array.isArray(parsed) ? parsed : [parsed])) {
        if (typeof executable !== 'string' || !executable) continue;
        const identity = await attempt(executable); if (identity) found.push(identity);
      }
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new Error('Multiple running RabiRoute installations; select one with RABIROUTE_HOST_EXE.');
    } catch (error) { lastError = error; }
  }
  const error = new Error('Could not discover the current RabiRoute Manager. Check the running Host or configure RABIROUTE_HOST_EXE / RABIROUTE_MANAGER_ENDPOINT_FILE in the Agent launch environment. Host availability is unconfirmed.');
  error.cause = lastError;
  throw error;
}
