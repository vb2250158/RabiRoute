import { readTimeoutOverrides } from "../shared/timeoutSettings.js";
import path from 'node:path';
import type http from 'node:http';
import { createAgentProfileService, validateAgentProfile } from '../../packages/rabilink-agent-contract/profile.mjs';
import { normalizeAgentProfileState, type AgentProfileState } from '../../packages/rabilink-agent-contract/state.mjs';
import { readAiuiPersonaTemplate } from '../../packages/rabilink-agent-contract/persona.mjs';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';

export type RabiLinkAgentPrincipal = { scope: string; sourceDeviceId: string; deviceOwner?: boolean };
export type RabiLinkAgentDevicesOptions = {
  dataDir: string; sourceDeviceId: string;
  /** Produced by the authenticated connection owner, never body or unverified headers. */
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  /** Compare original owner identity without constructing or switching owners. */
  assertCurrent?(): void;
  connectionContextAvailable?(): boolean;
  readLocal(pathname: string): Promise<any>;
  readTarget?(sourceDeviceId: string, pathname: string): Promise<any>;
  /** Confirmed authenticated PC assignment may be reused offline. */
  deviceOwnerTarget(deviceId: string): Promise<string>;
};
type Store = { version: 1; devices: Record<string, AgentProfileState> };
export const PROFILE_DEVICE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const devicePattern = new RegExp(PROFILE_DEVICE_ID_PATTERN);
const deviceKey = (value: string) => devicePattern.test(value);
const error = (code: string, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

/** PC owns configuration and receipts; this service never executes an Agent. */
export function createRabiLinkAgentDevices(options: RabiLinkAgentDevicesOptions) {
  const resource = new RabiLinkOwnerStore<Store>(path.join(options.dataDir, 'rabilink-agent-devices'), () => ({ version: 1, devices: {} }), value => {
    const result = value as Store;
    if (!result || result.version !== 1 || !result.devices || typeof result.devices !== 'object' || Array.isArray(result.devices)) throw error('PROFILE_STORE_INVALID', 503);
    return result;
  });
  function inspect(stored: Store) {
    const devices: Record<string, AgentProfileState> = {};
    const invalidDeviceIds: string[] = [];
    for (const [id, raw] of Object.entries(stored.devices)) {
      try {
        if (!deviceKey(id)) throw error('PROFILE_DEVICE_INVALID');
        const normalized = normalizeAgentProfileState(raw);
        if (!normalized) throw error('PROFILE_RECORD_INVALID');
        Object.defineProperty(devices, id, { value: normalized, enumerable: true });
      } catch { invalidDeviceIds.push(id); }
    }
    return { devices, invalidDeviceIds };
  }
  return {
    /** Admission is retained from before body parsing through every awaited read. */
    prepare(request: http.IncomingMessage, signal?: AbortSignal) {
      options.assertCurrent?.();
      if (options.connectionContextAvailable?.() === false) throw error('PROFILE_CONTEXT_UNAVAILABLE', 503);
      const authorized = options.authorize(request);
      if (!authorized?.scope || !(deviceKey(authorized.sourceDeviceId) || (authorized.sourceDeviceId === '$application' && authorized.deviceOwner === false))) throw error('PROFILE_CONNECTION_REQUIRED', 401);
      const principal = Object.freeze({ ...authorized });
      let writeAttempted = false;
      const fence = () => {
        options.assertCurrent?.(); signal?.throwIfAborted();
        const current = options.authorize(request);
        if (!current || current.scope !== principal.scope || current.sourceDeviceId !== principal.sourceDeviceId || current.deviceOwner !== principal.deviceOwner) throw error('PROFILE_CONNECTION_CHANGED', 401);
      };
      const finish = async <T>(run: () => T | Promise<T>): Promise<T> => {
        try { fence(); const result = await run(); fence(); return result; }
        catch (cause) { if (writeAttempted && cause && typeof cause === 'object') Object.assign(cause, { uncertain: true }); throw cause; }
      };
      async function target(requested: string) {
        const id = requested === 'self' ? principal.sourceDeviceId : requested;
        if (!deviceKey(id)) throw error('PROFILE_DEVICE_INVALID');
        if (await options.deviceOwnerTarget(id) !== options.sourceDeviceId) throw error('PROFILE_OWNER_PC_MISMATCH', 409);
        fence(); return id;
      }
      function service(deviceId: string) {
        return createAgentProfileService({
          readStore() {
            const stored = inspect(resource.read(principal.scope));
            if (stored.invalidDeviceIds.includes(deviceId)) throw error('PROFILE_RECORD_INVALID', 503);
            return { apps: [{ id: principal.scope, enabled: true, deviceBindings: [
              ...Object.entries(stored.devices).map(([id, agentProfileState]) => ({ id, enabled: true, credentialHash: principal.scope, agentProfileState })),
              ...(Object.hasOwn(stored.devices, deviceId) ? [] : [{ id: deviceId, enabled: true, credentialHash: principal.scope }])
            ] }] };
          },
          writeStore(value) {
            fence();
            const app = (value as { apps: { deviceBindings: { id: string; agentProfileState?: AgentProfileState }[] }[] }).apps[0];
            const stored = resource.read(principal.scope);
            if (inspect(stored).invalidDeviceIds.includes(deviceId)) throw error('PROFILE_RECORD_INVALID', 503);
            const updated = app.deviceBindings.find(item => item.id === deviceId)?.agentProfileState;
            if (!updated) throw error('PROFILE_RECORD_INVALID', 503);
            normalizeAgentProfileState(updated);
            // Preserve every other raw row, including quarantined records.
            Object.defineProperty(stored.devices, deviceId, { value: updated, enumerable: true, writable: true, configurable: true });
            writeAttempted = true;
            resource.write(principal.scope, stored);
          }
        });
      }
      const application = { kind: 'application', appId: principal.scope };
      return Object.freeze({
        list: () => finish(async () => {
          const inspected = inspect(resource.read(principal.scope));
          const entries = Object.entries(inspected.devices);
          await Promise.all(entries.map(([id]) => target(id)));
          return { devices: entries.map(([id, state]) => ({ id, profile: state.profile, applied: state.applied, savedRevision: state.profile.revision,
            historyPersonas: [...new Map(state.operations.flatMap(operation => operation.receipt.profile.personaRef ? [[JSON.stringify(operation.receipt.profile.personaRef), { ...operation.receipt.profile.personaRef, name: operation.receipt.profile.name }] as const] : [])).values()] })), sourceDeviceId: options.sourceDeviceId, coverage: { invalidDeviceIds: inspected.invalidDeviceIds } };
        }),
        template: (body: unknown) => finish(async () => {
          const input = body as { roleId?: unknown; skillIds?: unknown };
          if (!input || Object.keys(input).some(key => !['roleId', 'skillIds'].includes(key))) throw error('PERSONA_TEMPLATE_INVALID');
          return { profile: await readAiuiPersonaTemplate({ read: async pathname => { fence(); const value = await options.readLocal(pathname); fence(); return value; }, roleId: input.roleId, sourceDeviceId: options.sourceDeviceId, skillIds: input.skillIds || [] }) };
        }),
        read: (requested: string) => finish(async () => { const id = await target(requested); return { ...(service(id).readForApplication(application, id) as Record<string, unknown>), timeoutOverrides: readTimeoutOverrides() }; }),
        operation: (requested: string, operationId: string) => finish(async () => { const id = await target(requested); return service(id).readOperationForApplication(application, id, operationId); }),
        save: (requested: string, body: unknown) => finish(async () => {
          const id = await target(requested), profile = validateAgentProfile((body as { profile?: unknown })?.profile);
          if (profile.personaRef) {
            const catalog = profile.personaRef.sourceDeviceId === options.sourceDeviceId ? await options.readLocal('/api/personas')
              : await (options.readTarget ? options.readTarget(profile.personaRef.sourceDeviceId, '/api/personas') : Promise.reject(error('PERSONA_SOURCE_UNAVAILABLE', 503)));
            fence();
            if (!catalog.personas?.some((item: { personaId: string }) => item.personaId === profile.personaRef?.roleId)) throw error('PERSONA_NOT_FOUND', 404);
            await target(id);
          }
          fence(); return service(id).saveForApplication(application, id, body);
        }),
        acknowledge: (requested: string, body: unknown) => finish(async () => {
          const id = await target(requested);
          if (id !== principal.sourceDeviceId || principal.deviceOwner === false) throw error('PROFILE_RECEIPT_OWNER_REQUIRED', 403);
          return service(id).acknowledge({ kind: 'device', appId: principal.scope, bindingId: id, credentialHash: principal.scope }, body);
        })
      });
    }
  };
}
export type RabiLinkAgentDevices = ReturnType<typeof createRabiLinkAgentDevices>;
export type RabiLinkPreparedProfiles = ReturnType<RabiLinkAgentDevices['prepare']>;
