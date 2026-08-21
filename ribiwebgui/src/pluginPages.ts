import { ref, type AsyncComponentLoader } from "vue";
import {
  routeScopedAdaptersPath,
  routeScopedKnowledgePath,
  routeScopedOverviewPath,
  routeScopedPersonaPath,
  routeScopedPersonaSyncPath,
  routeScopedRuntimePath,
  routeScopedSpeechPath
} from "./routeScopedNavigation";

export type WebPageRouteId = string;
export type WebPageRendererId = string;

export type WebPagePathRegistration = Readonly<{
  path: string;
  title: string;
}>;

export type WebPageNavigationRegistration = Readonly<{
  resolvePath: (selectedRouteId: string) => string;
  allowedSlots: readonly string[];
  allowedIcons: readonly string[];
}>;

export type TrustedWebPageRegistration = Readonly<{
  routeId: WebPageRouteId;
  rendererId: WebPageRendererId;
  loader: AsyncComponentLoader;
  paths: readonly WebPagePathRegistration[];
  navigation?: WebPageNavigationRegistration;
}>;

export type WebPageContribution = Readonly<{
  instanceId: string;
  pluginId: string;
  routeId: WebPageRouteId;
  rendererId: WebPageRendererId;
}>;

export type WebPageCatalogMode = "loading" | "recovery" | "catalog";

export type WebPageCatalogState = Readonly<{
  mode: WebPageCatalogMode;
  pages: readonly WebPageContribution[];
}>;

export type TrustedWebPageRegistrationChange = Readonly<{
  type: "registered" | "unregistered";
  registration: TrustedWebPageRegistration;
}>;

type JsonRecord = Record<string, unknown>;
type RegistrationListener = (change: TrustedWebPageRegistrationChange) => void;

const webPageRendererRegistry = new Map<WebPageRouteId, TrustedWebPageRegistration>();
const webPageRendererIds = new Map<WebPageRendererId, WebPageRouteId>();
const webPageRoutePaths = new Map<string, WebPageRouteId>();
const registrationListeners = new Set<RegistrationListener>();
const webPageRegistrationRevision = ref(0);
const reservedRoutePaths = new Set(["/", "/plugin-recovery", "/models", "/:pathMatch(.*)*"]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledSymbol(value: unknown, field: string, maximumLength = 160): string {
  if (typeof value !== "string") throw new Error(`Trusted Web page ${field} is invalid.`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized !== value
    || normalized.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
  ) {
    throw new Error(`Trusted Web page ${field} is invalid.`);
  }
  return normalized;
}

function controlledText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`Trusted Web page ${field} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Trusted Web page ${field} is invalid.`);
  }
  return normalized;
}

function controlledRoutePath(value: unknown, field: string): string {
  const path = controlledText(value, field, 240);
  if (!path.startsWith("/") || path.startsWith("//") || reservedRoutePaths.has(path)) {
    throw new Error(`Trusted Web page ${field} is invalid.`);
  }
  return path;
}

function controlledResolvedPath(value: unknown, routeId: string): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (
    !path
    || path !== value
    || path.length > 2_048
    || !path.startsWith("/")
    || path.startsWith("//")
    || /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`Trusted Web page path resolver returned an invalid path: ${routeId}`);
  }
  return path;
}

function controlledSymbols(values: readonly string[] | undefined, field: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`Trusted Web page ${field} is invalid.`);
  const symbols = values.map((value, index) => controlledSymbol(value, `${field}[${index}]`, 80));
  if (new Set(symbols).size !== symbols.length) throw new Error(`Trusted Web page ${field} is invalid.`);
  return Object.freeze(symbols);
}

function normalizeRegistration(input: TrustedWebPageRegistration): TrustedWebPageRegistration {
  if (typeof input.loader !== "function") throw new Error("Trusted Web page loader is invalid.");
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error("Trusted Web page paths are invalid.");
  }

  const routeId = controlledSymbol(input.routeId, "routeId");
  const rendererId = controlledSymbol(input.rendererId, "rendererId");
  const paths = input.paths.map((entry, index) => Object.freeze({
    path: controlledRoutePath(entry?.path, `paths[${index}].path`),
    title: controlledText(entry?.title, `paths[${index}].title`, 120)
  }));
  if (new Set(paths.map(entry => entry.path)).size !== paths.length) {
    throw new Error(`Trusted Web page paths contain duplicates: ${routeId}`);
  }

  const navigation = input.navigation
    ? Object.freeze({
        resolvePath: input.navigation.resolvePath,
        allowedSlots: controlledSymbols(input.navigation.allowedSlots, "navigation.allowedSlots"),
        allowedIcons: controlledSymbols(input.navigation.allowedIcons, "navigation.allowedIcons")
      })
    : undefined;
  if (navigation && typeof navigation.resolvePath !== "function") {
    throw new Error("Trusted Web page navigation resolver is invalid.");
  }

  const registration = {
    routeId,
    rendererId,
    loader: input.loader,
    paths: Object.freeze(paths)
  };
  return navigation
    ? Object.freeze({ ...registration, navigation })
    : Object.freeze(registration);
}

