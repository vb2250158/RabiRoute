import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readPluginSources } from "./lib/plugin-source-layout.mjs";

const root = process.cwd();
const webDist = path.join(root, "ribiwebgui", "dist");
const manifest = JSON.parse(await readFile(path.join(webDist, ".vite", "manifest.json"), "utf8"));
const entries = [];
for (const { directory, manifest: plugin } of await readPluginSources(root)) {
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (!metadata.rabi?.webSource) continue;
  entries.push([path.relative(path.join(root, "ribiwebgui"), path.join(directory, metadata.rabi.webSource)).replaceAll("\\", "/"), plugin.id, plugin.version]);
}
for (const [source, pluginId, version] of entries) {
  const built = manifest[source];
  if (!built || typeof built.file !== "string" || !built.file.startsWith("assets/")) throw new Error(`Web plugin entry is missing: ${source}.`);
  const webRoot = path.join(root, "dist", "plugins", "packages", encodeURIComponent(pluginId), version, "web");
  // Native packaging owns the other recorded files here; this phase owns only the wrapper.
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, "client.mjs"), `export { activate } from "/${built.file}";\n`, "utf8");
}
console.log(`Wrote ${entries.length} independent Web plugin entries.`);
