import {
  isWebNavigationPageActive,
  resolveRegisteredWebPagePath,
  resolveWebPageCatalog,
  webPageAllowsNavigation,
  webPageRenderer,
  type WebPageRouteId
} from "./pluginPages";

export type WebNavigationSlot = string;

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
  pluginId: string;
  title: string;
  icon: string;
  routeId: WebPageRouteId;
  slot: WebNavigationSlot;
  order: number;
  sequence: number;
}>;

type JsonRecord = Record<string, unknown>;

const renderedSlots = new Set(["route-primary", "persona-secondary", "utility", "footer"]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}

function controlledSymbol(value: unknown, maximumLength: number): string {
  const normalized = controlledText(value, maximumLength);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : "";
}

function controlledOrder(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && (value as number) >= -10_000 && (value as number) <= 10_000
    ? value as number
    : undefined;
}

function controlledRouteId(value: unknown): WebPageRouteId | undefined {
  const routeId = controlledSymbol(value, 160);
  if (!routeId) return undefined;
  try {
    webPageRenderer(routeId);
    return routeId;
  } catch {
    return undefined;
  }
}

function parseNavigationContribution(value: unknown, sequence: number): NavigationTemplate | undefined {
  if (!isRecord(value) || value.kind !== "navigation" || value.surface !== "web.navigation") return undefined;
  if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) {
    return undefined;
  }

  const id = controlledSymbol(value.id, 128);
  const instanceId = controlledSymbol(value.instanceId, 160);
  const pluginId = controlledSymbol(value.pluginId, 160);
  const label = isRecord(value.label) ? controlledText(value.label.fallback, 80) : "";
  const icon = controlledSymbol(value.icon, 80);
  const slotValue = controlledSymbol(value.slot, 40);
  const slot = renderedSlots.has(slotValue) ? slotValue : undefined;
  const routeId = controlledRouteId(value.routeId);
  const order = controlledOrder(value.order);

  if (
    !id
    || !instanceId
    || !pluginId
    || !label
    || !icon
    || !slot
    || !routeId
    || !webPageAllowsNavigation(routeId, slot, icon)
    || order === undefined
  ) {
    return undefined;
  }

  return {
    key: `${instanceId}:${id}`,
    id,
    instanceId,
    pluginId,
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
    .filter(item => isWebNavigationPageActive(pageCatalog, item.instanceId, item.pluginId, item.routeId))
    .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
    .flatMap((item): WebNavigationItem[] => {
      let to = "";
      try {
        to = resolveRegisteredWebPagePath(item.routeId, selectedRouteId.trim());
      } catch {
        return [];
      }
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
