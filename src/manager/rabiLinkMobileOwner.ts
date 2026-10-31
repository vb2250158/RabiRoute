import { Ajv2020 } from "ajv/dist/2020.js";
import { MOBILE_OWNER_LIMITS, proof, status, worker } from "./rabiLinkMobileContract.js";
export { MOBILE_OWNER_LIMITS } from "./rabiLinkMobileContract.js";
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';

export type RabiLinkMobileWorker = { id: string; name?: string; online: boolean; capabilities: string[]; [key: string]: unknown };
type MobileState = { version: 1; asrPriority: string[]; deviceStatus: Record<string, unknown> | null; proofs: Record<string, unknown>[]; operations: { key: string; fingerprint: string; result: unknown }[] };
export type RabiLinkMobileOwnerOptions = {
  dataDir: string;
  sourceDeviceId: string;
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  assertCurrent?(): void;
  connectionContextAvailable?(): boolean;
  applicationOwnerTarget(): Promise<string>;
  peers(): Promise<RabiLinkMobileWorker[]>;
};
export const MOBILE_OPERATION_KEY_PATTERN = '^[A-Za-z0-9:._-]{1,128}$';
const operationKeyPattern = new RegExp(MOBILE_OPERATION_KEY_PATTERN);
const fail = (code: string, statusCode = 400): never => { throw Object.assign(new Error(code), { code, statusCode }); };
const empty = (): MobileState => ({ version: 1, asrPriority: [], deviceStatus: null, proofs: [], operations: [] });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, limit = 220) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const validation = new Ajv2020({ strict: false });
const validProof = validation.compile(proof);
const validWorker = validation.compile(worker);
const validStatusView = validation.compile(status);
const validPriority = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MOBILE_OWNER_LIMITS.priority && value.every(id => typeof id === 'string') && new Set(value).size === value.length;
const validStatus = (value: unknown) => value === null || Boolean(value && typeof value === 'object' && Number.isFinite(Date.parse(String((value as Record<string, unknown>).receivedAt))) && validStatusView({ code: 0, ok: true, deviceStatus: { ...value, ageMs: 0, stale: false, staleAfterMs: MOBILE_OWNER_LIMITS.staleAfterMs } }));
function requireArray(value: unknown, code: string): asserts value is unknown[] { if (!Array.isArray(value)) fail(code, 503); }
function originalOperation(stored: MobileState, key: string) {
  requireArray(stored.operations, 'MOBILE_OPERATIONS_INVALID');
  const matches = stored.operations.filter(row => row?.key === key);
  if (matches.length > 1) fail('MOBILE_OPERATION_RECORD_INVALID', 503);
  const previous = matches[0];
  if (previous && (!operationKeyPattern.test(previous.key) || !/^[a-f0-9]{64}$/.test(previous.fingerprint))) fail('MOBILE_OPERATION_RECORD_INVALID', 503);
  if (!previous && stored.operations.some(row => !row || typeof row.key !== 'string' || !operationKeyPattern.test(row.key))) fail('MOBILE_OPERATION_IDENTITY_UNKNOWN', 503);
  return previous;
}
export function createRabiLinkMobileOwner(options: RabiLinkMobileOwnerOptions) {
  const state = new RabiLinkOwnerStore<MobileState>(path.join(options.dataDir, 'rabilink-mobile-owner'), empty, value => {
    const stored = value as MobileState;
    if (!stored || Array.isArray(stored) || stored.version !== 1) fail('MOBILE_OWNER_STORE_INVALID', 503);
    return stored;
  });
  return {
    /** Retain the authenticated connection and PC generation before body consumption. */
    prepare(request: http.IncomingMessage, signal?: AbortSignal) {
      options.assertCurrent?.();
      if (options.connectionContextAvailable?.() === false) fail('MOBILE_CONTEXT_UNAVAILABLE', 503);
      const authorized = options.authorize(request);
      if (!authorized?.scope) fail('MOBILE_CONNECTION_REQUIRED', 401);
      const principal = Object.freeze({ ...authorized! });
      let writeAttempted = false;
      const fence = () => {
        options.assertCurrent?.(); signal?.throwIfAborted();
        const current = options.authorize(request);
        if (!current || current.scope !== principal.scope || current.sourceDeviceId !== principal.sourceDeviceId || current.deviceOwner !== principal.deviceOwner) fail('MOBILE_CONNECTION_CHANGED', 401);
      };
      const finish = async <T>(run: () => T | Promise<T>): Promise<T> => {
        try { fence(); const result = await run(); fence(); return result; }
        catch (cause) { if (writeAttempted && cause && typeof cause === 'object') Object.assign(cause, { uncertain: true }); throw cause; }
      };
      async function ensureOwner() {
        if (await options.applicationOwnerTarget() !== options.sourceDeviceId) fail('MOBILE_OWNER_PC_MISMATCH', 409);
        fence();
      }
      function mutate(action: string, body: unknown, apply: (stored: MobileState) => unknown) {
        fence();
        const key = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : '';
        if (!operationKeyPattern.test(key)) fail('MOBILE_OPERATION_KEY_INVALID');
        const stored = state.read(principal.scope), fingerprint = digest([action, body]), previous = originalOperation(stored, key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
          const result = previous.result as { priority?: unknown } | null;
          if (!(action === 'asr-settings' ? validPriority(result?.priority) : action === 'device-status' ? previous.result !== null && validStatus(previous.result) : validProof(previous.result))) fail('MOBILE_OPERATION_RECORD_INVALID', 503);
          return structuredClone(previous.result);
        }
        if (stored.operations.length >= MOBILE_OWNER_LIMITS.operations) fail('MOBILE_OPERATION_CAPACITY', 409);
        const result = apply(stored); stored.operations.push({ key, fingerprint, result });
        fence(); writeAttempted = true; state.write(principal.scope, stored);
        return structuredClone(result);
      }
      async function asr(body?: unknown, save = false) {
        await ensureOwner();
        const workers = (await options.peers()).filter(item => validWorker(item) && item.capabilities.includes('asr')); fence();
        await ensureOwner();
        const changed = save ? mutate('asr-settings', body, stored => {
          const priority = (body as { priority?: unknown })?.priority;
          if (!Array.isArray(priority) || priority.length > MOBILE_OWNER_LIMITS.priority || priority.some(id => typeof id !== 'string' || !workers.some(worker => worker.id === id)) || new Set(priority).size !== priority.length) fail('ASR_PRIORITY_INVALID');
          if (!validPriority(stored.asrPriority)) fail('MOBILE_ASR_RECORD_INVALID', 503);
          stored.asrPriority = [...priority as string[]]; return { priority: stored.asrPriority };
        }) as { priority: string[] } : null;
        const priority = changed?.priority || state.read(principal.scope).asrPriority;
        if (!validPriority(priority)) fail('MOBILE_ASR_RECORD_INVALID', 503);
        const rank = new Map(priority.map((id, index) => [id, index]));
        workers.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
        return { ok: true, priority, workers, selectedWorkerId: workers.find(worker => worker.online)?.id || '' };
      }
      async function deviceStatus(body?: unknown, save = false) {
        await ensureOwner();
        let status = state.read(principal.scope).deviceStatus;
        if (save) status = mutate('device-status', body, stored => {
          if (!validStatus(stored.deviceStatus)) fail('MOBILE_STATUS_RECORD_INVALID', 503);
          const input = body as { batteryLevel?: unknown; level?: unknown; charging?: unknown; observedAt?: unknown };
          const level = Number(input?.batteryLevel ?? input?.level);
          if (!Number.isFinite(level) || level < 0 || level > 100 || typeof input?.charging !== 'boolean') fail('DEVICE_STATUS_INVALID');
          const now = new Date().toISOString(), observed = Date.parse(text(input.observedAt));
          stored.deviceStatus = { batteryLevel: Math.round(level), charging: input.charging, observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : now, receivedAt: now, source: 'rokid-cxr-phone' };
          return stored.deviceStatus;
        }) as Record<string, unknown>;
        if (!validStatus(status)) fail('MOBILE_STATUS_RECORD_INVALID', 503);
        const ageMs = status ? Math.max(0, Date.now() - Date.parse(String(status.receivedAt))) : 0;
        const view: (Record<string, unknown> & { ageMs: number; stale: boolean; staleAfterMs: number }) | null = status
          ? { ...status, ageMs, stale: ageMs > MOBILE_OWNER_LIMITS.staleAfterMs, staleAfterMs: MOBILE_OWNER_LIMITS.staleAfterMs } : null;
        return { code: 0, ok: true, deviceStatus: view };
      }
      return Object.freeze({
        healthCapabilities: () => finish(() => ({ rabilinkWearableObservation: { processingPolicies: ['transcribe', 'agent'], expectedWorkerFencing: true, processingPolicyFrozen: true } })),
        readAsr: () => finish(() => asr()),
        saveAsr: (body: unknown) => finish(() => asr(body, true)),
        readDeviceStatus: () => finish(() => deviceStatus()),
        saveDeviceStatus: (body: unknown) => finish(() => deviceStatus(body, true)),
        listProofs: (rawLimit: string | null) => finish(async () => {
          await ensureOwner();
          // Preserve Number coercion, clamping and native fractional slice semantics.
          const limit = Math.max(1, Math.min(MOBILE_OWNER_LIMITS.proofPage, Number(rawLimit) || 20));
          const raw = state.read(principal.scope).proofs; requireArray(raw, 'MOBILE_PROOFS_INVALID');
          const readable = raw.filter(row => validProof(row));
          return { code: 0, ok: true, proofs: readable.slice(-limit).reverse(), invalidRecords: raw.length - readable.length };
        }),
        recordProof: (body: unknown) => finish(async () => {
          await ensureOwner();
          const evidenceWorker = (await options.peers()).find(item => validWorker(item) && item.id === options.sourceDeviceId); fence();
          await ensureOwner();
          const proof = mutate('proof', body, stored => {
            requireArray(stored.proofs, 'MOBILE_PROOFS_INVALID');
            if (stored.proofs.length >= MOBILE_OWNER_LIMITS.proofs) fail('PROOF_STORAGE_CAPACITY', 409);
            const input = body as Record<string, unknown> || {}, runtime = (input.runtime || {}) as Record<string, unknown>, device = (input.device || {}) as Record<string, unknown>;
            const row = { id: 'proof-' + randomUUID(), time: new Date().toISOString(), event: text(input.event || input.type, 80) || 'runtime', detail: text(input.detail || input.summary),
              sessionId: text(input.sessionId || runtime.sessionId, 120), routeId: text(input.routeId || runtime.routeId, 120), panelId: text(input.panelId || runtime.panelId, 120), action: text(input.action || runtime.action, 120), status: text(input.status || runtime.status, 80),
              selectedTargetDeviceId: options.sourceDeviceId, selectedWorker: evidenceWorker ? { id: evidenceWorker.id, name: evidenceWorker.name || '', online: evidenceWorker.online, capabilities: evidenceWorker.capabilities } : null,
              device: { serialNumber: text(device.serialNumber || input.serialNumber, 120), userAgent: text(device.userAgent || request.headers['user-agent']), model: text(device.model, 120), platform: text(device.platform, 120) },
              runtime: { appName: text(runtime.appName || input.appName, 120) || 'RabiLink AIUI', appVersion: text(runtime.appVersion || input.appVersion, 80), aiuiVersion: text(runtime.aiuiVersion || input.aiuiVersion, 80) } };
            stored.proofs.push(row); return row;
          });
          return { code: 0, ok: true, proof };
        })
      });
    }
  };
}
export type RabiLinkMobileOwner = ReturnType<typeof createRabiLinkMobileOwner>;
export type RabiLinkPreparedMobile = ReturnType<RabiLinkMobileOwner['prepare']>;
