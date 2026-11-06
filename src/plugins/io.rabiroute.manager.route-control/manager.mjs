import { createImplementation, hostModules } from "./manager-runtime.mjs";
import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const shared = context.services.require("host.manager.route-control@2");
        await shared.prepareModules(hostModules);
        const runtime = createImplementation(shared).createOwnedRuntime(shared);
        context.services.provide("manager.route-control@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "command",
                "id": "create-role",
                "value": {
                    "surface": "web.commands",
                    "label": {
                        "fallback": "新建角色"
                    },
                    "handlerId": "web.create-role",
                    "requiredCapabilities": [
                        "web.command"
                    ],
                    "icon": "mdi-account-plus-outline",
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
                        "fallback": "新增路由"
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
        context.effects.add(async () => { const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createRabiControlOperations(), context.lifecycle.signal); return () => registration.dispose(); }, "activate Manager Route control operations");
    }
}).activate;
