import { cp, mkdir, readFile, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "ribiwebgui", "dist");
const manifest = JSON.parse(await readFile(path.join(dist, ".vite", "manifest.json"), "utf8"));
const entry = manifest["src/bundles/rabiManagerBaseClient.ts"];
if (!entry || typeof entry.file !== "string") throw new Error("Base Web Bundle entry is missing.");

const packageRoot = path.join(root, "plugins", "packages", "rabi.manager.base", "0.2.1");
const webRoot = path.join(packageRoot, "web");
await rm(webRoot, { recursive: true, force: true });
await mkdir(webRoot, { recursive: true });
for (const file of await readdir(path.join(dist, "assets"))) {
  await cp(path.join(dist, "assets", file), path.join(webRoot, file), { recursive: true });
}
// Keep the Vite entry module intact: it exports activate() and imports its revision-local graph.
let source = await readFile(path.join(dist, entry.file), "utf8");
source = source.replace(/(["'])assets\//g, "$1");
if (!/\bactivate\b/.test(source)) throw new Error("Base Web Bundle entry does not export activate().");
await writeFile(path.join(webRoot, "client.mjs"), source, "utf8");
console.log(`Wrote ${path.relative(root, path.join(webRoot, "client.mjs"))}.`);
