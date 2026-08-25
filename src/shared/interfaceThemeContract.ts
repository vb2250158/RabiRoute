export const BUILTIN_INTERFACE_THEME_IDS = ["system", "light", "dark"] as const;
export type BuiltinInterfaceThemeId = typeof BUILTIN_INTERFACE_THEME_IDS[number];
export type InterfaceThemeBase = Exclude<BuiltinInterfaceThemeId, "system">;
export type CustomInterfaceThemeId = `custom:${string}`;
export type InterfaceThemeId = BuiltinInterfaceThemeId | CustomInterfaceThemeId;

export const INTERFACE_THEME_COLOR_KEYS = [
  "pageCanvas",
  "canvas",
  "surface",
  "subtle",
  "input",
  "border",
  "borderStrong",
  "text",
  "heading",
  "muted",
  "accent",
  "accentStrong",
  "success",
  "warning",
  "error",
  "info",
  "switchTrack",
  "switchThumb"
] as const;

export type InterfaceThemeColorKey = typeof INTERFACE_THEME_COLOR_KEYS[number];
export type InterfaceThemeColors = Record<InterfaceThemeColorKey, string>;

export type InterfaceThemeShadow = "none" | "soft" | "strong";

export type InterfaceThemeStyles = {
  cornerRadius: number;
  shadow: InterfaceThemeShadow;
  glassOpacity: number;
};

export type CustomInterfaceTheme = {
  id: CustomInterfaceThemeId;
  name: string;
  baseTheme: InterfaceThemeBase;
  colors: InterfaceThemeColors;
  styles: InterfaceThemeStyles;
};

export const BUILTIN_INTERFACE_THEME_TEMPLATES: Readonly<Record<InterfaceThemeBase, Readonly<{
  colors: Readonly<InterfaceThemeColors>;
  styles: Readonly<InterfaceThemeStyles>;
}>>> = Object.freeze({
  light: Object.freeze({
    colors: Object.freeze({
      pageCanvas: "#eef6f8",
      canvas: "#f6f8fb",
      surface: "#ffffff",
      subtle: "#f5f8fa",
      input: "#fbfdff",
      border: "#dbe5ea",
      borderStrong: "#cad8e0",
      text: "#112033",
      heading: "#0c2a4a",
      muted: "#52677a",
      accent: "#19bfc1",
      accentStrong: "#0f8b8d",
      success: "#16a34a",
      warning: "#f59e0b",
      error: "#dc2626",
      info: "#087f91",
      switchTrack: "#52677a",
      switchThumb: "#ffffff"
    }),
    styles: Object.freeze({ cornerRadius: 8, shadow: "soft", glassOpacity: 92 })
  }),
  dark: Object.freeze({
    colors: Object.freeze({
      pageCanvas: "#10161d",
      canvas: "#121a22",
      surface: "#19242e",
      subtle: "#202c37",
      input: "#1d2934",
      border: "#31414f",
      borderStrong: "#526779",
      text: "#e9f2f7",
      heading: "#f0f8fc",
      muted: "#c4d3dd",
      accent: "#43d4d7",
      accentStrong: "#88edef",
      success: "#4ade80",
      warning: "#fbbf24",
      error: "#fb7185",
      info: "#67c7ff",
      switchTrack: "#526779",
      switchThumb: "#e9f2f7"
    }),
    styles: Object.freeze({ cornerRadius: 8, shadow: "strong", glassOpacity: 94 })
  })
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CUSTOM_THEME_ID = /^custom:[a-z0-9][a-z0-9-]{5,63}$/;
const SHADOW_OPTIONS = new Set<InterfaceThemeShadow>(["none", "soft", "strong"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeHex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

export function isInterfaceThemeHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
}

export function interfaceThemeContrastRatio(foreground: string, background: string): number {
  if (!isInterfaceThemeHexColor(foreground) || !isInterfaceThemeHexColor(background)) return 0;
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + .05) / (darker + .05);
}

export function readableInterfaceThemeForeground(background: string): "#000000" | "#ffffff" {
  return interfaceThemeContrastRatio("#000000", background) >= interfaceThemeContrastRatio("#ffffff", background)
    ? "#000000"
    : "#ffffff";
}

function normalizeName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40)
    : "";
}

export function isCustomInterfaceThemeId(value: unknown): value is CustomInterfaceThemeId {
  return typeof value === "string" && CUSTOM_THEME_ID.test(value);
}

export function isInterfaceThemeId(value: unknown): value is InterfaceThemeId {
  return (BUILTIN_INTERFACE_THEME_IDS as readonly unknown[]).includes(value) || isCustomInterfaceThemeId(value);
}

export function cloneBuiltinInterfaceTheme(baseTheme: InterfaceThemeBase): Pick<CustomInterfaceTheme, "baseTheme" | "colors" | "styles"> {
  const template = BUILTIN_INTERFACE_THEME_TEMPLATES[baseTheme];
  return {
    baseTheme,
    colors: { ...template.colors },
    styles: { ...template.styles }
  };
}

export function normalizeCustomInterfaceTheme(value: unknown): CustomInterfaceTheme | undefined {
  const row = record(value);
  if (!isCustomInterfaceThemeId(row.id)) return undefined;
  const name = normalizeName(row.name);
  if (!name) return undefined;
  const baseTheme: InterfaceThemeBase = row.baseTheme === "dark" ? "dark" : "light";
  const template = BUILTIN_INTERFACE_THEME_TEMPLATES[baseTheme];
  const inputColors = record(row.colors);
  const colors = Object.fromEntries(INTERFACE_THEME_COLOR_KEYS.map(key => [
    key,
    normalizeHex(inputColors[key], template.colors[key])
  ])) as InterfaceThemeColors;
  const inputStyles = record(row.styles);
  const shadow = SHADOW_OPTIONS.has(inputStyles.shadow as InterfaceThemeShadow)
    ? inputStyles.shadow as InterfaceThemeShadow
    : template.styles.shadow;
  const cornerRadius = typeof inputStyles.cornerRadius === "number" && Number.isFinite(inputStyles.cornerRadius)
    ? Math.round(Math.min(24, Math.max(0, inputStyles.cornerRadius)))
    : template.styles.cornerRadius;
  const glassOpacity = typeof inputStyles.glassOpacity === "number" && Number.isFinite(inputStyles.glassOpacity)
    ? Math.round(Math.min(100, Math.max(70, inputStyles.glassOpacity)))
    : template.styles.glassOpacity;
  return { id: row.id, name, baseTheme, colors, styles: { cornerRadius, shadow, glassOpacity } };
}

export function normalizeCustomInterfaceThemes(value: unknown): CustomInterfaceTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomInterfaceTheme[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value.slice(0, 24)) {
    const theme = normalizeCustomInterfaceTheme(item);
    const nameKey = theme?.name.toLocaleLowerCase();
    if (!theme || ids.has(theme.id) || names.has(nameKey!)) continue;
    ids.add(theme.id);
    names.add(nameKey!);
    themes.push(theme);
  }
  return themes;
}
