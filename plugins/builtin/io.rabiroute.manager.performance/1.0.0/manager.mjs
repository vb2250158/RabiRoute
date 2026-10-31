import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.performance@1");
        context.services.provide("manager.performance@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "performance-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "routeId": "global.performance",
                    "rendererId": "builtin.web-page.performance.v1",
                    "slot": "global",
                    "hosts": [
                        "web"
                    ],
                    "order": 60
                }
            },
            {
                "kind": "navigation",
                "id": "performance",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "routeId": "global.performance",
                    "icon": "mdi-chart-timeline-variant",
                    "slot": "utility",
                    "hosts": [
                        "web"
                    ],
                    "order": 60
                }
            },
            {
                "kind": "status-card",
                "id": "performance-status",
                "value": {
                    "surface": "shared.status",
                    "label": {
                        "fallback": "性能监控"
                    },
                    "queryId": "manager.performance-status",
                    "rendererId": "builtin.performance-status.v1",
                    "icon": "mdi-chart-timeline-variant",
                    "slot": "runtime-status",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 30
                }
            }
        ])
            context.contributions.register(contribution);
        const recordHttpRequest = (...args) => runtime.performanceMonitoring.recordHttpRequest(...args);
        const api = new runtime.PerformanceApi({
            service: runtime.performanceMonitoring,
            globalConfig: runtime.rabiGlobalConfig,
            gatewayExists: gatewayId => Boolean(runtime.runtimes.get(gatewayId))
        });
        const collector = runtime.performanceMonitoring.createActivation(runtime.managerReadOnly);
        let operations;
        let disposal;
        let previousHttpHook;
        const dispose = () => disposal ??= (async () => {
            const results = await Promise.allSettled([
                Promise.resolve().then(() => operations?.dispose()),
                Promise.resolve().then(() => api.close())
            ]);
            if (runtime.recordManagerHttpRequest === recordHttpRequest)
                runtime.recordManagerHttpRequest = () => { };
            const collectorResult = await Promise.allSettled([Promise.resolve().then(() => collector.dispose())]);
            const failures = [...results, ...collectorResult].filter(result => result.status === "rejected");
            if (failures.length === 1) throw failures[0].reason;
            if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), "Manager performance owner cleanup failed.");
        })();
        context.publication.add({
            publish() {
                previousHttpHook = runtime.recordManagerHttpRequest;
                collector.publish();
                runtime.recordManagerHttpRequest = recordHttpRequest;
            },
            rollback() {
                if (runtime.recordManagerHttpRequest === recordHttpRequest)
                    runtime.recordManagerHttpRequest = previousHttpHook;
                collector.rollback();
            },
            afterPublish: () => collector.start(),
            retire: dispose
        }, "publish Manager performance collector");
        // Registration now yields; the candidate still owns its API and collector
        // if cancellation rejects before the starter can return this disposer.
        context.effects.adopt(dispose, "prepared Manager performance owner");
        context.effects.add(async () => {
            operations = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createPerformanceOperations(api), context.lifecycle.signal);
            return dispose;
        }, "activate Manager performance operations");
    }
}).activate;
