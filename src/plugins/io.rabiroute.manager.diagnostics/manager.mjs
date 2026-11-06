import { definePlugin } from "@rabiroute/plugin-sdk";
import { createDiagnosticsRoutes } from "./operations.mjs";
export const activate = definePlugin({
    async activate(context) {
        const statuses = context.services.require("host.manager.gateway-status@1");
        const api = context.services.require("host.manager.operations@1");
        context.services.provide("manager.diagnostics@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "runtime-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "日志诊断"
                    },
                    "routeId": "route.runtime",
                    "rendererId": "builtin.web-page.runtime.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 70
                }
            },
            {
                "kind": "navigation",
                "id": "runtime",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "日志诊断"
                    },
                    "routeId": "route.runtime",
                    "icon": "mdi-console-line",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 70
                }
            },
            {
                "kind": "page",
                "id": "deliveries-page",
                "value": {
                    "surface": "web.pages",
                    "label": { "fallback": "投递记录" },
                    "routeId": "global.deliveries",
                    "rendererId": "builtin.web-page.deliveries.v1",
                    "slot": "route",
                    "hosts": ["web"],
                    "order": 71
                }
            },
            {
                "kind": "navigation",
                "id": "deliveries",
                "value": {
                    "surface": "web.navigation",
                    "label": { "fallback": "投递记录" },
                    "routeId": "global.deliveries",
                    "icon": "mdi-send-check-outline",
                    "slot": "utility",
                    "hosts": ["web"],
                    "order": 71
                }
            }
        ])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const routes = createDiagnosticsRoutes({ gatewayDiagnosticsPayload: () => statuses.readStatuses() });
            const registration = await api.registerOperationsAsync(routes.operations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager diagnostics operations");
    }
}).activate;
