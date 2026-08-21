import { rabiRoutePackageVersion } from "../packageInfo.js";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import type { RabiUiContribution } from "../runtime/contributionRegistry.js";
import { MESSAGE_ADAPTER_CONTROL_CONTRIBUTIONS } from "./messageAdapterControl.js";


type ManagerPluginDependencyContract = {
  requires?: readonly string[];
  optional?: readonly string[];
};

const MANAGER_PLUGIN_DEPENDENCIES: Readonly<Record<string, ManagerPluginDependencyContract>> = {
  "bilibili-history": { requires: ["manager.core", "manager.persona"] },
  "route-control": { requires: ["manager.core", "manager.gateway-runtime"] },
  "message-adapter-control": { requires: ["manager.core", "manager.gateway-runtime"] },
  "agent-state-control": { requires: ["manager.core", "manager.gateway-runtime"] },
  "agent-thread-control": { requires: ["manager.core", "manager.agent-adapter-catalog"] },
  "agent-communication": { requires: ["manager.core", "manager.agent-adapter-catalog"] },
  "rabilink-relay": { requires: ["manager.core", "manager.persona"] },
  "memory-consolidation": { requires: ["manager.core", "manager.persona"] },
  "message-processing-automation": { requires: ["manager.core", "manager.message-processing-control"] },
  "plan-feedback-delivery": { requires: ["manager.core", "manager.message-processing-control"] },
  "napcat-supervisor": { requires: ["manager.core", "manager.napcat-control"] },
  diagnostics: {
    requires: ["manager.core"],
    optional: [
      "manager.gateway-runtime",
      "manager.performance",
      "manager.message-processing-control"
    ]
  }
};

const DIAGNOSTICS_CONTRIBUTIONS: readonly RabiUiContribution[] = [
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
  }
];

function plugin(
  id: string,
  name: string,
  contributions: readonly RabiUiContribution[]
): ManagerPluginDefinition {
  const contributionHosts = new Set(contributions.flatMap(contribution => contribution.hosts));
  const provides = [`manager.${id}`];
  const dependency = MANAGER_PLUGIN_DEPENDENCIES[id];
  const requires = id === "core"
    ? []
    : [...new Set(dependency?.requires ?? ["manager.core"])];
  const optional = [...new Set(dependency?.optional ?? [])];
  return {
    instanceId: `manager:${id}`,
    manifest: {
      id: `builtin:manager/${id}`,
      name,
      version: rabiRoutePackageVersion(),
      kind: "builtin",
      hosts: [
        "manager",
        ...(contributionHosts.has("web") ? ["web" as const] : []),
        ...(contributionHosts.has("desktop") ? ["desktop" as const] : [])
      ],
      capabilities: [
        ...provides,
        ...(contributions.length ? ["manager.contributions"] : [])
      ]
    },
    scope: "global",
    provides,
    requires,
    optional,
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
        kind: "command",
        surface: "web.commands",
        id: "save-page",
        label: { fallback: "保存" },
        handlerId: "web.save-page",
        requiredCapabilities: ["web.command"],
        icon: "mdi-content-save",
        slot: "topbar-primary",
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
      },
      {
        kind: "command",
        surface: "desktop.panel",
        id: "open-role-directory",
        label: { fallback: "人格目录" },
        handlerId: "desktop.open-role-directory",
        slot: "persona",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 10
      },
      {
        kind: "command",
        surface: "desktop.panel",
        id: "open-plan-directory",
        label: { fallback: "计划目录" },
        handlerId: "desktop.open-plan-directory",
        slot: "persona",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 20
      },
      {
        kind: "command",
        surface: "desktop.panel",
        id: "open-memory-directory",
        label: { fallback: "记忆目录" },
        handlerId: "desktop.open-memory-directory",
        slot: "persona",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 30
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
        surface: "desktop.lifecycle",
        id: "system-selection",
        label: { fallback: "系统选中文本" },
        handlerId: "desktop.system-selection",
        slot: "selection",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.lifecycle"],
        order: 35
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
    ]),
    plugin("gateway-runtime", "RabiRoute Gateway Runtime", [
      {
        kind: "command",
        surface: "desktop.panel",
        id: "open-runtime-directory",
        label: { fallback: "状态目录" },
        handlerId: "desktop.open-runtime-directory",
        slot: "runtime",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 40
      },
      {
        kind: "command",
        surface: "desktop.panel",
        id: "manual-trigger",
        label: { fallback: "手动触发" },
        handlerId: "desktop.manual-trigger",
        slot: "runtime",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 60
      }
    ]),
    plugin("bilibili-history", "Bilibili History", []),
    plugin("route-control", "Route Control", [
      {
        kind: "command",
        surface: "web.commands",
        id: "quick-setup",
        label: { fallback: "快速配置" },
        handlerId: "web.quick-setup",
        requiredCapabilities: ["web.command"],
        icon: "mdi-lightning-bolt-outline",
        slot: "sidebar-footer-primary",
        hosts: ["web"],
        order: 10
      },
      {
        kind: "command",
        surface: "web.commands",
        id: "add-route",
        label: { fallback: "新增航线" },
        handlerId: "web.add-route",
        requiredCapabilities: ["web.command"],
        icon: "mdi-plus",
        slot: "topbar-primary",
        hosts: ["web"],
        order: 20
      },
      {
        kind: "command",
        surface: "web.commands",
        id: "open-manager-config",
        label: { fallback: "打开配置目录" },
        handlerId: "web.open-manager-config",
        requiredCapabilities: ["web.command"],
        icon: "mdi-folder-cog-outline",
        slot: "sidebar-footer",
        hosts: ["web"],
        order: 30
      },
      {
        kind: "command",
        surface: "desktop.panel",
        id: "open-project-directory",
        label: { fallback: "项目目录" },
        handlerId: "desktop.open-project-directory",
        slot: "route",
        hosts: ["desktop"],
        requiredCapabilities: ["desktop.panel-action"],
        order: 35
      }
    ]),
    plugin("message-adapter-control", "Message Adapter Control", MESSAGE_ADAPTER_CONTROL_CONTRIBUTIONS),
    plugin("agent-adapter-catalog", "Agent Adapter Catalog", []),
    plugin("agent-state-control", "Agent State Control", []),
    plugin("agent-thread-control", "Agent Thread Control", []),
    plugin("agent-communication", "Agent Communication", []),
    plugin("copilot-control", "GitHub Copilot Control", []),
    plugin("astrbot-control", "AstrBot Control", []),
    plugin("marvis-control", "Marvis Control", []),
    plugin("remote-agent", "Remote Agent", []),
    plugin("diagnostics", "Manager Diagnostics", DIAGNOSTICS_CONTRIBUTIONS),
    plugin("rabilink-relay", "RabiLink Relay", []),
    plugin("memory-consolidation", "Memory Consolidation", []),
    plugin("fennenote-output", "FenneNote Output", []),
    plugin("message-processing-control", "Message Processing Control", []),
    plugin("message-processing-automation", "Message Processing Automation", []),
    plugin("plan-feedback-delivery", "Plan Feedback Delivery", []),
    plugin("napcat-control", "NapCat Control", []),
    plugin("napcat-supervisor", "NapCat Supervisor", [])
  ];
}
