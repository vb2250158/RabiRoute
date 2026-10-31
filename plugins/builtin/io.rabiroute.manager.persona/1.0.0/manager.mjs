import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.persona@1");
        context.services.provide("manager.persona@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
{
    "kind": "page",
    "id": "message-history-page",
    "value": {
        "surface": "web.pages",
        "label": {
            "fallback": "消息记录"
        },
        "routeId": "role.message-history",
        "slot": "route",
        "hosts": [
            "web"
        ],
        "order": 35,
        "rendererId": "builtin.web-page.message-history.v1"
    }
},
{
    "kind": "navigation",
    "id": "message-history",
    "value": {
        "surface": "web.navigation",
        "label": {
            "fallback": "消息记录"
        },
        "routeId": "role.message-history",
        "slot": "route-primary",
        "hosts": [
            "web"
        ],
        "order": 35,
        "icon": "mdi-message-text-outline"
    }
},
            {
                "kind": "page",
                "id": "persona-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "角色配置"
                    },
                    "routeId": "route.persona",
                    "rendererId": "builtin.web-page.persona.v1",
                    "slot": "route",
                    "hosts": [
                        "web"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "navigation",
                "id": "persona",
                "value": {
                    "surface": "web.navigation",
                    "label": {
                        "fallback": "角色配置"
                    },
                    "routeId": "route.persona",
                    "icon": "mdi-account-heart-outline",
                    "slot": "route-primary",
                    "hosts": [
                        "web"
                    ],
                    "order": 20
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
                    "order": 30
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
                    "order": 30
                }
            },
            {
                "kind": "page",
                "id": "persona-document-page",
                "value": {
                    "surface": "web.pages",
                    "label": {
                        "fallback": "角色正文"
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
                        "fallback": "角色目录"
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
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.roleConfigurationOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager role configuration operations");

        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaResourceOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona resource operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaPlanOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona plan operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaHistoryOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona history operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaSkillOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona Skill operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaKnowledgeOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona knowledge operations");
        ctx.effect(async () => {
            const owner = new runtime.PersonaStorageOwner(runtime.personaStorageContext);
            let registration;
            try { registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createPersonaStorageOperations(owner), context.lifecycle.signal); }
            catch (error) {
                try { await owner.stop(); }
                catch (cleanupError) { throw new AggregateError([error, cleanupError], "Manager persona storage preparation failed."); }
                throw error;
            }
            return async () => {
                const failures = [];
                try { await registration.dispose(); } catch (error) { failures.push(error); }
                try { await owner.stop(); } catch (error) { failures.push(error); }
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) throw new AggregateError(failures, "Manager persona storage cleanup failed.");
            };
        }, "activate Manager persona storage operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaIdentityOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona identity operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaHealthOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona health operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaCompanionOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona companion operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaRecordingOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona recording operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.languageStyleOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager language style operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.rolePanelOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager role-panel operations");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, [runtime.personaDirectoryOperation], context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona directory operation");
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.personaMessagingOperations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager persona messaging operations");

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
