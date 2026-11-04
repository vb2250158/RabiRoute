import type { AgentAdapterProvider } from "@rabiroute/plugin-sdk";
import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
export type AgentAdapterGeneration = Pick<PluginGeneration, "records" | "services" | "contributions">;
let processGeneration: (() => AgentAdapterGeneration | undefined) | undefined;
/** An accessor to the original native owner, never a second active-provider table. */
export function installAgentAdapterGenerationReader(reader: () => AgentAdapterGeneration | undefined): () => void {
    const previous = processGeneration;
    processGeneration = reader;
    return () => { if (processGeneration === reader)
        processGeneration = previous; };
}
export function currentAgentAdapterGeneration(): AgentAdapterGeneration | undefined { return processGeneration?.(); }
export function resolveAgentAdapterProviders(generation: AgentAdapterGeneration | undefined): Readonly<{
    providers: ReadonlyMap<string, AgentAdapterProvider>;
    diagnostics: readonly {
        instanceId: string;
        message: string;
    }[];
}> {
    const providers = new Map<string, AgentAdapterProvider>();
    const diagnostics: Array<{
        instanceId: string;
        message: string;
    }> = [], conflicts = new Set<string>();
    if (!generation)
        return { providers, diagnostics };
    const active = new Map(generation.records.filter(record => record.status === "active").map(record => [record.identity.instanceId, record]));
    for (const contribution of generation.contributions.contributions) {
        if (contribution.kind !== "agent-adapter")
            continue;
        const value = contribution.value as {
            type?: unknown;
            capability?: unknown;
            manifest?: {
                type?: unknown;
            };
        } | undefined;
        if (!value || typeof value.type !== "string" || typeof value.capability !== "string" || value.manifest?.type !== value.type)
            continue;
        const record = active.get(contribution.instanceId), registration = generation.services.services.get(value.capability);
        if (!record || !record.manifest.provides.includes(value.capability) || registration?.providerInstanceId !== contribution.instanceId)
            continue;
        const provider = registration.value as AgentAdapterProvider | undefined;
        if (!provider || provider.type !== value.type || provider.capability !== value.capability
            || provider.identity?.activationId !== record.identity.activationId || typeof provider.invoke !== "function")
            continue;
        if (providers.has(value.type) || conflicts.has(value.type)) {
            const previous = providers.get(value.type);
            const message = `Agent adapter has multiple published owners: ${value.type}.`;
            if (previous)
                diagnostics.push({ instanceId: previous.identity.instanceId, message });
            diagnostics.push({ instanceId: record.identity.instanceId, message });
            conflicts.add(value.type);
            providers.delete(value.type);
            continue;
        }
        providers.set(value.type, provider);
    }
    return { providers, diagnostics };
}
export function publishedAgentAdapterProviders(generation: AgentAdapterGeneration | undefined): ReadonlyMap<string, AgentAdapterProvider> {
    return resolveAgentAdapterProviders(generation).providers;
}
