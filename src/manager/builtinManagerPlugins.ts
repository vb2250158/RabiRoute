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
        kind: "navigation",
        surface: "web.navigation",
        id: "docs",
        label: { fallback: "使用手册" },
        routeId: "global.docs",
        icon: "mdi-book-open-page-variant-outline",
        slot: "footer",
        hosts: ["web"],
        order: 90
      }
    ]),
    plugin("persona", "Rabi Persona Management", [
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
        kind: "navigation",
        surface: "web.navigation",
        id: "persona-sync",
        label: { fallback: "多电脑人格同步" },
        routeId: "route.persona-sync",
        icon: "mdi-folder-sync-outline",
        slot: "persona-secondary",
        hosts: ["web"],
        order: 45
      }
    ]),
    plugin("speech", "RabiSpeech Manager", [
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
