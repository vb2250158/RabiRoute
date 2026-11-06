import fs from "node:fs/promises";
import path from "node:path";

export type DesktopPetDialogue = {
  openers: Record<string, string>;
  fallbacks: Record<string, string>;
};

export async function readDesktopPetDialogue(roleId: string, roleDir: string): Promise<DesktopPetDialogue> {
  const empty: DesktopPetDialogue = { openers: {}, fallbacks: {} };
  let value: unknown;
  try {
    const file = path.join(roleDir, "desktop-pet", "dialogue.json");
    if ((await fs.stat(file)).size > 64 * 1024) return empty;
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1 || config.personaId !== roleId) return empty;
  for (const group of ["openers", "fallbacks"] as const) {
    const rows = config[group];
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
    for (const [key, text] of Object.entries(rows)) {
      if (typeof text === "string" && text.trim()) empty[group][key] = text.trim().slice(0, 1000);
    }
  }
  return empty;
}
