import type { Component } from "vue";
import type { TrustedWebPageRegistration } from "../pluginPages";
import type {
  TrustedWebSettingsRendererRegistration,
  TrustedWebStatusRendererRegistration
} from "../pluginRenderers";
import type { TrustedWebThemeResourceRegistration } from "../pluginThemes";
import {
  routeScopedAdaptersPath,
  routeScopedKnowledgePath,
  routeScopedOverviewPath,
  routeScopedPersonaPath,
  routeScopedPersonaSyncPath,
  routeScopedRuntimePath,
  routeScopedSpeechPath
} from "../routeScopedNavigation";

type BaseWebBundleApi = Readonly<{
  instanceId: string;
  pluginId: string;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

type BaseWebBundleModuleApi = Readonly<{
  instanceIds: readonly string[];
  forInstance(instanceId: string): BaseWebBundleApi;
}>;
type Dispose = () => void;
type PageInput = Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">;

function registerPage(api: BaseWebBundleApi, input: PageInput): Dispose {
  return api.registerPage(input);
}

function pages(api: BaseWebBundleApi, values: readonly PageInput[]): readonly Dispose[] {
  return values.map(value => registerPage(api, value));
}

function activateCore(api: BaseWebBundleApi): readonly Dispose[] {
  return [
    ...pages(api, [
      {
        routeId: "route.overview", rendererId: "builtin.web-page.overview.v1",
        loader: () => import("../pages/OverviewPage.vue"),
        paths: [{ path: "/overview", title: "控制台" }, { path: "/routes/:id/overview", title: "控制台" }],
        requirements: ["gateway.diagnostics"],
        navigation: { resolvePath: routeScopedOverviewPath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-view-dashboard-outline"] }
      },
      {
        routeId: "global.settings", rendererId: "builtin.web-page.settings.v1",
        loader: () => import("../pages/SettingsPage.vue"),
        paths: [{ path: "/settings", title: "设置" }],
        navigation: { resolvePath: () => "/settings", allowedSlots: ["utility"], allowedIcons: ["mdi-cog-outline"] }
      },
      {
        routeId: "global.docs", rendererId: "builtin.web-page.docs.v1",
        loader: () => import("../pages/ProjectDocsPage.vue"),
        paths: [{ path: "/docs", title: "使用手册" }],
        navigation: { resolvePath: () => "/docs", allowedSlots: ["footer"], allowedIcons: ["mdi-book-open-page-variant-outline"] }
      }
    ]),
    api.registerTheme({ themeId: "system", webResourceId: "builtin.web-theme.system.v1", label: "跟随系统", icon: "mdi-theme-light-dark", desktopTheme: "system", apply: systemDark => systemDark ? "dark" : "light" }),
    api.registerTheme({ themeId: "light", webResourceId: "builtin.web-theme.light.v1", label: "浅色", icon: "mdi-weather-sunny", desktopTheme: "light", apply: () => "light" }),
    api.registerTheme({ themeId: "dark", webResourceId: "builtin.web-theme.dark.v1", label: "深色", icon: "mdi-weather-night", desktopTheme: "dark", apply: () => "dark" })
  ];
}

function activateMessageAdapterControl(api: BaseWebBundleApi): readonly Dispose[] {
  return pages(api, [{
    routeId: "route.adapters", rendererId: "builtin.web-page.adapters.v1",
    loader: () => import("../pages/RouteConfigPage.vue"),
    paths: [{ path: "/routes/:id/adapters", title: "消息适配器" }, { path: "/routes/:id?", title: "消息适配器" }],
    requirements: ["gateway.diagnostics"],
    navigation: { resolvePath: routeScopedAdaptersPath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-puzzle-outline"] }
  }]);
}

function activatePersona(api: BaseWebBundleApi): readonly Dispose[] {
  return pages(api, [
    {
      routeId: "route.persona", rendererId: "builtin.web-page.persona.v1",
      loader: () => import("../pages/PersonaTemplatePage.vue"),
      paths: [{ path: "/routes/:id/persona", title: "人格配置" }, { path: "/persona/:id?", title: "人格配置" }],
      navigation: { resolvePath: routeScopedPersonaPath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-account-heart-outline"] }
    },
    { routeId: "route.persona-document", rendererId: "builtin.web-page.persona-document.v1", loader: () => import("../pages/PersonaDocumentPage.vue"), paths: [{ path: "/routes/:id/persona/document", title: "人格正文" }] },
    {
      routeId: "route.knowledge", rendererId: "builtin.web-page.knowledge.v1",
      loader: () => import("../pages/RoleKnowledgePage.vue"),
      paths: [{ path: "/routes/:id/knowledge", title: "计划与记忆" }, { path: "/knowledge", title: "计划与记忆" }],
      navigation: { resolvePath: routeScopedKnowledgePath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-notebook-check-outline"] }
    },
    {
      routeId: "route.persona-sync", rendererId: "builtin.web-page.persona-sync.v1",
      loader: () => import("../pages/PersonaSyncPage.vue"),
      paths: [{ path: "/routes/:id/persona/sync", title: "多电脑人格同步" }],
      navigation: { resolvePath: routeScopedPersonaSyncPath, allowedSlots: ["persona-secondary"], allowedIcons: ["mdi-folder-sync-outline"] }
    }
  ]);
}

function activateSpeech(api: BaseWebBundleApi): readonly Dispose[] {
  return [
    ...pages(api, [{
      routeId: "route.speech", rendererId: "builtin.web-page.speech.v1",
      loader: () => import("../pages/SpeechServicePage.vue"),
      paths: [{ path: "/speech", title: "语音服务" }, { path: "/routes/:id/speech", title: "语音服务" }],
      navigation: { resolvePath: routeScopedSpeechPath, allowedSlots: ["utility"], allowedIcons: ["mdi-waveform"] }
    }]),
    api.registerStatusRenderer({ rendererId: "builtin.speech-status.v1", placementId: "runtime-status", allowedSlots: ["runtime-status"], queryId: "manager.speech-status", loader: () => import("../components/renderers/SpeechStatusRenderer.vue") })
  ];
}

function activatePerformance(api: BaseWebBundleApi): readonly Dispose[] {
  return [
    ...pages(api, [{
      routeId: "global.performance", rendererId: "builtin.web-page.performance.v1",
      loader: () => import("../pages/PerformancePage.vue"), paths: [{ path: "/performance", title: "性能监控" }],
      navigation: { resolvePath: () => "/performance", allowedSlots: ["utility"], allowedIcons: ["mdi-chart-timeline-variant"] }
    }]),
    api.registerStatusRenderer({ rendererId: "builtin.performance-status.v1", placementId: "runtime-status", allowedSlots: ["runtime-status"], queryId: "manager.performance-status", loader: () => import("../components/renderers/PerformanceStatusRenderer.vue") })
  ];
}

function activateDiagnostics(api: BaseWebBundleApi): readonly Dispose[] {
  return pages(api, [{
    routeId: "route.runtime", rendererId: "builtin.web-page.runtime.v1",
    loader: () => import("../pages/RuntimeLogPage.vue"),
    paths: [{ path: "/routes/:id/runtime", title: "日志诊断" }, { path: "/runtime", title: "日志诊断" }],
    requirements: ["gateway.diagnostics"],
    navigation: { resolvePath: routeScopedRuntimePath, allowedSlots: ["utility"], allowedIcons: ["mdi-console-line"] }
  }]);
}

function activateDesktop(api: BaseWebBundleApi): readonly Dispose[] {
  return [api.registerSettingsRenderer({
    rendererId: "builtin.desktop-settings.v1", placementId: "desktop-settings", allowedSlots: ["desktop"],
    schemaId: "desktop.settings.v1", readCommandId: "manager.desktop-settings.read", writeCommandId: "manager.desktop-settings.write",
    loader: () => import("../components/renderers/DesktopSettingsRenderer.vue")
  })];
}

function activateInstance(api: BaseWebBundleApi): readonly Dispose[] {
  switch (api.instanceId) {
    case "manager:core": return activateCore(api);
    case "manager:message-adapter-control": return activateMessageAdapterControl(api);
    case "manager:persona": return activatePersona(api);
    case "manager:speech": return activateSpeech(api);
    case "manager:performance": return activatePerformance(api);
    case "manager:diagnostics": return activateDiagnostics(api);
    case "manager:desktop": return activateDesktop(api);
    default: return [];
  }
}

/** One Web Bundle activation owns all active Manager instances in the same Bundle revision. */
export function activate(api: BaseWebBundleModuleApi): Dispose {
  const disposers = api.instanceIds.flatMap(instanceId => activateInstance(api.forInstance(instanceId)));
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
