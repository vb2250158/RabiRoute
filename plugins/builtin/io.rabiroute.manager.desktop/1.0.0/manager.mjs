import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.desktop@1");
        context.services.provide("manager.desktop@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [
            {
                "kind": "settings-section",
                "id": "desktop-settings",
                "value": {
                    "surface": "shared.settings",
                    "label": {
                        "fallback": "桌面功能"
                    },
                    "rendererId": "builtin.desktop-settings.v1",
                    "schemaId": "desktop.settings.v1",
                    "readCommandId": "manager.desktop-settings.read",
                    "writeCommandId": "manager.desktop-settings.write",
                    "icon": "mdi-monitor-dashboard",
                    "slot": "desktop",
                    "hosts": [
                        "web",
                        "desktop"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "command",
                "id": "open-webgui",
                "value": {
                    "surface": "desktop.commands",
                    "label": {
                        "fallback": "打开 WebGUI"
                    },
                    "handlerId": "desktop.open-webgui",
                    "slot": "system",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "command",
                "id": "open-settings",
                "value": {
                    "surface": "desktop.commands",
                    "label": {
                        "fallback": "打开设置"
                    },
                    "handlerId": "desktop.open-settings",
                    "slot": "system",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 20
                }
            },
            {
                "kind": "command",
                "id": "capture-screenshot",
                "value": {
                    "surface": "desktop.commands",
                    "label": {
                        "fallback": "系统截图"
                    },
                    "handlerId": "desktop.capture-screenshot",
                    "slot": "capture",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 30
                }
            },
            {
                "kind": "hotkey",
                "id": "capture-screenshot-hotkey",
                "value": {
                    "surface": "desktop.hotkeys",
                    "label": {
                        "fallback": "系统截图"
                    },
                    "commandId": "capture-screenshot",
                    "defaultBinding": "Ctrl+Shift+S",
                    "slot": "capture",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 30
                }
            },
            {
                "kind": "command",
                "id": "system-selection",
                "value": {
                    "surface": "desktop.lifecycle",
                    "label": {
                        "fallback": "系统选中文本"
                    },
                    "handlerId": "desktop.system-selection",
                    "slot": "selection",
                    "hosts": [
                        "desktop"
                    ],
                    "requiredCapabilities": [
                        "desktop.lifecycle"
                    ],
                    "order": 35
                }
            },
            {
                "kind": "command",
                "id": "pin-clipboard-image",
                "value": {
                    "surface": "desktop.commands",
                    "label": {
                        "fallback": "贴出剪贴板图片"
                    },
                    "handlerId": "desktop.pin-clipboard-image",
                    "slot": "capture",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "hotkey",
                "id": "pin-clipboard-image-hotkey",
                "value": {
                    "surface": "desktop.hotkeys",
                    "label": {
                        "fallback": "贴出剪贴板图片"
                    },
                    "commandId": "pin-clipboard-image",
                    "defaultBinding": "Ctrl+Alt+V",
                    "slot": "capture",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 40
                }
            },
            {
                "kind": "tray-menu",
                "id": "open-webgui-menu",
                "value": {
                    "surface": "desktop.tray",
                    "label": {
                        "fallback": "打开 WebGUI"
                    },
                    "commandId": "open-webgui",
                    "slot": "system",
                    "hosts": [
                        "desktop"
                    ],
                    "order": 10
                }
            },
            {
                "kind": "tray-menu",
                "id": "open-settings-menu",
                "value": {
                    "surface": "desktop.tray",
                    "label": {
                        "fallback": "打开设置"
                    },
                    "commandId": "open-settings",
                    "slot": "system",
                    "hosts": [
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
        const operations = runtime.createDesktopControlOperations({
            settings: runtime.desktopSettings,
            readOnly: runtime.managerReadOnly,
            settingsChanged: settings => runtime.publishManagerEvent("desktop_settings_changed", { webTheme: settings.webTheme }),
            openConfigFilePayload: (type, gatewayId, roleId) => runtime.desktopConfigFilePayload(type, gatewayId, roleId, {
                routeRoot: runtime.routeRoot,
                rolesRoot: runtime.rolesRoot,
                ensureDataDirs: runtime.ensureDataDirs,
                findRoute: gatewayId => runtime.runtimes.get(gatewayId)?.definition,
                ensurePersonaConfigFile: runtime.ensurePersonaConfigFile,
                ensureRoleFile: runtime.ensureRoleFile,
                ensureRoleFolder: runtime.ensureRoleFolder,
                adapterConfigPath: runtime.adapterConfigPath,
                writeAdapterConfigFile: route => runtime.writeAdapterConfigFile(route)
            })
        });
        ctx.effect(async () => {
            const registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, operations, context.lifecycle.signal);
            return () => registration.dispose();
        }, "activate Manager desktop plugin");

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.desktop");
    }
}).activate;
