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
        target: "/routes/:id/overview",
        icon: "mdi-view-dashboard-outline",
        slot: "route-primary",
        routeScoped: true,
        hosts: ["web"],
        order: 10
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "message-adapters",
        label: { fallback: "消息适配器" },
        target: "/routes/:id/adapters",
        icon: "mdi-puzzle-outline",
        slot: "route-primary",
        routeScoped: true,
        hosts: ["web"],
        order: 20
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "runtime",
        label: { fallback: "日志诊断" },
        target: "/routes/:id/runtime",
        icon: "mdi-console-line",
        slot: "utility",
        routeScoped: true,
        hosts: ["web"],
        order: 70
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "settings",
        label: { fallback: "设置" },
        target: "/settings",
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
        target: "/docs",
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
        target: "/routes/:id/persona",
        icon: "mdi-account-heart-outline",
        slot: "route-primary",
        routeScoped: true,
        hosts: ["web"],
        order: 30
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "knowledge",
        label: { fallback: "计划与记忆" },
        target: "/routes/:id/knowledge",
        icon: "mdi-notebook-check-outline",
        slot: "route-primary",
        routeScoped: true,
        hosts: ["web"],
        order: 40
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "persona-sync",
        label: { fallback: "多电脑人格同步" },
        target: "/routes/:id/persona/sync",
        icon: "mdi-folder-sync-outline",
        slot: "persona-secondary",
        routeScoped: true,
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
        target: "/routes/:id/speech",
        icon: "mdi-waveform",
        slot: "utility",
        routeScoped: true,
        hosts: ["web"],
        order: 50
      },
      {
        kind: "status-card",
        surface: "shared.status",
        id: "speech-status",
        label: { fallback: "语音服务" },
        query: "/api/speech/status",
        renderer: "builtin:speech-status",
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
        target: "/performance",
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
        query: "/api/performance/status",
        renderer: "builtin:performance-status",
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
        schema: { "$ref": "rabi://schemas/desktop-settings/v1" },
        endpoint: "/api/desktop/settings",
        icon: "mdi-monitor-dashboard",
        slot: "desktop",
        hosts: ["web", "desktop"],
        order: 40
      }
    ])
  ];
}
