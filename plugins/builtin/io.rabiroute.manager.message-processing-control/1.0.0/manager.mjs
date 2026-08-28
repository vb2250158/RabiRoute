import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.message-processing-control@1");
        context.services.provide("manager.message-processing-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:message-processing-control", "manager.message-processing-control.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleMessageProcessingApi(request, requestUrl, response, {
                    boardPayload: runtime.messageProcessingBoardPayload,
                    board: runtime.messageProcessingBoard,
                    sendContextReview: runtime.messageProcessingSendContextReview,
                    operationalLog: runtime.managerOperationalLog,
                    recallKnowledge: runtime.recalledKnowledgeForMessage,
                    verifyCriticalFactRecord: ({ roleId, requirement, disposition }) => runtime.verifyCriticalProjectFactRecord({
                        workspaceRoot: runtime.rootDir,
                        roleDir: roleId ? runtime.roleDirForApi(roleId) : undefined,
                        requirement,
                        disposition
                    }),
                    setPlanBaseline: runtime.setMessageProcessingPlanBaseline,
                    scheduleKnowledgeCallbackReminder: runtime.scheduleKnowledgeCallbackReminder,
                    publishEvent: runtime.publishManagerEvent,
                    trackOperation: operation => requestTracker.trackOperation(operation)
                }))
            ], [
                { routeId: "board", kind: "exact", path: "/api/message-processing/board", methods: ["GET"] },
                { routeId: "requirements", kind: "exact", path: "/api/message-processing/requirements", methods: ["POST"] },
                { routeId: "requirement-resource", kind: "prefix", pathPrefix: "/api/message-processing/requirements/" }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
            };
        }, "activate Manager message processing control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.message-processing-control");
    }
}).activate;
