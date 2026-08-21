import type { AsyncComponentLoader } from "vue";

export type ControlledWebPageRouteId =
  | "route.overview"
  | "route.adapters"
  | "route.persona"
  | "route.persona-document"
  | "route.knowledge"
  | "route.persona-sync"
  | "route.speech"
  | "global.performance"
  | "route.runtime"
  | "global.settings"
  | "global.docs";

export type ControlledWebPageRendererId =
  | "builtin.web-page.overview.v1"
  | "builtin.web-page.adapters.v1"
  | "builtin.web-page.persona.v1"
  | "builtin.web-page.persona-document.v1"
  | "builtin.web-page.knowledge.v1"
  | "builtin.web-page.persona-sync.v1"
  | "builtin.web-page.speech.v1"
  | "builtin.web-page.performance.v1"
  | "builtin.web-page.runtime.v1"
  | "builtin.web-page.settings.v1"
  | "builtin.web-page.docs.v1";

export type WebPageContribution = Readonly<{
  instanceId: string;
  pluginId: string;
  routeId: ControlledWebPageRouteId;
  rendererId: ControlledWebPageRendererId;
}>;

export type WebPageCatalogMode = "loading" | "recovery" | "catalog";

export type WebPageCatalogState = Readonly<{
  mode: WebPageCatalogMode;
  pages: readonly WebPageContribution[];
}>;

type JsonRecord = Record<string, unknown>;

type WebPageRendererRegistration = Readonly<{
  rendererId: ControlledWebPageRendererId;
  loader: AsyncComponentLoader;
}>;

const webPageRendererRegistry = new Map<ControlledWebPageRouteId, WebPageRendererRegistration>([
  ["route.overview", { rendererId: "builtin.web-page.overview.v1", loader: () => import("./pages/OverviewPage.vue") }],
  ["route.adapters", { rendererId: "builtin.web-page.adapters.v1", loader: () => import("./pages/RouteConfigPage.vue") }],
  ["route.persona", { rendererId: "builtin.web-page.persona.v1", loader: () => import("./pages/PersonaTemplatePage.vue") }],
  ["route.persona-document", { rendererId: "builtin.web-page.persona-document.v1", loader: () => import("./pages/PersonaDocumentPage.vue") }],
  ["route.knowledge", { rendererId: "builtin.web-page.knowledge.v1", loader: () => import("./pages/RoleKnowledgePage.vue") }],
  ["route.persona-sync", { rendererId: "builtin.web-page.persona-sync.v1", loader: () => import("./pages/PersonaSyncPage.vue") }],
  ["route.speech", { rendererId: "builtin.web-page.speech.v1", loader: () => import("./pages/SpeechServicePage.vue") }],
  ["global.performance", { rendererId: "builtin.web-page.performance.v1", loader: () => import("./pages/PerformancePage.vue") }],
  ["route.runtime", { rendererId: "builtin.web-page.runtime.v1", loader: () => import("./pages/RuntimeLogPage.vue") }],
  ["global.settings", { rendererId: "builtin.web-page.settings.v1", loader: () => import("./pages/SettingsPage.vue") }],
  ["global.docs", { rendererId: "builtin.web-page.docs.v1", loader: () => import("./pages/ProjectDocsPage.vue") }]
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledSymbol(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized === value && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : "";
}

function webHosted(value: JsonRecord): boolean {
  return Array.isArray(value.hosts)
    && value.hosts.every(host => typeof host === "string")
    && value.hosts.includes("web");
}

export function webPageRenderer(routeId: ControlledWebPageRouteId): WebPageRendererRegistration {
  const renderer = webPageRendererRegistry.get(routeId);
  if (!renderer) throw new Error(`Web page route is not registered: ${routeId}`);
  return renderer;
}

export function parseWebPageContribution(value: unknown): WebPageContribution | undefined {
  if (!isRecord(value) || value.kind !== "page" || !webHosted(value)) return undefined;
  const instanceId = controlledSymbol(value.instanceId);
  const pluginId = controlledSymbol(value.pluginId);
  const routeId = controlledSymbol(value.routeId) as ControlledWebPageRouteId;
  const rendererId = controlledSymbol(value.rendererId) as ControlledWebPageRendererId;
  const registered = webPageRendererRegistry.get(routeId);
  if (!instanceId || !pluginId || !registered || registered.rendererId !== rendererId) return undefined;
  return { instanceId, pluginId, routeId, rendererId };
}

export function resolveWebPageCatalog(
  contributions: readonly unknown[] | null,
  status: "idle" | "loading" | "ready" | "unavailable"
): WebPageCatalogState {
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
  routeId: ControlledWebPageRouteId
): boolean {
  return catalog.mode === "catalog" && catalog.pages.some(page => page.routeId === routeId);
}

export function isWebNavigationPageActive(
  catalog: WebPageCatalogState,
  instanceId: string,
  routeId: ControlledWebPageRouteId
): boolean {
  return catalog.mode === "catalog"
    && catalog.pages.some(page => page.instanceId === instanceId && page.routeId === routeId);
}
