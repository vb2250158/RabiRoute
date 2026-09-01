import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.route-control@1");
        context.services.provide("manager.route-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "command",
                "id": "quick-setup",
                "value": {
                    "surface": "web.commands",
                    "label": {
                        "fallback": "快速配置"
                    },
                    "handlerId": "web.quick-setup",
                    "requiredCapabilities": [
                        "web.command"
                    ],
                    "icon": "mdi-lightning-bolt-outline",
                    "slot": "sidebar-footer-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "command",
                "id": "add-route",
                "value": {
                    "surface": "web.commands",
                    "label": {
                        "fallback": "新增航线"
                    },
                    "handlerId": "web.add-route",
                    "requiredCapabilities": [
                        "web.command"
                    ],
                    "icon": "mdi-plus",
                    "slot": "topbar-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "command",
                "id": "open-manager-config",
                "value": {
                    "surface": "web.commands",
                    "label": {
                        "fallback": "打开配置目录"
                    },
                    "handlerId": "web.open-manager-config",
                    "requiredCapabilities": [
                        "web.command"
                    ],
                    "icon": "mdi-folder-cog-outline",
                    "slot": "sidebar-footer",
                    "hosts": [
                        "web"
                    ],
                    "order": 30
                }
            },
            {
                "kind": "command",
                "id": "open-project-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "项目目录"
                    },
                    "handlerId": "desktop.open-project-directory",
                    "slot": "route",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 35
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
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:route-control", "manager.route-control.api", [
                requestTracker.wrap((request, requestUrl, response) => {
                    if (runtime.handleRabiApi(request, requestUrl, response, {
                        rootDir: runtime.rootDir,
                        routeRoot: runtime.routeRoot,
                        managerPort: runtime.managerPort,
                        managerHost: runtime.managerHost,
                        applicationGenerationId: runtime.applicationGenerationId,
                        managerInstanceId: runtime.managerInstanceId,
                        version: runtime.rabiRoutePackageVersion,
                        globalConfig: runtime.rabiGlobalConfig,
                        runtimes: () => runtime.runtimes.values(),
                        runtimeStatus: runtime.runtimeStatus,
                        readConfig: runtime.readConfig,
                        writeConfig: runtime.writeConfig,
                        loadRuntimes: runtime.loadRuntimes,
                        routeCatalogVersion: runtime.routeCatalogVersion,
                        routeCatalogPersonas: runtime.routeCatalogPersonas,
                        syncRunningGateways: runtime.syncRunningGateways,
                        syncRabiLinkRelay: () => runtime.syncActiveRabiLinkRelay(),
                        routeDataDir: definition => runtime.dataDirFor(definition),
                        scanAgentAdapters: () => {
                            const service = runtime.agentAdapterCatalogService;
                            if (!service) {
                                throw Object.assign(new Error("Agent adapter catalog plugin is inactive."), { statusCode: 503 });
                            }
                            return service.scanAll();
                        }
                    }))
                        return true;
                    if (request.method === "GET" && requestUrl.pathname === "/manager-config") {
                        runtime.jsonResponse(response, 200, {
                            code: 0,
                            routeDir: runtime.path.relative(runtime.rootDir, runtime.routeRoot).replace(/\\/g, "/"),
                            rolesDir: runtime.path.relative(runtime.rootDir, runtime.rolesRoot).replace(/\\/g, "/")
                        });
                        return true;
                    }
                    if (request.method === "POST" && requestUrl.pathname === "/manager-config") {
                        void requestTracker.trackOperation(runtime.readJsonBody(request)
                            .then(async body => {
                            const cfg = runtime.readManagerConfig();
                            if (body.routeDir !== undefined)
                                cfg.routeDir = body.routeDir || undefined;
                            if (body.rolesDir !== undefined)
                                cfg.rolesDir = body.rolesDir || undefined;
                            runtime.writeManagerConfig(cfg);
                            await runtime.ensureDataDirs();
                            runtime.jsonResponse(response, 200, {
                                code: 0,
                                routeDir: runtime.path.relative(runtime.rootDir, runtime.routeRoot).replace(/\\/g, "/"),
                                rolesDir: runtime.path.relative(runtime.rootDir, runtime.rolesRoot).replace(/\\/g, "/")
                            });
                        })
                            .catch(error => runtime.jsonResponse(response,
                            Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
                            code: -1,
                            errorCode: typeof error?.code === "string" ? error.code : "request_failed",
                            message: error instanceof Error ? error.message : String(error)
                        })));
                        return true;
                    }
                    return false;
                })
            ], [
                { routeId: "rabi-identity", kind: "exact", path: "/api/rabi/identity", methods: ["GET", "PATCH"] },
                { routeId: "rabi-instances", kind: "exact", path: "/api/rabi/instances", methods: ["GET"] },
                { routeId: "rabi-instance-resource", kind: "prefix", pathPrefix: "/api/rabi/instances/" },
                { routeId: "manager-config", kind: "exact", path: "/manager-config", methods: ["GET", "POST"] }
            ]);
            return async () => {
                unregister();
                await requestTracker.stop();
            };
        }, "activate Manager Route control plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.route-control");
    }
}).activate;
