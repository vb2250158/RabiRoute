import type { DesktopTheme } from "@shared/desktopSettingsContract";
import {
  normalizeCustomInterfaceThemes,
  type CustomInterfaceTheme
} from "../../src/shared/interfaceThemeContract";
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
  customTheme?: CustomInterfaceTheme;
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
  customTheme?: CustomInterfaceTheme;
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
const customThemeIds = new Set<WebThemeId>();
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
    ...(input.customTheme ? { customTheme: input.customTheme } : {}),
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

export function replaceCustomWebThemeResources(value: unknown): readonly CustomInterfaceTheme[] {
  for (const themeId of customThemeIds) {
    const registration = themeRegistry.get(themeId);
    if (!registration) continue;
    themeRegistry.delete(themeId);
    themeResourceOwners.delete(registration.webResourceId);
  }
  customThemeIds.clear();

  const themes = normalizeCustomInterfaceThemes(value);
  for (const theme of themes) {
    const resourceId = `user.web-theme.${theme.id.slice("custom:".length)}.v1`;
    const registration = Object.freeze({
      instanceId: "manager:custom-theme",
      pluginId: "builtin:manager/custom-themes",
      themeId: theme.id,
      webResourceId: resourceId,
      label: theme.name,
      icon: "mdi-palette-outline",
      desktopTheme: theme.id,
      customTheme: theme,
      apply: () => theme.baseTheme
    }) satisfies TrustedWebThemeResourceRegistration;
    themeRegistry.set(theme.id, registration);
    themeResourceOwners.set(resourceId, theme.id);
    customThemeIds.add(theme.id);
  }
  themeRegistrationRevision.value += 1;
  return themes;
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
  const customThemes = [...customThemeIds].flatMap(themeId => {
    const registration = themeRegistry.get(themeId);
    return registration ? [{
      instanceId: registration.instanceId,
      pluginId: registration.pluginId,
      themeId: registration.themeId,
      webResourceId: registration.webResourceId
    }] : [];
  });
  const acceptedThemes = [...unique, ...customThemes];
  return {
    themes: Object.freeze(acceptedThemes),
    options: Object.freeze(acceptedThemes.flatMap(theme => {
      const registration = themeRegistry.get(theme.themeId);
      return registration ? [{
        themeId: registration.themeId,
        webResourceId: registration.webResourceId,
        label: registration.label,
        icon: registration.icon,
        ...(registration.desktopTheme ? { desktopTheme: registration.desktopTheme } : {}),
        ...(registration.customTheme ? { customTheme: registration.customTheme } : {})
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
    ...(registration.customTheme ? { customTheme: registration.customTheme } : {}),
    apply: registration.apply
  };
}

export type InitialWebThemePreference = Readonly<{
  themeId: WebThemeId;
  migrateToManager: boolean;
}>;

function normalizedWebThemePreference(value: unknown): WebThemeId {
  try {
    return controlledSymbol(value, "preference");
  } catch {
    return "";
  }
}

export function initialWebThemePreference(managerWebTheme: unknown, legacyWebTheme: WebThemeId): InitialWebThemePreference {
  const managerTheme = normalizedWebThemePreference(managerWebTheme);
  if (managerTheme) return { themeId: managerTheme, migrateToManager: false };
  const legacyTheme = normalizedWebThemePreference(legacyWebTheme);
  if (legacyTheme) return { themeId: legacyTheme, migrateToManager: true };
  return { themeId: "system", migrateToManager: false };
}

export const WEB_THEME_PREFERENCE_KEY = "rabiroute:webgui:theme-preference";

type LegacyWebThemeStorage = Pick<Storage, "getItem" | "removeItem">;

export function storedWebThemePreference(storage: Pick<Storage, "getItem"> = window.localStorage): WebThemeId {
  try {
    return normalizedWebThemePreference(storage.getItem(WEB_THEME_PREFERENCE_KEY));
  } catch {
    return "";
  }
}

export function clearStoredWebThemePreference(storage: Pick<Storage, "removeItem"> = window.localStorage): void {
  try {
    storage.removeItem(WEB_THEME_PREFERENCE_KEY);
  } catch {
    // Manager 写入成功后才清理旧浏览器键；清理失败不改变 Manager 真源。
  }
}

export function consumeStoredWebThemePreference(storage: LegacyWebThemeStorage = window.localStorage): WebThemeId {
  const stored = storedWebThemePreference(storage);
  clearStoredWebThemePreference(storage);
  return stored;
}
