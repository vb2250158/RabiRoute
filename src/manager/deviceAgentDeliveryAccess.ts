import type { IncomingMessage } from 'node:http';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';

export type DeviceAgentDeliveryAccessOptions = {
  authorize(request: IncomingMessage): RabiLinkAgentPrincipal | null;
  ownerInstanceId(): string;
};

/** Enabled, authenticated callers share the API. Route bindings only choose automatic delivery. */
export function deviceAgentDeliveryPrincipal(request: IncomingMessage, agentId: string, options: DeviceAgentDeliveryAccessOptions): RabiLinkAgentPrincipal | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(agentId)) return null;
  const instanceId = request.headers['x-rabi-device-agent-instance'];
  if (instanceId !== undefined && instanceId !== options.ownerInstanceId()) return null;
  try { return options.authorize(request); } catch { return null; }
}
