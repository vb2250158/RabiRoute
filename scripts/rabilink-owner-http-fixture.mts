// Synthetic integration fixture: the real PC owner services consume the existing Relay HTTP queue.
import http from 'node:http';
import { createRabiLinkMobileOwner } from '../src/manager/rabiLinkMobileOwner.js';
import { createRabiLinkAgentDevices } from '../src/manager/rabiLinkAgentDevices.js';
import { normalizeRabiLinkTaskInput } from '../src/adapters/rabilinkTaskInput.js';
const base = String(process.env.OWNER_FIXTURE_RELAY), token = String(process.env.OWNER_FIXTURE_TOKEN), appId = String(process.env.OWNER_FIXTURE_APP);
const deviceId = String(process.env.OWNER_FIXTURE_PC || 'pc-test');
const headers = { 'x-rabilink-token': token, 'content-type': 'application/json' };
let active = true, stopped = false;
const traced: { path: string; method: string; headers: Record<string, string> }[] = [];
const authorize = (req: http.IncomingMessage) => req.headers['x-fixture-source-device'] ? { scope: 'synthetic-owner-scope', sourceDeviceId: String(req.headers['x-fixture-source-device']), deviceOwner: req.headers['x-fixture-source-device'] !== '$application' } : null;
const profiles = createRabiLinkAgentDevices({ dataDir: String(process.env.OWNER_FIXTURE_DIR), sourceDeviceId: deviceId, authorize,
  deviceOwnerTarget: async () => deviceId, readLocal: async () => ({ personas: [{ personaId: 'Fixture' }] }) });
const module = createRabiLinkMobileOwner({ dataDir: String(process.env.OWNER_FIXTURE_DIR), sourceDeviceId: deviceId,
  authorize,
  applicationOwnerTarget: async () => deviceId,
  peers: async () => [{ id: deviceId, name: 'PC Rabi Smoke', online: true, capabilities: ['webgui'] }]
});
const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url || '/', 'http://fixture.invalid'), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (await profiles.handle(req, res, url, body) || await module.handle(req, res, url, body)) return;
    traced.push({ path: req.url || '/', method: req.method || 'GET', headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value)])) });
    let reply: Response;
    if (url.pathname === '/manager-config') reply = Response.json({ code: 0, ok: true, source: 'pc-rabi-smoke', config: { manager: { autoStart: true } } });
    else if (url.pathname === '/api/future-capability') reply = Response.json({ future: true });
    else if (url.pathname === '/gateways') {
      const operationId = String(req.headers['idempotency-key'] || ''), hash = 'b'.repeat(64);
      reply = String(req.headers['if-match'] || '').startsWith('W/') ? Response.json({ code: -1, errorCode: 'route_catalog_precondition_required' }, { status: 428 })
        : Response.json({ code: 0, receipt: { state: 'committed', operationId, routeConfigHash: hash }, routeCatalog: { contentHash: hash, routeConfigHash: hash, revision: 2 } }, { headers: { 'idempotency-key': operationId, etag: '"' + hash + '"' } });
    } else reply = Response.json({ code: 'PC_PUBLIC_PATH_NOT_FOUND' }, { status: 404 });
    res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(Buffer.from(await reply.arrayBuffer()));
  } catch { res.writeHead(500).end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const ownerBase = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
process.on('message', (packet: { id: number; command: string; data?: Record<string, unknown> }) => {
  if (packet.command === 'pause') active = false;
  if (packet.command === 'resume') active = true;
  try { process.send?.({ id: packet.id, result: packet.command === 'normalize' ? normalizeRabiLinkTaskInput(packet.data || {}) : packet.command === 'trace' ? traced : true }); }
  catch (cause) { process.send?.({ id: packet.id, error: String(cause) }); }
});
await request('/worker/webgui-requests?deviceId=' + encodeURIComponent(deviceId) + '&deviceGuid=guid-test&deviceKind=pc&capabilities=webgui&waitMs=1');
process.send?.({ ready: true });
process.on('disconnect', () => { stopped = true; server.close(); process.exit(0); });
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
  return response.json();
}
while (!stopped) {
  if (active) try {
    const claim = await request('/worker/webgui-requests?deviceId=' + encodeURIComponent(deviceId) + '&deviceGuid=guid-test&deviceKind=pc&capabilities=webgui&waitMs=1');
    for (const queued of claim.requests || []) {
      if (queued.connectionIdentity?.appId !== appId) throw new Error('Fixture rejected forged connection metadata');
      const response = await fetch(ownerBase + queued.path, { method: queued.method, headers: { ...queued.headers, 'x-fixture-source-device': queued.connectionIdentity.deviceId }, ...(['GET', 'HEAD'].includes(queued.method) ? {} : { body: Buffer.from(queued.bodyBase64 || '', 'base64') }) });
      await request('/worker/webgui-requests/' + encodeURIComponent(queued.id) + '/response', 'POST', { deviceId, deviceGuid: 'guid-test', ok: true, statusCode: response.status, headers: Object.fromEntries(response.headers), bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64') });
    }
  } catch (cause) { if (stopped) break; }
  await new Promise(resolve => setTimeout(resolve, 20));
}
