import type { DesktopTheme } from "@shared/desktopSettingsContract";
import { ref } from "vue";

export type WebThemeId = string;
export type WebThemeResourceId = string;
export type EffectiveWebTheme = "light" | "dark";

export type TrustedWebThemeResourceRegistration = Readonly<{
  instanceId: string;
  pluginId: string;
  themeId: WebThemeId;
  webResourceId: WebThemeResourceId;
  label: string;
  icon: string;
  desktopTheme?: DesktopTheme;
  apply: (systemDark: boolean) => EffectiveWebTheme;
}>;

export type WebThemeContribution = Readonly<{
  instanceId: string;
  pluginId: string;
  themeId: WebThemeId;
  webResourceId: WebThemeResourceId;
}>;

export type WebThemeOption = Readonly<{
  themeId: WebThemeId;
  webResourceId: WebThemeResourceId;
  label: string;
  icon: string;
  desktopTheme?: DesktopTheme;
}>;

export type ResolvedWebThemeResource = WebThemeOption & Readonly<{
  apply: TrustedWebThemeResourceRegistration["apply"];
}>;

export type WebThemeCatalog = Readonly<{
  themes: readonly WebThemeContribution[];
  options: readonly WebThemeOption[];
}>;

type JsonRecord = Record<string, unknown>;

const themeRegistry = new Map<WebThemeId, TrustedWebThemeResourceRegistration>();
const themeResourceOwners = new Map<WebThemeResourceId, WebThemeId>();
const themeRegistrationRevision = ref(0);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`Trusted Web theme ${field} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Trusted Web theme ${field} is invalid.`);
  }
  return normalized;
}

function controlledSymbol(value: unknown, field: string, maximumLength = 160): string {
  const normalized = controlledText(value, field, maximumLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error(`Trusted Web theme ${field} is invalid.`);
  }
  return normalized;
}

function isDesktopTheme(value: unknown): value is DesktopTheme {
  return value === "system" || value === "light" || value === "dark";
}

function normalizeRegistration(input: TrustedWebThemeResourceRegistration): TrustedWebThemeResourceRegistration {
  if (typeof input.apply !== "function" || (input.desktopTheme !== undefined && !isDesktopTheme(input.desktopTheme))) {
    throw new Error("Trusted Web theme registration is invalid.");
  }
  return Object.freeze({
    instanceId: controlledSymbol(input.instanceId, "instanceId"),
    pluginId: controlledSymbol(input.pluginId, "pluginId"),
    themeId: controlledSymbol(input.themeId, "themeId"),
    webResourceId: controlledSymbol(input.webResourceId, "webResourceId"),
    label: controlledText(input.label, "label", 80),
    icon: controlledSymbol(input.icon, "icon", 80),
    ...(input.desktopTheme ? { desktopTheme: input.desktopTheme } : {}),
    apply: input.apply
  });
}

export function registerTrustedWebThemeResource(input: TrustedWebThemeResourceRegistration): () => void {
  const registration = normalizeRegistration(input);
  if (themeRegistry.has(registration.themeId)) {
    throw new Error(`Trusted Web theme is already registered: ${registration.themeId}`);
  }
  const resourceOwner = themeResourceOwners.get(registration.webResourceId);
  if (resourceOwner) {
    throw new Error(`Trusted Web theme resource is already registered by ${resourceOwner}: ${registration.webResourceId}`);
  }
  themeRegistry.set(registration.themeId, registration);
  themeResourceOwners.set(registration.webResourceId, registration.themeId);
  themeRegistrationRevision.value += 1;
  let active = true;
  return () => {
    if (!active || themeRegistry.get(registration.themeId) !== registration) return;
    active = false;
    themeRegistry.delete(registration.themeId);
    themeResourceOwners.delete(registration.webResourceId);
    themeRegistrationRevision.value += 1;
  };
}

export function registeredWebThemeResources(): readonly TrustedWebThemeResourceRegistration[] {
  return Object.freeze([...themeRegistry.values()]);
}

export function parseWebThemeContribution(value: unknown): WebThemeContribution | undefined {
  if (!isRecord(value) || value.kind !== "theme" || value.surface !== "shared.themes") return undefined;
  if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) {
    return undefined;
  }
  let instanceId = "";
  let pluginId = "";
  let themeId = "";
  let webResourceId = "";
  try {
    instanceId = controlledSymbol(value.instanceId, "contribution.instanceId");
    pluginId = controlledSymbol(value.pluginId, "contribution.pluginId");
    themeId = controlledSymbol(value.themeId, "contribution.themeId");
    webResourceId = controlledSymbol(value.webResourceId, "contribution.webResourceId");
  } catch {
    return undefined;
  }
  const registration = themeRegistry.get(themeId);
  if (
    !registration
    || registration.instanceId !== instanceId
    || registration.pluginId !== pluginId
    || registration.webResourceId !== webResourceId
  ) return undefined;
  return { instanceId, pluginId, themeId, webResourceId };
}

export function resolveWebThemeCatalog(contributions: readonly unknown[] | null): WebThemeCatalog {
  void themeRegistrationRevision.value;
  const accepted = (contributions ?? []).flatMap(value => {
    const theme = parseWebThemeContribution(value);
    return theme ? [theme] : [];
  });
  const unique = accepted.filter((theme, index) => (
    accepted.findIndex(candidate => candidate.themeId === theme.themeId) === index
    && accepted.filter(candidate => candidate.themeId === theme.themeId).length === 1
  ));
  return {
    themes: Object.freeze(unique),
    options: Object.freeze(unique.flatMap(theme => {
      const registration = themeRegistry.get(theme.themeId);
      return registration ? [{
        themeId: registration.themeId,
        webResourceId: registration.webResourceId,
        label: registration.label,
        icon: registration.icon,
        ...(registration.desktopTheme ? { desktopTheme: registration.desktopTheme } : {})
      }] : [];
    }))
  };
}

function fallbackSystemResource(): ResolvedWebThemeResource {
  return {
    themeId: "system",
    webResourceId: "web-host.recovery-theme.v1",
    label: "跟随系统",
    icon: "mdi-theme-light-dark",
    desktopTheme: "system",
    apply: systemDark => systemDark ? "dark" : "light"
  };
}
export function resolveWebThemeResource(
  catalog: WebThemeCatalog,
  preference: WebThemeId
): ResolvedWebThemeResource {
  const selected = catalog.themes.find(theme => theme.themeId === preference);
  const registration = selected ? themeRegistry.get(selected.themeId) : undefined;
  if (!selected || !registration || registration.webResourceId !== selected.webResourceId) return fallbackSystemResource();
  return {
    themeId: registration.themeId,
    webResourceId: registration.webResourceId,
    label: registration.label,
    icon: registration.icon,
    ...(registration.desktopTheme ? { desktopTheme: registration.desktopTheme } : {}),
    apply: registration.apply
  };
}

export function initialWebThemePreference(storedTheme: WebThemeId, desktopTheme: DesktopTheme): WebThemeId {
  return storedTheme || desktopTheme;
}

export const WEB_THEME_PREFERENCE_KEY = "rabiroute:webgui:theme-preference";

export function readStoredWebThemePreference(): WebThemeId {
  try {
    return window.localStorage.getItem(WEB_THEME_PREFERENCE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function writeStoredWebThemePreference(themeId: WebThemeId | undefined): void {
  try {
    if (themeId) window.localStorage.setItem(WEB_THEME_PREFERENCE_KEY, themeId);
    else window.localStorage.removeItem(WEB_THEME_PREFERENCE_KEY);
  } catch {
    // 浏览器禁用本地存储时仅保留当前会话主题。
  }
}
