import { createCodexRuntime } from '../../codexRuntime.js';
import { nativeOperations } from '@rabiroute/host-api/agentAdapters/managerNativeOperations';
import { notifyInstanceAgent } from '@rabiroute/host-api/agentAdapters/lanAgentAdapter';
import { renderRabiDelivery } from '@rabiroute/host-api/shared/rabiMessage';
import type { AgentDeliveryOptions } from '@rabiroute/host-api/agentAdapters/contracts';
import type { AgentInstanceBinding } from '@rabiroute/host-api/shared/agentInstance';
import type { RabiDeliveryEnvelope } from '@rabiroute/host-api/shared/rabiMessage';
export function createAgentOperations() { const runtime = createCodexRuntime(); return { operations: { ...nativeOperations({ notifyCodex: runtime.notifyCodex, notifyCodexWhenIdle: runtime.notifyCodexWhenIdle }), isBusy: () => runtime.isCodexMonitorThreadActive(), async deliver({ envelope, options, binding }: {
            envelope: RabiDeliveryEnvelope;
            options?: AgentDeliveryOptions;
            binding?: AgentInstanceBinding;
        }) { if (binding) {
            await notifyInstanceAgent("codex", binding, envelope, options);
            return;
        } await runtime.notifyCodex(renderRabiDelivery(envelope), options?.imagePaths); } }, dispose: runtime.disposeCodexAdapterTransport }; }
