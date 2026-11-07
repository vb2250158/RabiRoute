/** Static startup appearance. The installed theme is the source; this local view is rebuildable. */
export type StartupPalette = Readonly<{ background: string; foreground: string; accent: string }>;
export type StartupFrame = Readonly<{ logoPath: string; durationMs: number }>;
export type StartupMotion = "none" | "breathe" | "orbit";
export type StartupPresentation = Readonly<{
  schemaVersion: 1; themeId: string; light: StartupPalette; dark: StartupPalette;
  motion: StartupMotion; logoPath?: string; frames?: readonly StartupFrame[];
}>;
export type StartupThemeDefinition = Omit<StartupPresentation, "logoPath" | "frames"> & Readonly<{ logo?: string; frames?: readonly Readonly<{ logo: string; durationMs: number }>[] }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function palette(value: unknown): StartupPalette | undefined {
  if (!record(value)) return undefined;
  const colors = [value.background, value.foreground, value.accent];
  if (!colors.every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) return undefined;
  return { background: String(value.background), foreground: String(value.foreground), accent: String(value.accent) };
}
/** Reads the value of an existing declarative `theme` contribution, without executing its plugin. */
export function parseStartupTheme(value: unknown): StartupThemeDefinition | undefined {
  if (!record(value) || value.surface !== "shared.themes" || !Array.isArray(value.hosts) || !value.hosts.includes("desktop")
    || typeof value.themeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.themeId)
    || !record(value.startup)) return undefined;
  const raw = value.startup, light = palette(raw.light), dark = palette(raw.dark);
  if (raw.schemaVersion !== 1 || !light || !dark || !["none", "breathe", "orbit"].includes(String(raw.motion))) return undefined;
  if (raw.logo !== undefined && (typeof raw.logo !== "string" || !raw.logo.startsWith("./")
    || !/\.ico$/i.test(raw.logo))) return undefined;
  let frames: Array<{ logo: string; durationMs: number }> | undefined;
  if (Array.isArray(raw.frames)) {
    frames = [];
    for (const frame of raw.frames) {
      if (!record(frame) || typeof frame.logo !== "string" || !frame.logo.startsWith("./") || !/\.ico$/i.test(frame.logo)
        || !Number.isSafeInteger(frame.durationMs) || Number(frame.durationMs) <= 0) continue;
      frames.push({ logo: frame.logo, durationMs: Number(frame.durationMs) });
    }
  }
  return { schemaVersion: 1, themeId: value.themeId, light, dark, motion: raw.motion as StartupMotion,
    ...(typeof raw.logo === "string" ? { logo: raw.logo } : {}), ...(frames ? { frames } : {}) };
}

/** Brand fallback palettes shared with the Host's cold presentation contract. */
export function builtinStartupPresentation(themeId: "light" | "dark"): StartupPresentation {
  return { schemaVersion: 1, themeId,
    light: { background: "#f6f8fb", foreground: "#112033", accent: "#19bfc1" },
    dark: { background: "#121a22", foreground: "#e9f2f7", accent: "#43d4d7" }, motion: "orbit" };
}
