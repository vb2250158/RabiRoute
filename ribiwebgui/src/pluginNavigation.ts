import {
  routeScopedAdaptersPath,
  routeScopedKnowledgePath,
  routeScopedOverviewPath,
  routeScopedPersonaPath,
  routeScopedPersonaSyncPath,
  routeScopedRuntimePath,
  routeScopedSpeechPath
} from "./routeScopedNavigation";
import {
  isWebNavigationPageActive,
  resolveWebPageCatalog,
  type ControlledWebPageRouteId
} from "./pluginPages";

export type WebNavigationSlot = "route-primary" | "persona-secondary" | "utility" | "footer";

export type WebNavigationItem = Readonly<{
  key: string;
  id: string;
  title: string;
  icon: string;
  to: string;
  slot: WebNavigationSlot;
  order: number;
}>;

export type WebNavigationGroups = Readonly<{
  routePrimary: readonly WebNavigationItem[];
  personaSecondary: readonly WebNavigationItem[];
  utility: readonly WebNavigationItem[];
  footer: readonly WebNavigationItem[];
}>;

type NavigationTemplate = Readonly<{
  key: string;
  id: string;
  instanceId: string;
  title: string;
  icon: string;
  routeId: ControlledWebPageRouteId;
  slot: WebNavigationSlot;
  order: number;
  sequence: number;
}>;

type JsonRecord = Record<string, unknown>;
type RouteResolver = (selectedRouteId: string) => string;

type ControlledRoute = Readonly<{
  resolve: RouteResolver;
  slots: readonly WebNavigationSlot[];
}>;

const allowedSlots = new Set<WebNavigationSlot>(["route-primary", "persona-secondary", "utility", "footer"]);
const allowedIcons = new Set([
  "mdi-account-heart-outline",
  "mdi-book-open-page-variant-outline",
  "mdi-chart-timeline-variant",
  "mdi-cog-outline",
  "mdi-console-line",
  "mdi-folder-sync-outline",
  "mdi-notebook-check-outline",
  "mdi-puzzle-outline",
  "mdi-view-dashboard-outline",
  "mdi-waveform"
]);

const controlledRoutes = new Map<ControlledWebPageRouteId, ControlledRoute>([
  ["route.overview", { resolve: routeScopedOverviewPath, slots: ["route-primary"] }],
  ["route.adapters", { resolve: routeScopedAdaptersPath, slots: ["route-primary"] }],
  ["route.persona", { resolve: routeScopedPersonaPath, slots: ["route-primary"] }],
  ["route.knowledge", { resolve: routeScopedKnowledgePath, slots: ["route-primary"] }],
  ["route.persona-sync", { resolve: routeScopedPersonaSyncPath, slots: ["persona-secondary"] }],
  ["route.speech", { resolve: routeScopedSpeechPath, slots: ["utility"] }],
  ["global.performance", { resolve: () => "/performance", slots: ["utility"] }],
  ["route.runtime", { resolve: routeScopedRuntimePath, slots: ["utility"] }],
  ["global.settings", { resolve: () => "/settings", slots: ["utility"] }],
  ["global.docs", { resolve: () => "/docs", slots: ["footer"] }]
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}

function controlledOrder(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && (value as number) >= -10_000 && (value as number) <= 10_000
    ? value as number
    : undefined;
}

function controlledRouteId(value: unknown): ControlledWebPageRouteId | undefined {
  const routeId = controlledText(value, 80) as ControlledWebPageRouteId;
  return controlledRoutes.has(routeId) ? routeId : undefined;
}

function parseNavigationContribution(value: unknown, sequence: number): NavigationTemplate | undefined {
  if (!isRecord(value) || value.kind !== "navigation" || value.surface !== "web.navigation") return undefined;
  if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) {
    return undefined;
  }

  const id = controlledText(value.id, 128);
  const instanceId = controlledText(value.instanceId, 160);
  const label = isRecord(value.label) ? controlledText(value.label.fallback, 80) : "";
  const icon = controlledText(value.icon, 80);
  const slot = controlledText(value.slot, 40) as WebNavigationSlot;
  const routeId = controlledRouteId(value.routeId);
  const order = controlledOrder(value.order);
  const route = routeId ? controlledRoutes.get(routeId) : undefined;

  if (
    !id
    || !instanceId
    || !label
    || !allowedIcons.has(icon)
    || !allowedSlots.has(slot)
    || !routeId
    || !route?.slots.includes(slot)
    || order === undefined
  ) {
    return undefined;
  }

  return {
    key: `${instanceId}:${id}`,
    id,
    instanceId,
    title: label,
    icon,
    routeId,
    slot,
    order,
    sequence
  };
}

export function buildWebNavigation(
  contributions: readonly unknown[] | null,
  selectedRouteId: string
): WebNavigationGroups {
  const pageCatalog = resolveWebPageCatalog(contributions, contributions === null ? "loading" : "ready");
  const seenPaths = new Set<string>();
  const items = (contributions ?? [])
    .map((value, sequence) => parseNavigationContribution(value, sequence))
    .filter((value): value is NavigationTemplate => value !== undefined)
    .filter(item => isWebNavigationPageActive(pageCatalog, item.instanceId, item.routeId))
    .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
    .flatMap((item): WebNavigationItem[] => {
      const to = controlledRoutes.get(item.routeId)?.resolve(selectedRouteId.trim()) ?? "";
      if (!to || seenPaths.has(to)) return [];
      seenPaths.add(to);
      return [{
        key: item.key,
        id: item.id,
        title: item.title,
        icon: item.icon,
        to,
        slot: item.slot,
        order: item.order
      }];
    });

  return {
    routePrimary: items.filter(item => item.slot === "route-primary"),
    personaSecondary: items.filter(item => item.slot === "persona-secondary"),
    utility: items.filter(item => item.slot === "utility"),
    footer: items.filter(item => item.slot === "footer")
  };
}
