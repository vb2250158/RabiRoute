import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "ribiwebgui", "dist");
const manifest = JSON.parse(await readFile(path.join(dist, ".vite", "manifest.json"), "utf8"));
const entry = manifest["src/bundles/rabiManagerBaseClient.ts"];
const implementationKey = entry?.imports?.find(key => key.includes("rabiManagerBaseClient"));
const implementation = implementationKey ? manifest[implementationKey] : undefined;
if (!implementation || typeof implementation.file !== "string") throw new Error("Base Web Bundle implementation entry is missing.");

const packageRoot = path.join(root, "plugins", "packages", "rabi.manager.base", "0.2.1");
const webRoot = path.join(packageRoot, "web");
await rm(webRoot, { recursive: true, force: true });
await mkdir(webRoot, { recursive: true });
for (const file of await (await import("node:fs/promises")).readdir(path.join(dist, "assets"))) {
  await cp(path.join(dist, "assets", file), path.join(webRoot, file), { recursive: true });
}
let source = await readFile(path.join(dist, implementation.file), "utf8");
source = source.replace(/(["'])assets\//g, "$1");
source = source.replace(/(\b[A-Za-z_$][\w$]*\s+as\s+)a(?=,?})/, "$1activate");
if (!/\bactivate\b/.test(source)) throw new Error("Base Web Bundle does not export activate().");
await writeFile(path.join(webRoot, "client.mjs"), source, "utf8");
console.log(`Wrote ${path.relative(root, path.join(webRoot, "client.mjs"))}.`);
