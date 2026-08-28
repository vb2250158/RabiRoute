import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.speech@1");
        context.services.provide("manager.speech@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "speech-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "语音服务"
                    },
                    "routeId": "route.speech",
                    "rendererId": "builtin.web-page.speech.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 50
                }
            },
            {
                "kind": "navigation",
                "id": "speech",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "语音服务"
                    },
                    "routeId": "route.speech",
                    "icon": "mdi-waveform",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 50
                }
            },
            {
                "kind": "status-card",
                "id": "speech-status",
                "value": {
                    "surface": "shared.status",
                    "label": {
                        "fallback": "语音服务"
                    },
                    "queryId": "manager.speech-status",
                    "rendererId": "builtin.speech-status.v1",
                    "icon": "mdi-waveform",
                    "slot": "runtime-status",
                    "hosts": [
                        "web",
                        "desktop"
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
        let active = true;
        const reconcile = () => runtime.reconcileSpeechMicrophone(runtime.managerServicesReady ? "speech plugin activation" : "manager startup", () => active);
        runtime.reconcileActiveSpeech = reconcile;
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:speech", "manager.speech.api", [
                requestTracker.wrap((request, requestUrl, response) => runtime.handleSpeechApi(request, requestUrl, response))
            ], [
                { routeId: "speech", kind: "prefix", pathPrefix: "/api/speech/" }
            ]);
            return async () => {
                active = false;
                if (runtime.reconcileActiveSpeech === reconcile)
                    runtime.reconcileActiveSpeech = () => { };
                unregister();
                await requestTracker.stop();
                await Promise.allSettled([
                    runtime.speechControl.stopMicrophone(),
                    runtime.speechControl.stopPlayback(),
                    runtime.speechRuntimeControl.stop()
                ]);
                runtime.speechModelManager.stop();
            };
        }, "activate Manager speech plugin");
        if (runtime.managerServicesReady && !runtime.managerReadOnly)
            reconcile();

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.speech");
    }
}).activate;
