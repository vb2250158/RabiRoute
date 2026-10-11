import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function requestRabiLinkManagerFixture(baseUrl, targetDeviceId, token, path, options = {}) {
  const method = options.method || 'GET', mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const suppliedHeaders = Object.fromEntries(Object.entries(options.headers || {}).filter(([key]) => !['x-rabilink-token', 'authorization', 'content-type'].includes(key.toLowerCase())));
  const operationId = suppliedHeaders['Idempotency-Key'] || suppliedHeaders['idempotency-key'] || 'fixture-' + crypto.randomUUID();
  const response = await fetch(baseUrl + '/api/rabilink/device/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(options.authorized === false ? {} : { 'x-rabilink-token': token }) }, body: JSON.stringify({ targetDeviceId,
    request: { method, path, headers: suppliedHeaders, ...(mutation ? { operationId } : {}), ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body }) } }) });
  const wire = await response.json(), result = wire.data?.structuredContent;
  if (!result) return { response, body: wire };
  return { response: new Response(null, { status: result.statusCode || result.status || 500, headers: result.headers || {} }), body: result.data };
}
export async function startRabiLinkOwnerFixture({ relayBaseUrl, token, appId, deviceId = 'pc-test', directory }) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./rabilink-owner-http-fixture.mts', import.meta.url))], {
    env: { ...process.env, OWNER_FIXTURE_RELAY: relayBaseUrl, OWNER_FIXTURE_TOKEN: token, OWNER_FIXTURE_APP: appId, OWNER_FIXTURE_PC: deviceId, OWNER_FIXTURE_DIR: directory },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
  let sequence = 0, errorText = ''; const waiting = new Map();
  child.stderr.on('data', chunk => { errorText += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PC owner fixture startup timeout: ' + errorText)), 10000);
    child.on('message', packet => {
      if (packet.ready) { clearTimeout(timer); resolve(); }
      else if (waiting.has(packet.id)) { const item = waiting.get(packet.id); waiting.delete(packet.id); clearTimeout(item.timer); packet.error ? item.reject(new Error(packet.error)) : item.resolve(packet.result); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('PC owner fixture exit ' + code + ': ' + errorText)); });
  });
  const command = (name, data) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { waiting.delete(id); reject(new Error('PC fixture command timeout')); }, 10000);
    waiting.set(id, { resolve, reject, timer }); child.send({ id, command: name, data });
  });
  return { normalize: data => command('normalize', data), trace: () => command('trace'), pause: () => command('pause'), resume: () => command('resume'),
    stop: () => new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.disconnect(); } }) };
}
