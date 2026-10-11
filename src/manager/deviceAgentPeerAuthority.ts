import type { IncomingMessage } from 'node:http';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';
import {
  assertDeviceAgentPreparedAuthority,
  assertDeviceAgentPreparedClaimAuthority,
  type DeviceAgentPreparedInput,
  type DeviceAgentPreparedClaimEvidence
} from './deviceAgentPreparedAuthority.js';

export type DeviceAgentPeerAuthorityOptions = {
  scope(): string;
  localDeviceId(): string;
  authorize(request: IncomingMessage): RabiLinkAgentPrincipal | null;
  trustedTransport(request: IncomingMessage): boolean;
  readProof(ledgerOwnerDeviceId: string, deliveryId: string, generation: string): Promise<unknown>;
};
const denied = () => Object.assign(new Error('DEVICE_AGENT_LEDGER_CONNECTION_CHANGED'), {
  code: 'DEVICE_AGENT_LEDGER_CONNECTION_CHANGED', statusCode: 403
});

/** Recheck the admitted caller after reading the original PC's reservation. */
export function createDeviceAgentPeerAuthority(options: DeviceAgentPeerAuthorityOptions) {
  function admission(request: IncomingMessage, sourceDeviceId: string) {
    const original = options.authorize(request);
    const scope = options.scope(), localDeviceId = options.localDeviceId();
    if (!scope || !localDeviceId || !options.trustedTransport(request) || !original?.deviceOwner
      || original.scope !== scope || original.sourceDeviceId !== sourceDeviceId) throw denied();
    return () => {
      const current = options.authorize(request);
      if (!options.trustedTransport(request) || options.scope() !== scope || options.localDeviceId() !== localDeviceId
        || !current?.deviceOwner || current.scope !== scope || current.sourceDeviceId !== sourceDeviceId) throw denied();
      return scope;
    };
  }
  return {
    async authorizePrepared(request: IncomingMessage, agentId: string, input: DeviceAgentPreparedInput) {
      if (!input?.delivery || input.delivery.target?.agentId !== agentId) throw denied();
      const assertCurrent = admission(request, input.ledgerOwnerDeviceId);
      const proof = await options.readProof(input.ledgerOwnerDeviceId, input.delivery.deliveryId, input.delivery.generation);
      const scope = assertCurrent();
      assertDeviceAgentPreparedAuthority(input, proof);
      return { scope, ledgerOwnerDeviceId: input.ledgerOwnerDeviceId };
    },
    async authorizePreparedClaim(request: IncomingMessage, agentId: string, evidence: DeviceAgentPreparedClaimEvidence) {
      if (evidence.target?.agentId !== agentId) throw denied();
      const assertCurrent = admission(request, agentId);
      const proof = await options.readProof(evidence.ledgerOwnerDeviceId, evidence.deliveryId, evidence.generation);
      assertCurrent();
      assertDeviceAgentPreparedClaimAuthority(evidence, proof);
    }
  };
}
