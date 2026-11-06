import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { configureTimeouts, getTimeoutMs } from './timeout-settings.mjs';
const execute = promisify(execFile);

export async function requestHook(input, options = {}) {
  if (!options.env) {
    const directory = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RabiAgent') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'RabiAgent') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'RabiAgent');
    const helper = path.join(directory, 'hook-client.mjs');
    if (fs.existsSync(helper)) {
      const { requestInstanceHook } = await import(pathToFileURL(helper).href);
      const result = await requestInstanceHook({ ...input, agentType: "dsh" }, path.join(directory, 'config.json'), options.fetch);
      if (result !== undefined) return result;
    }
  }
  const env = options.env ?? process.env;
  let descriptor;
  let baseUrl = env.RABI_MANAGER_URL;
  if (!baseUrl) {
    const host = env.RABIROUTE_HOST_EXE || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe'));
    if (!host) throw new Error('RabiRoute Host is unavailable.');
    const { stdout } = await (options.execute ?? execute)(host, ['--command', 'status', '--json'], { windowsHide: true, timeout: getTimeoutMs("hooks.dsh.discovery", 3000, env) });
    descriptor = JSON.parse(stdout);
    baseUrl = descriptor.managerBaseUrl;
  }
  if (!baseUrl) throw new Error('RabiRoute Host has no active Manager.');
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  const fetcher = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(getTimeoutMs("hooks.manager.discovery", 8000, env));
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
  const result = await fetcher(`${baseUrl}/api/codex-hook/context`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-rabiroute-expected-application-generation-id': meta.applicationGenerationId,
      'x-rabiroute-expected-manager-instance-id': meta.managerInstanceId }, body: JSON.stringify(input), signal: requestSignal
  });
  const body = await result.json();
  if (!result.ok || body.code !== 0) throw new Error(body.message || 'RabiRoute Hook failed.');
  return body.data;
}
