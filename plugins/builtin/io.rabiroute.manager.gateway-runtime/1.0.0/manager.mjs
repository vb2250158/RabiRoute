import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.gateway-runtime@1");
        context.services.provide("manager.gateway-runtime@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "command",
                "id": "open-runtime-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "状态目录"
                    },
                    "handlerId": "desktop.open-runtime-directory",
                    "slot": "runtime",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "command",
                "id": "manual-trigger",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "手动触发"
                    },
                    "handlerId": "desktop.manual-trigger",
                    "slot": "runtime",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 60
                }
            }
        ])
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
            const operations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createGatewayControlOperations(), context.lifecycle.signal);
            let releaseRuntimeLease, listenerProjection, disposal;
            const dispose = () => disposal ??= (async () => {
                const finalOwner = releaseRuntimeLease?.() ?? false;
                releaseRuntimeLease = undefined;
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => listenerProjection?.dispose()),
                    Promise.resolve().then(() => operations.dispose())
                ]);
                if (finalOwner) results.push(...await Promise.allSettled([
                    Promise.resolve().then(() => runtime.manualTriggerProcesses.stopOwner("manager:gateway-runtime")),
                    Promise.resolve().then(() => runtime.stopAllGatewaysAndWait())
                ]));
                const failure = results.find(result => result.status === "rejected");
                if (failure) throw failure.reason;
            })();
            try {
                listenerProjection = runtime.createGatewayListenerProjection();
                context.publication.add({
                    publish() {
                        // A lease enables the shared reconcile entry. Acquire it
                        // in the same synchronous transaction as publication.
                        releaseRuntimeLease = runtime.acquireGatewayRuntimePluginLease();
                    },
                    rollback() {
                        releaseRuntimeLease?.();
                        releaseRuntimeLease = undefined;
                    },
                    async afterPublish({ previousRetirement, signal }) {
                        await previousRetirement;
                        signal.throwIfAborted();
                        if (runtime.managerServicesReady && !runtime.managerReadOnly)
                            await runtime.syncRunningGateways();
                    }
                }, "publish Manager Gateway runtime owner");
            } catch (error) {
                await dispose();
                throw error;
            }
            return dispose;
        }, "activate Manager Gateway runtime plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.gateway-runtime");
    }
}).activate;
