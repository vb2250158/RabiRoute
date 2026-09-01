import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.persona@1");
        context.services.provide("manager.persona@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "page",
                "id": "persona-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "人格配置"
                    },
                    "routeId": "route.persona",
                    "rendererId": "builtin.web-page.persona.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 30
                }
            },
            {
                "kind": "navigation",
                "id": "persona",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "人格配置"
                    },
                    "routeId": "route.persona",
                    "icon": "mdi-account-heart-outline",
                    "slot": "route-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 30
                }
            },
            {
                "kind": "page",
                "id": "knowledge-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "计划与记忆"
                    },
                    "routeId": "route.knowledge",
                    "rendererId": "builtin.web-page.knowledge.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "navigation",
                "id": "knowledge",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "计划与记忆"
                    },
                    "routeId": "route.knowledge",
                    "icon": "mdi-notebook-check-outline",
                    "slot": "route-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "page",
                "id": "persona-sync-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "多电脑人格同步"
                    },
                    "routeId": "route.persona-sync",
                    "rendererId": "builtin.web-page.persona-sync.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 45
                }
            },
            {
                "kind": "navigation",
                "id": "persona-sync",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "多电脑人格同步"
                    },
                    "routeId": "route.persona-sync",
                    "icon": "mdi-folder-sync-outline",
                    "slot": "persona-secondary",
                    "hosts": [
                        "web"
                    ],
                    "order": 45
                }
            },
            {
                "kind": "page",
                "id": "persona-document-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "人格正文"
                    },
                    "routeId": "route.persona-document",
                    "rendererId": "builtin.web-page.persona-document.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 46
                }
            },
            {
                "kind": "command",
                "id": "open-role-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "人格目录"
                    },
                    "handlerId": "desktop.open-role-directory",
                    "slot": "persona",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "command",
                "id": "open-plan-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "计划目录"
                    },
                    "handlerId": "desktop.open-plan-directory",
                    "slot": "persona",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "command",
                "id": "open-memory-directory",
                "value": {
                    "surface": "desktop.panel",
                    "label": {
                        "fallback": "记忆目录"
                    },
                    "handlerId": "desktop.open-memory-directory",
                    "slot": "persona",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.panel-action"
                    ],
                    "order": 30
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
        let personaSyncStarted = false;
        let personaSyncDisposed = false;
        let manifestStartTimer;
        const startPersonaSync = () => {
            if (personaSyncStarted || personaSyncDisposed) return;
            personaSyncStarted = true;
            runtime.personaSyncAutoReconciler?.start();
            // The manifest index and automatic sync can traverse or apply plan packages.
            // They share the Manager-owned plan-storage startup admission gate.
            manifestStartTimer = setTimeout(() => {
                manifestStartTimer = undefined;
                if (personaSyncDisposed) return;
                void runtime.personaSyncService.startManifestIndex()
                    .catch(error => console.warn(`Persona sync manifest index unavailable; queries will reconcile on demand: ${error instanceof Error ? error.message : String(error)}`));
            }, 0);
            manifestStartTimer.unref();
        };
        const removePlanStorageReadyListener = runtime.planStorageStartup?.onReady(startPersonaSync) ?? (() => {
            startPersonaSync();
            return () => {};
        })();
        const requestTracker = new runtime.ManagerPluginRequestTracker();
        ctx.effect(() => {
            const unregister = runtime.registerManagerPluginHandlerRoutes(runtime.managerPluginRoutes, "manager:persona", "manager.persona.api", [
                requestTracker.wrap((request, requestUrl, response) => (runtime.handlePersonaPluginApi(request, requestUrl, response)
                    || runtime.handleLanguageStyleApi(request, requestUrl, response, runtime.languageStyleValidator)
                    || runtime.handlePersonaSyncApi(request, requestUrl, response, runtime.personaSyncRouteContext(true))))
            ], [
                { routeId: "personas", kind: "exact", path: "/api/personas", methods: ["GET"] },
                { routeId: "personas-resource", kind: "prefix", pathPrefix: "/api/personas/" },
                { routeId: "roles-api", kind: "prefix", pathPrefix: "/api/roles/" },
                { routeId: "roles-static", kind: "prefix", pathPrefix: "/roles/" },
                { routeId: "persona-sync", kind: "prefix", pathPrefix: "/api/persona-sync" },
                { routeId: "language-style-validate", kind: "exact", path: "/api/language-style/validate", methods: ["POST"] },
                { routeId: "role-panel-messages", kind: "exact", path: "/api/role-panel/messages", methods: ["POST"] }
            ]);
            return async () => {
                personaSyncDisposed = true;
                removePlanStorageReadyListener();
                if (manifestStartTimer) clearTimeout(manifestStartTimer);
                unregister();
                await requestTracker.stop();
                runtime.personaSyncAutoReconciler?.stop();
                runtime.personaSyncService.stopManifestIndex();
            };
        }, "activate Manager persona plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.persona");
    }
}).activate;
