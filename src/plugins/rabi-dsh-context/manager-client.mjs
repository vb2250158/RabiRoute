import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { configureTimeouts, getTimeoutMs } from './timeout-settings.mjs';
const execute = promisify(execFile);

function instanceHelper() {
  const directory = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RabiAgent') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'RabiAgent') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'RabiAgent');
  return path.join(directory, 'hook-client.mjs');
}

/** Explicit endpoints and enrolled Agent instances retain their own transport. */
export function hasConfiguredHookRoute(hostExecutable) {
  return Boolean(hostExecutable || process.env.RABI_MANAGER_URL || process.env.RABIROUTE_HOST_EXE || fs.existsSync(instanceHelper()));
}

export async function requestHook(input, options = {}) {
  let dispatched = false;
  try {
    return await runHook(input, options, value => { dispatched = value; });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (error.uncertain === undefined) error.uncertain = dispatched;
    throw error;
  }
}

async function runHook(input, options, markDispatched) {
  options.signal?.throwIfAborted();
  const hostExecutable = options.hostExecutable?.trim();
  if (!hostExecutable && !options.env) {
    const helper = instanceHelper();
    if (fs.existsSync(helper)) {
      const { requestInstanceHook } = await import(pathToFileURL(helper).href);
      const fetcher = options.fetch ?? fetch;
      const instanceFetch = options.signal ? (url, init = {}) => fetcher(url, { ...init,
        signal: init.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal }) : fetcher;
      // The installed helper owns dispatch and may have sent before reporting a transport failure.
      markDispatched(true);
      const result = await requestInstanceHook({ ...input, agentType: "dsh" }, path.join(path.dirname(helper), 'config.json'), instanceFetch);
      markDispatched(false);
      options.signal?.throwIfAborted();
      if (result !== undefined) return result;
    }
  }
  const env = options.env ?? process.env;
  let descriptor;
  let baseUrl = hostExecutable ? undefined : env.RABI_MANAGER_URL;
  if (!baseUrl) {
    const host = hostExecutable || env.RABIROUTE_HOST_EXE || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe'));
    if (!host) throw new Error('RabiRoute Host is unavailable.');
    const { stdout } = await (options.execute ?? execute)(host, ['--command', 'status', '--json'], { windowsHide: true, signal: options.signal, timeout: getTimeoutMs("hooks.dsh.discovery", 3000, env) });
    descriptor = JSON.parse(stdout);
    baseUrl = descriptor.managerBaseUrl;
  }
  if (!baseUrl) throw new Error('RabiRoute Host has no active Manager.');
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  const fetcher = options.fetch ?? fetch;
  const discoveryTimeout = AbortSignal.timeout(getTimeoutMs("hooks.manager.discovery", 8000, env));
  const signal = options.signal ? AbortSignal.any([options.signal, discoveryTimeout]) : discoveryTimeout;
  const response = await fetcher(`${baseUrl}/meta`, { signal });
  const meta = await response.json();
  const hasIdentity = value => value && ['applicationGenerationId', 'managerInstanceId'].every(key =>
    typeof value[key] === 'string' && value[key].trim().length > 0);
  if (!response.ok || !hasIdentity(meta) || (descriptor && !hasIdentity(descriptor)) || meta.health?.live !== true || !['healthy', 'degraded'].includes(meta.health?.state)
      || (descriptor && (meta.applicationGenerationId !== descriptor.applicationGenerationId || meta.managerInstanceId !== descriptor.managerInstanceId))) {
    throw new Error('RabiRoute Manager generation is not ready.');
  }
  configureTimeouts(meta.timeoutOverrides);
  const requestSignal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(getTimeoutMs("hooks.manager.request", 8000, env))]);
  requestSignal.throwIfAborted();
  markDispatched(true);
  const result = await fetcher(`${baseUrl}/api/codex-hook/context`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-rabiroute-expected-application-generation-id': meta.applicationGenerationId,
      'x-rabiroute-expected-manager-instance-id': meta.managerInstanceId }, body: JSON.stringify(input), signal: requestSignal
  });
  const body = await result.json();
  markDispatched(false);
  if (!result.ok || body.code !== 0) throw new Error(body.message || 'RabiRoute Hook failed.');
  return body.data;
}
