import path from 'node:path';
import type http from 'node:http';
import { createAgentProfileService, validateAgentProfile } from '../../packages/rabilink-agent-contract/profile.mjs';
import { normalizeAgentProfileState, type AgentProfileState } from '../../packages/rabilink-agent-contract/state.mjs';
import { readAiuiPersonaTemplate } from '../../packages/rabilink-agent-contract/persona.mjs';
import { RabiLinkOwnerStore } from './rabiLinkOwnerStore.js';

export type RabiLinkAgentPrincipal = { scope: string; sourceDeviceId: string; deviceOwner?: boolean };
export type RabiLinkAgentDevicesOptions = {
  dataDir: string;
  sourceDeviceId: string;
  /** Must be produced by the authenticated connection owner, never body or unverified headers. */
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  readLocal(pathname: string): Promise<any>;
  /** Authenticated PC-to-PC Manager HTTP, used only when profile refers to another persona owner. */
  readTarget?(sourceDeviceId: string, pathname: string): Promise<any>;
  /** Immutable authenticated connection assignment; a confirmed assignment may be reused offline. */
  deviceOwnerTarget(deviceId: string): Promise<string>;
};
type Store = { version: 1; devices: Record<string, AgentProfileState> };
const deviceKey = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const error = (code: string, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
export function rabiLinkAgentDevicesPath(pathname: string): boolean {
  return pathname === '/api/rabilink/agent-devices' || pathname.startsWith('/api/rabilink/agent-devices/') || pathname === '/api/rabilink/persona-template';
}

/** PC owns device profiles. Relay receives no persona, instructions, Skills or chat history. */
export function createRabiLinkAgentDevices(options: RabiLinkAgentDevicesOptions) {
  const directory = path.join(options.dataDir, 'rabilink-agent-devices');
  const resource = new RabiLinkOwnerStore<Store>(directory, () => ({ version: 1, devices: {} }), value => {
    const result = value as Store;
    if (result.version !== 1 || !result.devices || Array.isArray(result.devices)) throw error('PROFILE_STORE_INVALID', 500);
    for (const [id, value] of Object.entries(result.devices)) {
      if (!deviceKey(id)) throw error('PROFILE_STORE_INVALID', 500);
      normalizeAgentProfileState(value);
    }
    return result;
  });
  const read = (scope: string) => resource.read(scope);
  const write = (scope: string, value: Store) => resource.write(scope, value);
  function service(scope: string, deviceId: string) {
    return createAgentProfileService({
      readStore() {
        const stored = read(scope);
        return { apps: [{ id: scope, enabled: true, deviceBindings: [
          ...Object.entries(stored.devices).map(([id, agentProfileState]) => ({ id, enabled: true, credentialHash: scope, agentProfileState })),
          ...(Object.hasOwn(stored.devices, deviceId) ? [] : [{ id: deviceId, enabled: true, credentialHash: scope }])
        ] }] };
      },
      writeStore(value) {
        const app = (value as { apps: { deviceBindings: { id: string; agentProfileState?: AgentProfileState }[] }[] }).apps[0];
        write(scope, { version: 1, devices: Object.fromEntries(app.deviceBindings.filter(item => item.agentProfileState).map(item => [item.id, item.agentProfileState!])) });
      }
    });
  }
  async function ensureOwner(deviceId: string) {
    if (await options.deviceOwnerTarget(deviceId) !== options.sourceDeviceId) throw error('PROFILE_OWNER_PC_MISMATCH', 409);
  }
  return {
    async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, body: unknown): Promise<boolean> {
      const prefix = '/api/rabilink/agent-devices';
      if (!rabiLinkAgentDevicesPath(url.pathname)) return false;
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      try {
        const principal = options.authorize(request);
        if (!principal?.scope || !(deviceKey(principal.sourceDeviceId) || (principal.sourceDeviceId === '$application' && principal.deviceOwner === false))) throw error('PROFILE_CONNECTION_REQUIRED', 401);
        const fence = () => {
          const current = options.authorize(request);
          if (!current || current.scope !== principal.scope || current.sourceDeviceId !== principal.sourceDeviceId || current.deviceOwner !== principal.deviceOwner)
            throw error('PROFILE_CONNECTION_CHANGED', 401);
        };
        if (url.pathname === '/api/rabilink/persona-template') {
          if (request.method !== 'POST') throw error('METHOD_NOT_ALLOWED', 405);
          const input = body as { roleId?: unknown; skillIds?: unknown };
          if (!input || Object.keys(input).some(key => !['roleId', 'skillIds'].includes(key))) throw error('PERSONA_TEMPLATE_INVALID');
          const profile = await readAiuiPersonaTemplate({ read: options.readLocal, roleId: input.roleId, sourceDeviceId: options.sourceDeviceId, skillIds: input.skillIds || [] });
          fence();
          send(200, { code: 0, data: { profile } }); return true;
        }
        if (url.pathname === prefix) {
          if (request.method !== 'GET') throw error('METHOD_NOT_ALLOWED', 405);
          const entries = Object.entries(read(principal.scope).devices);
          await Promise.all(entries.map(([id]) => ensureOwner(id)));
          fence();
          const devices = entries.map(([id, state]) => ({ id, profile: state.profile, applied: state.applied, savedRevision: state.profile.revision,
            historyPersonas: [...new Map(state.operations.flatMap(operation => operation.receipt.profile.personaRef ? [[JSON.stringify(operation.receipt.profile.personaRef), { ...operation.receipt.profile.personaRef, name: operation.receipt.profile.name }] as const] : [])).values()] }));
          send(200, { code: 0, data: { devices, sourceDeviceId: options.sourceDeviceId } }); return true;
        }
        const match = /^\/api\/rabilink\/agent-devices\/([^/]+)\/profile(?:\/(receipt)|\/operations\/([^/]+))?$/.exec(url.pathname);
        if (!match) throw error('PROFILE_PATH_INVALID', 404);
        const requested = decodeURIComponent(match[1]), id = requested === 'self' ? principal.sourceDeviceId : requested;
        if (!deviceKey(id)) throw error('PROFILE_DEVICE_INVALID');
        await ensureOwner(id);
        fence();
        const profiles = service(principal.scope, id), application = { kind: 'application', appId: principal.scope };
        let data: unknown;
        if (match[2] && request.method === 'POST') {
          // Only that signed device owner acknowledges application; management can save profiles separately.
          if (id !== principal.sourceDeviceId || principal.deviceOwner === false) throw error('PROFILE_RECEIPT_OWNER_REQUIRED', 403);
          data = profiles.acknowledge({ kind: 'device', appId: principal.scope, bindingId: id, credentialHash: principal.scope }, body);
        } else if (match[3] && request.method === 'GET') data = profiles.readOperationForApplication(application, id, decodeURIComponent(match[3]));
        else if (!match[2] && !match[3] && request.method === 'GET') data = profiles.readForApplication(application, id);
        else if (!match[2] && !match[3] && request.method === 'PUT') {
          const input = body as { profile?: unknown };
          const profile = validateAgentProfile(input?.profile);
          if (profile.personaRef) {
            const catalog = profile.personaRef.sourceDeviceId === options.sourceDeviceId
              ? await options.readLocal('/api/personas')
              : await (options.readTarget ? options.readTarget(profile.personaRef.sourceDeviceId, '/api/personas') : Promise.reject(error('PERSONA_SOURCE_UNAVAILABLE', 503)));
            if (!catalog.personas?.some((item: { personaId: string }) => item.personaId === profile.personaRef?.roleId)) throw error('PERSONA_NOT_FOUND', 404);
          }
          fence();
          data = profiles.saveForApplication(application, id, body);
        } else throw error('METHOD_NOT_ALLOWED', 405);
        send(200, { code: 0, data });
      } catch (cause) { const failure = cause as { statusCode?: number; code?: string }; send(failure.statusCode || 500, { code: failure.code || 'PROFILE_REQUEST_FAILED' }); }
      return true;
    }
  };
}
