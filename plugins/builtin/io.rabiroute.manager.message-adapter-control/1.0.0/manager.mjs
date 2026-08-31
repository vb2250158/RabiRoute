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
                        "fallback": "消息适配器"
                    },
                    "routeId": "route.adapters",
                    "rendererId": "builtin.web-page.adapters.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "navigation",
                "id": "message-adapters",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "消息适配器"
                    },
                    "routeId": "route.adapters",
                    "icon": "mdi-puzzle-outline",
                    "slot": "route-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 20
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
        ctx.effect(() => {
            const providers = new runtime.MessageAdapterScanProviderRegistry();
            const service = new runtime.MessageAdapterControlService(providers);
            const unregisterProviders = runtime.registerBuiltinMessageAdapterScanProviders(providers, {
                rootDir: runtime.rootDir,
                adapterRuntimes: runtime.adapterRuntimes,
                routeCallbackEndpoint: runtime.routeCallbackEndpoint,
                routeHasRecentMessages: runtime.routeHasRecentMessages,
                checkHttpEndpoint: runtime.checkHttpEndpoint,
                fenneNotePlaybackUrl: runtime.fenneNotePlaybackUrl,
                scanNapcatEndpoint: () => runtime.scanNapcatEndpoint(runtime.napcatManagerCtx()),
                remoteAgentScanResult: runtime.remoteAgentMessageAdapterScanResult,
                speechStatus: () => runtime.speechControl.status(),
                xiaomiHomeHealth: runtime.xiaomiHomeHealthForScan,
                readGatewayStatus: runtime.readGatewayStatus,
                weixinDefaultBaseUrl: () => process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com"
            });
            const requestTracker = new runtime.ManagerPluginRequestTracker();
            const unregisterRoutes = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:message-adapter-control", "manager.message-adapter-control.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleMessageAdapterControlApi(request, requestUrl, response, {
                    service,
                    scanNapcatHealth: runtime.napcatScanHealthPayload,
                    gatewayPayload: () => runtime.standaloneGatewayPayload(),
                    jsonResponse: runtime.jsonResponse,
                    trackOperation: operation => requestTracker.trackOperation(operation)
                }))
            ], [
                { routeId: "scan", kind: "exact", path: "/api/scan/message-adapters", methods: ["GET"] }
            ]);
            return async () => {
                unregisterRoutes();
                await Promise.all([
                    requestTracker.stop(),
                    service.stop()
                ]);
                unregisterProviders();
            };
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