function publishRegistrationChange(change: TrustedWebPageRegistrationChange): void {
  let firstError: unknown;
  for (const listener of [...registrationListeners]) {
    try {
      listener(change);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

export function registerTrustedWebPage(input: TrustedWebPageRegistration): () => void {
  const registration = normalizeRegistration(input);
  if (webPageRendererRegistry.has(registration.routeId)) {
    throw new Error(`Trusted Web page route is already registered: ${registration.routeId}`);
  }
  if (webPageRendererIds.has(registration.rendererId)) {
    throw new Error(`Trusted Web page renderer is already registered: ${registration.rendererId}`);
  }
  for (const entry of registration.paths) {
    const owner = webPageRoutePaths.get(entry.path);
    if (owner) throw new Error(`Trusted Web page path is already registered by ${owner}: ${entry.path}`);
  }

  webPageRendererRegistry.set(registration.routeId, registration);
  webPageRendererIds.set(registration.rendererId, registration.routeId);
  for (const entry of registration.paths) webPageRoutePaths.set(entry.path, registration.routeId);
  webPageRegistrationRevision.value += 1;
  try {
    publishRegistrationChange({ type: "registered", registration });
  } catch (error) {
    webPageRendererRegistry.delete(registration.routeId);
    webPageRendererIds.delete(registration.rendererId);
    for (const entry of registration.paths) webPageRoutePaths.delete(entry.path);
    webPageRegistrationRevision.value += 1;
    try {
      publishRegistrationChange({ type: "unregistered", registration });
    } catch {
      // Preserve the original registration failure after every listener had a cleanup opportunity.
    }
    throw error;
  }

  let active = true;
  return () => {
    if (!active || webPageRendererRegistry.get(registration.routeId) !== registration) return;
    active = false;
    webPageRendererRegistry.delete(registration.routeId);
    webPageRendererIds.delete(registration.rendererId);
    for (const entry of registration.paths) webPageRoutePaths.delete(entry.path);
    webPageRegistrationRevision.value += 1;
    publishRegistrationChange({ type: "unregistered", registration });
  };
}

export function registeredWebPages(): readonly TrustedWebPageRegistration[] {
  return Object.freeze([...webPageRendererRegistry.values()]);
}

export function onTrustedWebPageRegistrationChange(listener: RegistrationListener): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function webPageRenderer(routeId: WebPageRouteId): TrustedWebPageRegistration {
  const renderer = webPageRendererRegistry.get(routeId);
  if (!renderer) throw new Error(`Web page route is not registered: ${routeId}`);
  return renderer;
}

export function resolveRegisteredWebPagePath(routeId: WebPageRouteId, selectedRouteId: string): string {
  const registration = webPageRendererRegistry.get(routeId);
  if (!registration?.navigation) return "";
  return controlledResolvedPath(registration.navigation.resolvePath(selectedRouteId), routeId);
}

export function webPageAllowsNavigation(
  routeId: WebPageRouteId,
  slot: string,
  icon: string
): boolean {
  const navigation = webPageRendererRegistry.get(routeId)?.navigation;
  return !!navigation
    && navigation.allowedSlots.includes(slot)
    && navigation.allowedIcons.includes(icon);
}

function webHosted(value: JsonRecord): boolean {
  return Array.isArray(value.hosts)
    && value.hosts.every(host => typeof host === "string")
    && value.hosts.includes("web");
}

export function parseWebPageContribution(value: unknown): WebPageContribution | undefined {
  if (!isRecord(value) || value.kind !== "page" || !webHosted(value)) return undefined;
  let instanceId = "";
  let pluginId = "";
  let routeId = "";
  let rendererId = "";
  try {
    instanceId = controlledSymbol(value.instanceId, "contribution.instanceId");
    pluginId = controlledSymbol(value.pluginId, "contribution.pluginId");
    routeId = controlledSymbol(value.routeId, "contribution.routeId");
    rendererId = controlledSymbol(value.rendererId, "contribution.rendererId");
  } catch {
    return undefined;
  }
  const registered = webPageRendererRegistry.get(routeId);
  if (!registered || registered.rendererId !== rendererId) return undefined;
  return { instanceId, pluginId, routeId, rendererId };
}

export function resolveWebPageCatalog(
  contributions: readonly unknown[] | null,
  status: "idle" | "loading" | "ready" | "unavailable"
): WebPageCatalogState {
  void webPageRegistrationRevision.value;
  if (contributions === null) {
    return { mode: status === "unavailable" ? "recovery" : "loading", pages: [] };
  }
  return {
    mode: "catalog",
    pages: contributions.flatMap(value => {
      const page = parseWebPageContribution(value);
      return page ? [page] : [];
    })
  };
}

export function isWebPageRouteActive(
  catalog: WebPageCatalogState,
  routeId: WebPageRouteId
): boolean {
  return catalog.mode === "catalog" && catalog.pages.some(page => page.routeId === routeId);
}

export function isWebNavigationPageActive(
  catalog: WebPageCatalogState,
  instanceId: string,
  routeId: WebPageRouteId
): boolean {
  return catalog.mode === "catalog"
    && catalog.pages.some(page => page.instanceId === instanceId && page.routeId === routeId);
}

const builtinWebPages: readonly TrustedWebPageRegistration[] = [
  {
    routeId: "route.overview",
    rendererId: "builtin.web-page.overview.v1",
    loader: () => import("./pages/OverviewPage.vue"),
    paths: [
      { path: "/overview", title: "控制台" },
      { path: "/routes/:id/overview", title: "控制台" }
    ],
    navigation: {
      resolvePath: routeScopedOverviewPath,
      allowedSlots: ["route-primary"],
      allowedIcons: ["mdi-view-dashboard-outline"]
    }
  },
  {
    routeId: "route.adapters",
    rendererId: "builtin.web-page.adapters.v1",
    loader: () => import("./pages/RouteConfigPage.vue"),
    paths: [
      { path: "/routes/:id/adapters", title: "消息适配器" },
      { path: "/routes/:id?", title: "消息适配器" }
    ],
    navigation: {
      resolvePath: routeScopedAdaptersPath,
      allowedSlots: ["route-primary"],
      allowedIcons: ["mdi-puzzle-outline"]
    }
  },
  {
    routeId: "route.persona",
    rendererId: "builtin.web-page.persona.v1",
    loader: () => import("./pages/PersonaTemplatePage.vue"),
    paths: [
      { path: "/routes/:id/persona", title: "人格配置" },
      { path: "/persona/:id?", title: "人格配置" }
    ],
    navigation: {
      resolvePath: routeScopedPersonaPath,
      allowedSlots: ["route-primary"],
      allowedIcons: ["mdi-account-heart-outline"]
    }
  },
  {
    routeId: "route.persona-document",
    rendererId: "builtin.web-page.persona-document.v1",
    loader: () => import("./pages/PersonaDocumentPage.vue"),
    paths: [{ path: "/routes/:id/persona/document", title: "人格正文" }]
  },
  {
    routeId: "route.knowledge",
    rendererId: "builtin.web-page.knowledge.v1",
    loader: () => import("./pages/RoleKnowledgePage.vue"),
    paths: [
      { path: "/routes/:id/knowledge", title: "计划与记忆" },
      { path: "/knowledge", title: "计划与记忆" }
    ],
    navigation: {
      resolvePath: routeScopedKnowledgePath,
      allowedSlots: ["route-primary"],
      allowedIcons: ["mdi-notebook-check-outline"]
    }
  },
  {
    routeId: "route.persona-sync",
    rendererId: "builtin.web-page.persona-sync.v1",
    loader: () => import("./pages/PersonaSyncPage.vue"),
    paths: [{ path: "/routes/:id/persona/sync", title: "多电脑人格同步" }],
    navigation: {
      resolvePath: routeScopedPersonaSyncPath,
      allowedSlots: ["persona-secondary"],
      allowedIcons: ["mdi-folder-sync-outline"]
    }
  },
  {
    routeId: "route.speech",
    rendererId: "builtin.web-page.speech.v1",
    loader: () => import("./pages/SpeechServicePage.vue"),
    paths: [
      { path: "/speech", title: "语音服务" },
      { path: "/routes/:id/speech", title: "语音服务" }
    ],
    navigation: {
      resolvePath: routeScopedSpeechPath,
      allowedSlots: ["utility"],
      allowedIcons: ["mdi-waveform"]
    }
  },
  {
    routeId: "global.performance",
    rendererId: "builtin.web-page.performance.v1",
    loader: () => import("./pages/PerformancePage.vue"),
    paths: [{ path: "/performance", title: "性能监控" }],
    navigation: {
      resolvePath: () => "/performance",
      allowedSlots: ["utility"],
      allowedIcons: ["mdi-chart-timeline-variant"]
    }
  },
  {
    routeId: "route.runtime",
    rendererId: "builtin.web-page.runtime.v1",
    loader: () => import("./pages/RuntimeLogPage.vue"),
    paths: [
      { path: "/routes/:id/runtime", title: "日志诊断" },
      { path: "/runtime", title: "日志诊断" }
    ],
    navigation: {
      resolvePath: routeScopedRuntimePath,
      allowedSlots: ["utility"],
      allowedIcons: ["mdi-console-line"]
    }
  },
  {
    routeId: "global.settings",
    rendererId: "builtin.web-page.settings.v1",
    loader: () => import("./pages/SettingsPage.vue"),
    paths: [{ path: "/settings", title: "设置" }],
    navigation: {
      resolvePath: () => "/settings",
      allowedSlots: ["utility"],
      allowedIcons: ["mdi-cog-outline"]
    }
  },
  {
    routeId: "global.docs",
    rendererId: "builtin.web-page.docs.v1",
    loader: () => import("./pages/ProjectDocsPage.vue"),
    paths: [{ path: "/docs", title: "使用手册" }],
    navigation: {
      resolvePath: () => "/docs",
      allowedSlots: ["footer"],
      allowedIcons: ["mdi-book-open-page-variant-outline"]
    }
  }
];

for (const registration of builtinWebPages) registerTrustedWebPage(registration);
