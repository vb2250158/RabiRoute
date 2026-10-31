import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.agent-communication@1");
        context.services.provide("manager.agent-communication@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const pendingEffects = [];
            const disposers = [];
            const disposeStartedEffects = async () => {
                let firstError;
                for (const dispose of [...disposers].reverse()) {
                    try { await dispose(); } catch (error) { firstError ??= error; }
                }
                if (firstError) throw firstError;
            };
            const ctx = Object.freeze({
                effect(starter, label) {
                    const pending = Promise.resolve().then(starter).then(dispose => {
                        if (typeof dispose !== "function") throw new Error(`Plugin effect did not return a disposer: ${label ?? "effect"}.`);
                        disposers.push(dispose);
                        return dispose;
                    });
                    pendingEffects.push(pending);
                    return pending;
                }
            });
            try {
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId,
                runtime.createApiDiscoveryOperations(runtime.managerPluginRoutes), context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate API contract discovery");
        const uploads = runtime.createAgentUploadRoutes({ store: runtime.agentUploadStore, assertAuthorized: runtime.assertUploadAuthorized, jsonResponse: runtime.jsonResponse });
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, uploads.operations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate executable upload contracts");
        const routes = runtime.createAgentCommunicationRoutes({
            readJsonBody: runtime.readJsonBody,
            jsonResponse: runtime.jsonResponse,
            receiptResponse: deliveryId => runtime.agentSendReceiptResponse(runtime.rootDir, deliveryId),
            findSendTraces: query => runtime.findAgentSendTraces(runtime.rootDir, query),
            readNodeDeliveryRecords: runtime.readNodeDeliveryRecords,
            send: runtime.performAgentSend,
            readChatHistory: runtime.readAgentChatHistory,
            maintenance: runtime.maintenance,
            qqDiagnostics: runtime.qqDiagnostics,
            groupFiles: runtime.groupFiles,
            qqMessages: runtime.qqMessages,
            agentRequests: runtime.agentRequests,
            refreshAgentRequestReminderTimers: runtime.refreshAgentRequestReminderTimers,
            publishManagerEvent: runtime.publishManagerEvent
        });
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, routes.operations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate executable Agent communication contracts");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId,
                runtime.createCodexHookOperations(runtime.codexHookContextService), context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate executable Hook contracts");


                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.agent-communication");
    }
}).activate;
