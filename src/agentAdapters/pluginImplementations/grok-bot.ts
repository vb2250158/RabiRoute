import { createGrokBotAdapter } from '../grokBotAdapter.js';
import { notifyInstanceAgent } from '../lanAgentAdapter.js';
import { renderRabiDelivery } from '../../shared/rabiMessage.js';
import type { AgentDeliveryOptions } from '../contracts.js';
import type { AgentInstanceBinding } from '../../shared/agentInstance.js';
import type { RabiDeliveryEnvelope } from '../../shared/rabiMessage.js';
export function createAgentOperations() { return { operations: { async deliver({ envelope, options, binding }: {
            envelope: RabiDeliveryEnvelope;
            options?: AgentDeliveryOptions;
            binding?: AgentInstanceBinding;
        }) { if (binding) {
            await notifyInstanceAgent("grokBot", binding, envelope, options);
            return;
        } return createGrokBotAdapter().deliver(envelope, options); } } }; }
