import fs from "node:fs/promises";
import path from "node:path";

/** Source folders have stable package identities; only build outputs contain release versions. */
export function pluginSourceDirectory(root, packageId) {
  return path.join(root, "src/plugins", encodeURIComponent(packageId));
}

export async function readPluginSources(root) {
  const directory = path.join(root, "src/plugins");
  const packages = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const source = path.join(directory, entry.name);
    let bytes;
    try { bytes = await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const manifest = JSON.parse(bytes);
    if (manifest.id !== entry.name || manifest.schemaVersion !== 2) throw new Error(`Invalid plugin source identity: ${entry.name}.`);
    packages.push({ directory: source, manifest });
  }
  return packages;
}
