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
        const codexHookRequestTracker = new runtime.ManagerPluginRequestTracker();
        const routes = runtime.createAgentCommunicationRoutes({
            readJsonBody: runtime.readJsonBody,
            jsonResponse: runtime.jsonResponse,
            receiptResponse: deliveryId => runtime.agentSendReceiptResponse(runtime.rootDir, deliveryId),
            findSendTraces: query => runtime.findAgentSendTraces(runtime.rootDir, query),
            send: runtime.performAgentSend,
            agentRequests: runtime.agentRequests,
            refreshAgentRequestReminderTimers: runtime.refreshAgentRequestReminderTimers,
            publishManagerEvent: runtime.publishManagerEvent
        });
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:agent-communication", "manager.agent-communication.api", [
                routes.handler,
                codexHookRequestTracker.wrap((request, requestUrl, response) => (runtime.handleCodexHookApi(request, requestUrl, response, runtime.codexHookContextService)))
            ], [
                { routeId: "requests", kind: "exact", path: "/api/agent/requests", methods: ["GET"] },
                { routeId: "request-resource", kind: "prefix", pathPrefix: "/api/agent/requests/" },
                { routeId: "send", kind: "exact", path: "/api/agent/send", methods: ["POST"] },
                { routeId: "send-traces", kind: "exact", path: "/api/agent/send/traces", methods: ["GET"] },
                { routeId: "send-receipts", kind: "prefix", pathPrefix: "/api/agent/send/receipts/" },
                { routeId: "codex-context", kind: "exact", path: "/api/codex-hook/context", methods: ["POST"], handlerIndex: 1 },
                { routeId: "codex-roles", kind: "exact", path: "/api/codex-hook/roles", methods: ["GET"], handlerIndex: 1 },
                { routeId: "codex-doctor", kind: "exact", path: "/api/codex-hook/doctor", methods: ["GET"], handlerIndex: 1 },
                { routeId: "codex-sessions", kind: "exact", path: "/api/codex-hook/sessions", methods: ["GET"], handlerIndex: 1 },
                { routeId: "codex-session-resource", kind: "prefix", pathPrefix: "/api/codex-hook/sessions/", handlerIndex: 1 }
            ]);
            return async () => {
                unregister();
                await Promise.all([
                    routes.stopAcceptingAndDrain(),
                    codexHookRequestTracker.stop()
                ]);
            };
        }, "activate Manager Agent communication plugin");

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
