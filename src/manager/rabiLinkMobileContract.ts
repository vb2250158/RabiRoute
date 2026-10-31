import type { ApiSchema } from "./apiOperationContract.js";
export const MOBILE_OWNER_LIMITS = Object.freeze({ priority: 100, operations: 2048, proofs: 50000, staleAfterMs: 180000, proofPage: 100 });
const string = { type: 'string' }, boolean = { type: 'boolean' };
export const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties)) => ({ type: 'object', required, additionalProperties: false, properties });
export const worker = { type: 'object', required: ['id', 'online', 'capabilities'], properties: { id: string, name: string, online: boolean, capabilities: { type: 'array', items: string } } };
export const proof = object({ id: { type: 'string', pattern: '^proof-[a-f0-9-]{36}$' }, time: string, event: { type: 'string', maxLength: 80 }, detail: { type: 'string', maxLength: 220 },
  sessionId: { type: 'string', maxLength: 120 }, routeId: { type: 'string', maxLength: 120 }, panelId: { type: 'string', maxLength: 120 }, action: { type: 'string', maxLength: 120 }, status: { type: 'string', maxLength: 80 },
  selectedTargetDeviceId: string, selectedWorker: { anyOf: [worker, { type: 'null' }] },
  device: object({ serialNumber: { type: 'string', maxLength: 120 }, userAgent: { type: 'string', maxLength: 220 }, model: { type: 'string', maxLength: 120 }, platform: { type: 'string', maxLength: 120 } }),
  runtime: object({ appName: { type: 'string', maxLength: 120 }, appVersion: { type: 'string', maxLength: 80 }, aiuiVersion: { type: 'string', maxLength: 80 } }) });
export const asr = object({ ok: { const: true }, priority: { type: 'array', maxItems: MOBILE_OWNER_LIMITS.priority, uniqueItems: true, items: string }, workers: { type: 'array', items: worker }, selectedWorkerId: string });
export const status = object({ code: { const: 0 }, ok: { const: true }, deviceStatus: { anyOf: [{ type: 'null' }, object({ batteryLevel: { type: 'integer', minimum: 0, maximum: 100 }, charging: boolean,
  observedAt: string, receivedAt: string, source: { const: 'rokid-cxr-phone' }, ageMs: { type: 'number', minimum: 0 }, stale: boolean, staleAfterMs: { const: MOBILE_OWNER_LIMITS.staleAfterMs } })] } });
