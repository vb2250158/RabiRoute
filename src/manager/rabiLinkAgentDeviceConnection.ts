import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { hasAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { validateInternalManagerHop } from '../shared/internalManagerHop.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';
import { isLoopbackRemoteAddress } from './webguiLanAccess.js';

export type RabiLinkConnectionConfig = { enabled: boolean; url: string; token: string; deviceId: string };
export function rabiLinkConnectionScope(config: RabiLinkConnectionConfig): string {
  if (!config.enabled || !config.url.trim() || !config.token.trim() || !config.deviceId.trim()) return '';
  return createHash('sha256').update(config.url.replace(/\/+$/, '') + '\n' + config.token).digest('hex');
}

/** Only the current local transport owner may assert an originating device. */
export function rabiLinkTrustedTransport(request: IncomingMessage, generation: string, scope?: string): boolean {
  return Boolean(generation) && isLoopbackRemoteAddress(request.socket.remoteAddress)
    && Boolean(validateInternalManagerHop(request, { generation, ...(scope === undefined ? {} : { scope }) }));
}

export function rabiLinkTransportAssertionPresent(request: IncomingMessage): boolean {
  return ['x-rabilink-internal-hop', 'x-rabilink-tunnel-local', 'x-rabilink-tunnel-device-id', 'x-rabiroute-peer-proxy', 'x-rabiroute-relay-proxy']
    .some(name => request.headers[name] !== undefined);
}

export function rabiLinkAgentDevicePrincipal(request: IncomingMessage, config: RabiLinkConnectionConfig, generation: string): RabiLinkAgentPrincipal | null {
  // The native transport marker must not bypass the original ingress fence.
  try { hasAuthenticatedConnectionRequest(request); } catch { return null; }
  const scope = rabiLinkConnectionScope(config);
  if (!scope) return null;
  if (rabiLinkTrustedTransport(request, generation, scope)) {
    const source = request.headers['x-rabilink-tunnel-device-id'];
    if (source === '$application') return { scope, sourceDeviceId: 'application', deviceOwner: false };
    if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) return null;
    return { scope, sourceDeviceId: source, deviceOwner: true };
  }
  if (rabiLinkTransportAssertionPresent(request)) return null;
  try {
    return hasAuthenticatedConnectionRequest(request) ? { scope, sourceDeviceId: config.deviceId, deviceOwner: false } : null;
  } catch { return null; }
}
