import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.message-adapter-control@1");
        context.services.provide("manager.message-adapter-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "message-adapters-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "消息"
                    },
                    "routeId": "route.adapters",
                    "rendererId": "builtin.web-page.adapters.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 40
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
            const providers = new runtime.MessageAdapterScanProviderRegistry();
            const service = new runtime.MessageAdapterControlService(providers);
            const unregisterProviders = runtime.registerBuiltinMessageAdapterScanProviders(providers, {
                rootDir: runtime.rootDir,
                adapterRuntimes: runtime.adapterRuntimes,
                routeCallbackEndpoint: runtime.routeCallbackEndpoint,
                routeHasRecentMessages: runtime.routeHasRecentMessages,
                checkHttpEndpoint: runtime.checkHttpEndpoint,
                scanNapcatEndpoint: () => runtime.scanNapcatEndpoint(runtime.napcatManagerCtx()),
                remoteAgentScanResult: runtime.remoteAgentMessageAdapterScanResult,
                speechStatus: () => runtime.speechControl.status(),
                xiaomiHomeHealth: runtime.xiaomiHomeHealthForScan,
                readGatewayStatus: runtime.readGatewayStatus,
                weixinDefaultBaseUrl: () => process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com"
            });
            let registration;
            const retire = async () => {
                const retired = registration?.dispose();
                const results = await Promise.allSettled([retired, service.stop()]);
                unregisterProviders();
                const failure = results.find(result => result.status === "rejected");
                if (failure) throw failure.reason;
            };
            try {
                registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createMessageAdapterControlOperations({
                    service,
                    scanNapcatHealth: () => runtime.napcatScanHealthPayload(probe => service.trackProbe(probe)),
                    gatewayPayload: () => runtime.standaloneGatewayPayload()
                }), context.lifecycle.signal);
                return retire;
            } catch (error) {
                await retire().catch(() => {});
                throw error;
            }
        }, "activate Manager message adapter control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.message-adapter-control");
    }
}).activate;
