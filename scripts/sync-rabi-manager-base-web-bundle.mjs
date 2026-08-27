import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "ribiwebgui", "dist");
const manifest = JSON.parse(await readFile(path.join(dist, ".vite", "manifest.json"), "utf8"));
const entry = manifest["src/bundles/rabiManagerBaseClient.ts"];
if (!entry || typeof entry.file !== "string" || !entry.file.startsWith("assets/")) {
  throw new Error("Base Web Bundle entry is missing.");
}

const packageRoot = path.join(root, "plugins", "packages", "rabi.manager.base", "0.2.1");
const webRoot = path.join(packageRoot, "web");
await rm(webRoot, { recursive: true, force: true });
await mkdir(webRoot, { recursive: true });

// This immutable plugin entry deliberately reuses the host asset graph. Copying
// Vue, Pinia, or page chunks below the revision URL creates second module
// singletons, so optional Bundle pages cannot inject the host Pinia store.
const client = [
  'export { activate } from "' + "/" + entry.file + '";',
  ""
].join("\n");
await writeFile(path.join(webRoot, "client.mjs"), client, "utf8");
console.log(`Wrote ${path.relative(root, path.join(webRoot, "client.mjs"))}.`);
