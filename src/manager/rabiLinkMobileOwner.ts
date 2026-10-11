import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';

type Worker = { id: string; name?: string; online: boolean; capabilities: string[]; [key: string]: unknown };
type MobileState = { version: 1; asrPriority: string[]; deviceStatus: Record<string, unknown> | null; proofs: Record<string, unknown>[]; operations: { key: string; fingerprint: string; result: unknown }[] };
export type RabiLinkMobileOwnerOptions = {
  dataDir: string;
  sourceDeviceId: string;
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  applicationOwnerTarget(): Promise<string>;
  peers(): Promise<Worker[]>;
};
const fail = (code: string, statusCode = 400): never => { throw Object.assign(new Error(code), { code, statusCode }); };
const empty = (): MobileState => ({ version: 1, asrPriority: [], deviceStatus: null, proofs: [], operations: [] });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, limit = 220) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const paths = new Set(['asr-settings', 'device-status', 'proof', 'proofs']);
export function rabiLinkMobileOwnerPath(pathname: string): boolean {
  if (pathname === '/api/rabilink/devices/health-capabilities') return true;
  const suffix = pathname.replace(/^\/api\/rabilink\/mobile\//, '');
  return pathname.startsWith('/api/rabilink/mobile/') && paths.has(suffix);
}
export function createRabiLinkMobileOwner(options: RabiLinkMobileOwnerOptions) {
  const state = new RabiLinkOwnerStore<MobileState>(path.join(options.dataDir, 'rabilink-mobile-owner'), empty, value => {
    const stored = value as MobileState;
    if (!stored || stored.version !== 1 || !Array.isArray(stored.asrPriority) || stored.asrPriority.some(id => typeof id !== 'string')
      || !Array.isArray(stored.proofs) || !Array.isArray(stored.operations) || stored.operations.some(row => !row || typeof row.key !== 'string' || typeof row.fingerprint !== 'string')) fail('MOBILE_OWNER_STORE_INVALID', 500);
    return stored;
  });
  async function ensureOwner() { if (await options.applicationOwnerTarget() !== options.sourceDeviceId) fail('MOBILE_OWNER_PC_MISMATCH', 409); }
  function mutate(scope: string, request: http.IncomingMessage, action: string, body: unknown, apply: (stored: MobileState) => unknown) {
    const key = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : '';
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(key)) fail('MOBILE_OPERATION_KEY_INVALID');
    const stored = state.read(scope), fingerprint = digest([action, body]), previous = stored.operations.find(row => row.key === key);
    if (previous) { if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409); return structuredClone(previous.result); }
    if (stored.operations.length >= 2048) fail('MOBILE_OPERATION_CAPACITY', 409);
    const result = apply(stored); stored.operations.push({ key, fingerprint, result });
    state.write(scope, stored);
    return structuredClone(result);
  }
  return {
    async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, body: unknown): Promise<boolean> {
      if (!rabiLinkMobileOwnerPath(url.pathname)) return false;
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      try {
        const principal = options.authorize(request);
        if (!principal?.scope) { send(401, { code: 'MOBILE_CONNECTION_REQUIRED', ok: false }); return true; }
        const fence = () => { const current = options.authorize(request); if (!current || current.scope !== principal.scope || current.sourceDeviceId !== principal.sourceDeviceId) fail('MOBILE_CONNECTION_CHANGED', 401); };
        if (url.pathname === '/api/rabilink/devices/health-capabilities') {
          if (request.method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
          send(200, { rabilinkWearableObservation: { processingPolicies: ['transcribe', 'agent'], expectedWorkerFencing: true, processingPolicyFrozen: true } });
          return true;
        }
        const suffix = url.pathname.slice('/api/rabilink/mobile/'.length), method = request.method || 'GET';
        if (['asr-settings', 'device-status', 'proof', 'proofs'].includes(suffix)) { await ensureOwner(); fence(); }
        if (suffix === 'asr-settings') {
          if (!['GET', 'PATCH'].includes(method)) fail('METHOD_NOT_ALLOWED', 405);
          const workers = (await options.peers()).filter(worker => worker.capabilities.includes('asr')); fence();
          const changed = method === 'PATCH' ? mutate(principal.scope, request, suffix, body, stored => {
            const priority = (body as { priority?: unknown })?.priority;
            if (!Array.isArray(priority) || priority.length > 100 || priority.some(id => typeof id !== 'string' || !workers.some(worker => worker.id === id)) || new Set(priority).size !== priority.length) fail('ASR_PRIORITY_INVALID');
            stored.asrPriority = [...priority as string[]]; return { priority: stored.asrPriority };
          }) as { priority: string[] } : null;
          const priority = changed?.priority || state.read(principal.scope).asrPriority, rank = new Map(priority.map((id, index) => [id, index]));
          workers.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
          send(200, { ok: true, priority, workers, selectedWorkerId: workers.find(worker => worker.online)?.id || '' }); return true;
        }
        if (suffix === 'device-status') {
          if (!['GET', 'POST'].includes(method)) fail('METHOD_NOT_ALLOWED', 405);
          let status = state.read(principal.scope).deviceStatus;
          if (method === 'POST') status = mutate(principal.scope, request, suffix, body, stored => {
            const input = body as { batteryLevel?: unknown; level?: unknown; charging?: unknown; observedAt?: unknown };
            const level = Number(input?.batteryLevel ?? input?.level);
            if (!Number.isFinite(level) || level < 0 || level > 100 || typeof input?.charging !== 'boolean') fail('DEVICE_STATUS_INVALID');
            const now = new Date().toISOString(), observed = Date.parse(text(input.observedAt));
            stored.deviceStatus = { batteryLevel: Math.round(level), charging: input.charging, observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : now, receivedAt: now, source: 'rokid-cxr-phone' };
            return stored.deviceStatus;
          }) as Record<string, unknown>;
          const ageMs = status ? Math.max(0, Date.now() - Date.parse(String(status.receivedAt))) : 0;
          send(200, { code: 0, ok: true, deviceStatus: status ? { ...status, ageMs, stale: ageMs > 180000, staleAfterMs: 180000 } : null }); return true;
        }
        if (suffix === 'proofs') {
          if (method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
          send(200, { code: 0, ok: true, proofs: state.read(principal.scope).proofs.slice(-limit).reverse() }); return true;
        }
        if (suffix === 'proof') {
          if (method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
          const evidenceWorker = (await options.peers()).find(worker => worker.id === options.sourceDeviceId); fence();
          const proof = mutate(principal.scope, request, suffix, body, stored => {
            if (stored.proofs.length >= 50000) fail('PROOF_STORAGE_CAPACITY', 409);
            const input = body as Record<string, unknown> || {}, runtime = (input.runtime || {}) as Record<string, unknown>, device = (input.device || {}) as Record<string, unknown>;
            const row = { id: 'proof-' + randomUUID(), time: new Date().toISOString(), event: text(input.event || input.type, 80) || 'runtime', detail: text(input.detail || input.summary),
              sessionId: text(input.sessionId || runtime.sessionId, 120), routeId: text(input.routeId || runtime.routeId, 120), panelId: text(input.panelId || runtime.panelId, 120), action: text(input.action || runtime.action, 120), status: text(input.status || runtime.status, 80),
              selectedTargetDeviceId: options.sourceDeviceId, selectedWorker: evidenceWorker ? { id: evidenceWorker.id, name: evidenceWorker.name || '', online: evidenceWorker.online, capabilities: evidenceWorker.capabilities } : null,
              device: { serialNumber: text(device.serialNumber || input.serialNumber, 120), userAgent: text(device.userAgent || request.headers['user-agent']), model: text(device.model, 120), platform: text(device.platform, 120) },
              runtime: { appName: text(runtime.appName || input.appName, 120) || 'RabiLink AIUI', appVersion: text(runtime.appVersion || input.appVersion, 80), aiuiVersion: text(runtime.aiuiVersion || input.aiuiVersion, 80) } };
            stored.proofs.push(row); return row;
          });
          send(200, { code: 0, ok: true, proof }); return true;
        }
        fail('MOBILE_PATH_NOT_FOUND', 404);
      } catch (cause) { const error = cause as { code?: string; statusCode?: number }; send(error.statusCode || 500, { code: error.code || 'MOBILE_OWNER_FAILED', ok: false }); }
      return true;
    }
  };
}
