import { rabiRoutePackageVersion } from "../packageInfo.js";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import type { RabiUiContribution } from "../runtime/contributionRegistry.js";

function plugin(
  id: string,
  name: string,
  contributions: readonly RabiUiContribution[]
): ManagerPluginDefinition {
  return {
    instanceId: `manager:${id}`,
    manifest: {
      id: `builtin:manager/${id}`,
      name,
      version: rabiRoutePackageVersion(),
      kind: "builtin",
      hosts: ["manager", "web", "desktop"],
      capabilities: ["manager.plugin-catalog", "manager.contributions"]
    },
    scope: "global",
    contributions
  };
}

export function builtinManagerPluginDefinitions(): ManagerPluginDefinition[] {
  return [
    plugin("core", "RabiRoute Manager Core", [
      {
        kind: "page",
        surface: "web.pages",
        id: "overview-page",
        label: { fallback: "控制台" },
        routeId: "route.overview",
        rendererId: "builtin.web-page.overview.v1",
        slot: "route",
        hosts: ["web"],
        order: 10
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "overview",
        label: { fallback: "控制台" },
        routeId: "route.overview",
        icon: "mdi-view-dashboard-outline",
        slot: "route-primary",
        hosts: ["web"],
        order: 10
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "message-adapters-page",
        label: { fallback: "消息适配器" },
        routeId: "route.adapters",
        rendererId: "builtin.web-page.adapters.v1",
        slot: "route",
        hosts: ["web"],
        order: 20
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "message-adapters",
        label: { fallback: "消息适配器" },
        routeId: "route.adapters",
        icon: "mdi-puzzle-outline",
        slot: "route-primary",
        hosts: ["web"],
        order: 20
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "runtime-page",
        label: { fallback: "日志诊断" },
        routeId: "route.runtime",
        rendererId: "builtin.web-page.runtime.v1",
        slot: "route",
        hosts: ["web"],
        order: 70
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "runtime",
        label: { fallback: "日志诊断" },
        routeId: "route.runtime",
        icon: "mdi-console-line",
        slot: "utility",
        hosts: ["web"],
        order: 70
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "settings-page",
        label: { fallback: "设置" },
        routeId: "global.settings",
        rendererId: "builtin.web-page.settings.v1",
        slot: "global",
        hosts: ["web"],
        order: 80
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "settings",
        label: { fallback: "设置" },
        routeId: "global.settings",
        icon: "mdi-cog-outline",
        slot: "utility",
        hosts: ["web"],
        order: 80
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "docs-page",
        label: { fallback: "使用手册" },
        routeId: "global.docs",
        rendererId: "builtin.web-page.docs.v1",
        slot: "global",
        hosts: ["web"],
        order: 90
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "docs",
        label: { fallback: "使用手册" },
        routeId: "global.docs",
        icon: "mdi-book-open-page-variant-outline",
        slot: "footer",
        hosts: ["web"],
        order: 90
      },
      {
        kind: "theme",
        surface: "shared.themes",
        id: "system-theme",
        label: { fallback: "跟随系统" },
        themeId: "system",
        webResourceId: "builtin.web-theme.system.v1",
        desktopResourceId: "builtin.desktop-theme.system.v1",
        slot: "interface",
        hosts: ["web", "desktop"],
        order: 10
      },
      {
        kind: "theme",
        surface: "shared.themes",
        id: "light-theme",
        label: { fallback: "浅色" },
        themeId: "light",
        webResourceId: "builtin.web-theme.light.v1",
        desktopResourceId: "builtin.desktop-theme.light.v1",
        slot: "interface",
        hosts: ["web", "desktop"],
        order: 20
      },
      {
        kind: "theme",
        surface: "shared.themes",
        id: "dark-theme",
        label: { fallback: "深色" },
        themeId: "dark",
        webResourceId: "builtin.web-theme.dark.v1",
        desktopResourceId: "builtin.desktop-theme.dark.v1",
        slot: "interface",
        hosts: ["web", "desktop"],
        order: 30
      }
    ]),
    plugin("persona", "Rabi Persona Management", [
      {
        kind: "page",
        surface: "web.pages",
        id: "persona-page",
        label: { fallback: "人格配置" },
        routeId: "route.persona",
        rendererId: "builtin.web-page.persona.v1",
        slot: "route",
        hosts: ["web"],
        order: 30
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "persona",
        label: { fallback: "人格配置" },
        routeId: "route.persona",
        icon: "mdi-account-heart-outline",
        slot: "route-primary",
        hosts: ["web"],
        order: 30
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "knowledge-page",
        label: { fallback: "计划与记忆" },
        routeId: "route.knowledge",
        rendererId: "builtin.web-page.knowledge.v1",
        slot: "route",
        hosts: ["web"],
        order: 40
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "knowledge",
        label: { fallback: "计划与记忆" },
        routeId: "route.knowledge",
        icon: "mdi-notebook-check-outline",
        slot: "route-primary",
        hosts: ["web"],
        order: 40
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "persona-sync-page",
        label: { fallback: "多电脑人格同步" },
        routeId: "route.persona-sync",
        rendererId: "builtin.web-page.persona-sync.v1",
        slot: "route",
        hosts: ["web"],
        order: 45
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "persona-sync",
        label: { fallback: "多电脑人格同步" },
        routeId: "route.persona-sync",
        icon: "mdi-folder-sync-outline",
        slot: "persona-secondary",
        hosts: ["web"],
        order: 45
      },
      {
        kind: "page",
        surface: "web.pages",
        id: "persona-document-page",
        label: { fallback: "人格正文" },
        routeId: "route.persona-document",
        rendererId: "builtin.web-page.persona-document.v1",
        slot: "route",
        hosts: ["web"],
        order: 46
      }
    ]),
    plugin("speech", "RabiSpeech Manager", [
      {
        kind: "page",
        surface: "web.pages",
        id: "speech-page",
        label: { fallback: "语音服务" },
        routeId: "route.speech",
        rendererId: "builtin.web-page.speech.v1",
        slot: "route",
        hosts: ["web"],
        order: 50
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "speech",
        label: { fallback: "语音服务" },
        routeId: "route.speech",
        icon: "mdi-waveform",
        slot: "utility",
        hosts: ["web"],
        order: 50
      },
      {
        kind: "status-card",
        surface: "shared.status",
        id: "speech-status",
        label: { fallback: "语音服务" },
        queryId: "manager.speech-status",
        rendererId: "builtin.speech-status.v1",
        icon: "mdi-waveform",
        slot: "runtime-status",
        hosts: ["web", "desktop"],
        order: 20
      }
    ]),
    plugin("performance", "Performance Monitoring", [
      {
        kind: "page",
        surface: "web.pages",
        id: "performance-page",
        label: { fallback: "性能监控" },
        routeId: "global.performance",
        rendererId: "builtin.web-page.performance.v1",
        slot: "global",
        hosts: ["web"],
        order: 60
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "performance",
        label: { fallback: "性能监控" },
        routeId: "global.performance",
        icon: "mdi-chart-timeline-variant",
        slot: "utility",
        hosts: ["web"],
        order: 60
      },
      {
        kind: "status-card",
        surface: "shared.status",
        id: "performance-status",
        label: { fallback: "性能监控" },
        queryId: "manager.performance-status",
        rendererId: "builtin.performance-status.v1",
        icon: "mdi-chart-timeline-variant",
        slot: "runtime-status",
        hosts: ["web", "desktop"],
        order: 30
      }
    ]),
    plugin("desktop", "RabiRoute Desktop", [
      {
        kind: "settings-section",
        surface: "shared.settings",
        id: "desktop-settings",
        label: { fallback: "桌面功能" },
        rendererId: "builtin.desktop-settings.v1",
        schemaId: "desktop.settings.v1",
        readCommandId: "manager.desktop-settings.read",
        writeCommandId: "manager.desktop-settings.write",
        icon: "mdi-monitor-dashboard",
        slot: "desktop",
        hosts: ["web", "desktop"],
        order: 40
      },
      {
        kind: "command",
        surface: "desktop.commands",
        id: "open-webgui",
        label: { fallback: "打开 WebGUI" },
        handlerId: "desktop.open-webgui",
        slot: "system",
        hosts: ["desktop"],
        order: 10
      },
      {
        kind: "command",
        surface: "desktop.commands",
        id: "open-settings",
        label: { fallback: "打开设置" },
        handlerId: "desktop.open-settings",
        slot: "system",
        hosts: ["desktop"],
        order: 20
      },
      {
        kind: "command",
        surface: "desktop.commands",
        id: "capture-screenshot",
        label: { fallback: "系统截图" },
        handlerId: "desktop.capture-screenshot",
        slot: "capture",
        hosts: ["desktop"],
        order: 30
      },
      {
        kind: "hotkey",
        surface: "desktop.hotkeys",
        id: "capture-screenshot-hotkey",
        label: { fallback: "系统截图" },
        commandId: "capture-screenshot",
        defaultBinding: "Ctrl+Shift+S",
        slot: "capture",
        hosts: ["desktop"],
        order: 30
      },
      {
        kind: "command",
        surface: "desktop.commands",
        id: "pin-clipboard-image",
        label: { fallback: "贴出剪贴板图片" },
        handlerId: "desktop.pin-clipboard-image",
        slot: "capture",
        hosts: ["desktop"],
        order: 40
      },
      {
        kind: "hotkey",
        surface: "desktop.hotkeys",
        id: "pin-clipboard-image-hotkey",
        label: { fallback: "贴出剪贴板图片" },
        commandId: "pin-clipboard-image",
        defaultBinding: "F3",
        slot: "capture",
        hosts: ["desktop"],
        order: 40
      },
      {
        kind: "tray-menu",
        surface: "desktop.tray",
        id: "open-webgui-menu",
        label: { fallback: "打开 WebGUI" },
        commandId: "open-webgui",
        slot: "system",
        hosts: ["desktop"],
        order: 10
      },
      {
        kind: "tray-menu",
        surface: "desktop.tray",
        id: "open-settings-menu",
        label: { fallback: "打开设置" },
        commandId: "open-settings",
        slot: "system",
        hosts: ["desktop"],
        order: 20
      }
    ])
  ];
}
