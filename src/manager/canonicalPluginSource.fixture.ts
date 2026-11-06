import fs from "node:fs/promises";
import path from "node:path";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginManifest } from "../plugin-kernel/types.js";
// @ts-expect-error The authoritative source-layout helper is a native JavaScript build module.
import { readPluginSources, pluginSourceDirectory } from "../../scripts/lib/plugin-source-layout.mjs";

export type CanonicalPluginSourceFixture = Readonly<{ directory: string; manifest: PluginManifest }>;
export async function canonicalPluginSourceFixture(packageId: string): Promise<CanonicalPluginSourceFixture> {
  const directory = pluginSourceDirectory(process.cwd(), packageId);
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(directory, "rabi.plugin.json"), "utf8")));
  if (manifest.id !== packageId) throw new Error(`Canonical fixture identity differs: ${packageId}`);
  return { directory, manifest };
}
export async function canonicalPluginSourcesFixture(): Promise<CanonicalPluginSourceFixture[]> {
  const rows: Array<{ directory: string; manifest: unknown }> = await readPluginSources(process.cwd());
  return rows.map(row => ({ directory: row.directory, manifest: parsePluginManifest(row.manifest) }));
}
