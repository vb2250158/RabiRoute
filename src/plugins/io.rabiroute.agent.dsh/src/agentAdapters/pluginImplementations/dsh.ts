import { config } from "@rabiroute/host-api/config";
import { notifyDshSession } from '../../dshSessionBridge.js';
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
            await notifyInstanceAgent("dsh", binding, envelope, options);
            return;
        } await notifyDshSession(renderRabiDelivery(envelope), options?.imagePaths, { ...config, dshAgentPreset: process.env.DSH_AGENT_PRESET }); } } }; }
