import { definePlugin } from "@rabiroute/plugin-sdk";
import { createSpeechPluginLifecycle } from "./lifecycle.mjs";
export const activate = definePlugin({
    async activate(context) {
        const host = context.services.require("host.message-endpoints@1");
        const { createImplementation, hostModules } = await import("./manager-runtime.mjs");
        await host.prepareModules(hostModules);
        const implementation = createImplementation(host);
        const service = implementation.createSpeechPluginRuntime(host.manager.speechPorts,
            host.manager.speechPorts.currentService("manager.speech@1"), context.identity.instanceId);
        const runtime = Object.create(host.manager.speechLifecycle, Object.getOwnPropertyDescriptors(service));
        const lifecycle = createSpeechPluginLifecycle(runtime, context.identity, context.lifecycle.signal);
        context.services.provide("manager.speech@1", service);
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
        context.effects.add(lifecycle.prepare, "activate Manager speech operations");
        context.publication.add(lifecycle.publication, "publish Manager speech ownership");
    }
}).activate;
