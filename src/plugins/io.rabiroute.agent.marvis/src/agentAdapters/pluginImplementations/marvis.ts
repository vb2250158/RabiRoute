import { notifyMarvis } from '../../marvis.js';
import { notifyInstanceAgent } from '@rabiroute/host-api/agentAdapters/lanAgentAdapter';
import { renderRabiDelivery } from '@rabiroute/host-api/shared/rabiMessage';
import type { AgentDeliveryOptions } from '@rabiroute/host-api/agentAdapters/contracts';
import type { AgentInstanceBinding } from '@rabiroute/host-api/shared/agentInstance';
import type { RabiDeliveryEnvelope } from '@rabiroute/host-api/shared/rabiMessage';
export function createAgentOperations() { return { operations: { async deliver({ envelope, options, binding }: {
            envelope: RabiDeliveryEnvelope;
            options?: AgentDeliveryOptions;
            binding?: AgentInstanceBinding;
        }) { if (binding) {
            await notifyInstanceAgent("marvis", binding, envelope, options);
            return;
        } await notifyMarvis(renderRabiDelivery(envelope)); } } }; }
