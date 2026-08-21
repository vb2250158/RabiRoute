import {
  routeScopedAdaptersPath,
  routeScopedKnowledgePath,
  routeScopedOverviewPath,
  routeScopedPersonaPath,
  routeScopedPersonaSyncPath,
  routeScopedRuntimePath,
  routeScopedSpeechPath
} from "./routeScopedNavigation";

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

type ControlledRouteId =
  | "route.overview"
  | "route.adapters"
  | "route.persona"
  | "route.knowledge"
  | "route.persona-sync"
  | "route.speech"
  | "global.performance"
  | "route.runtime"
  | "global.settings"
  | "global.docs";

type NavigationTemplate = Readonly<{
  key: string;
  id: string;
  title: string;
  icon: string;
  routeId: ControlledRouteId;
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

const controlledRoutes = new Map<ControlledRouteId, ControlledRoute>([
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

const fallbackNavigation: readonly Omit<NavigationTemplate, "sequence">[] = [
  { key: "fallback:overview", id: "overview", title: "控制台", icon: "mdi-view-dashboard-outline", routeId: "route.overview", slot: "route-primary", order: 10 },
  { key: "fallback:message-adapters", id: "message-adapters", title: "消息适配器", icon: "mdi-puzzle-outline", routeId: "route.adapters", slot: "route-primary", order: 20 },
  { key: "fallback:persona", id: "persona", title: "人格配置", icon: "mdi-account-heart-outline", routeId: "route.persona", slot: "route-primary", order: 30 },
  { key: "fallback:knowledge", id: "knowledge", title: "计划与记忆", icon: "mdi-notebook-check-outline", routeId: "route.knowledge", slot: "route-primary", order: 40 },
  { key: "fallback:persona-sync", id: "persona-sync", title: "多电脑人格同步", icon: "mdi-folder-sync-outline", routeId: "route.persona-sync", slot: "persona-secondary", order: 45 },
  { key: "fallback:speech", id: "speech", title: "语音服务", icon: "mdi-waveform", routeId: "route.speech", slot: "utility", order: 50 },
  { key: "fallback:performance", id: "performance", title: "性能监控", icon: "mdi-chart-timeline-variant", routeId: "global.performance", slot: "utility", order: 60 },
  { key: "fallback:runtime", id: "runtime", title: "日志诊断", icon: "mdi-console-line", routeId: "route.runtime", slot: "utility", order: 70 },
  { key: "fallback:settings", id: "settings", title: "设置", icon: "mdi-cog-outline", routeId: "global.settings", slot: "utility", order: 80 },
  { key: "fallback:docs", id: "docs", title: "使用手册", icon: "mdi-book-open-page-variant-outline", routeId: "global.docs", slot: "footer", order: 90 }
];

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

function controlledRouteId(value: unknown): ControlledRouteId | undefined {
  const routeId = controlledText(value, 80) as ControlledRouteId;
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
    title: label,
    icon,
    routeId,
    slot,
    order,
    sequence
  };
}

function navigationTemplates(contributions: readonly unknown[] | null): NavigationTemplate[] {
  const accepted = (contributions ?? [])
    .map((value, sequence) => parseNavigationContribution(value, sequence))
    .filter((value): value is NavigationTemplate => value !== undefined);
  const controlledRouteIds = new Set(accepted.map(item => item.routeId));
  const merged = [...accepted];
  const fallbackSequenceStart = contributions?.length ?? 0;
  let fallbackSequence = 0;
  for (const fallback of fallbackNavigation) {
    if (controlledRouteIds.has(fallback.routeId)) continue;
    merged.push({ ...fallback, sequence: fallbackSequenceStart + fallbackSequence });
    fallbackSequence += 1;
  }
  return merged.sort((left, right) => left.order - right.order || left.sequence - right.sequence);
}

export function buildWebNavigation(
  contributions: readonly unknown[] | null,
  selectedRouteId: string
): WebNavigationGroups {
  const seenPaths = new Set<string>();
  const items = navigationTemplates(contributions).flatMap((item): WebNavigationItem[] => {
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
