import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const webPatchInputs = ["ribiwebgui", "assets", "docs", "src/shared", "src/plugins", "package.json", "package-lock.json", "scripts/sync-plugin-web-bundles.mjs"];

export function isWebPatchInput(relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.split("/").some(part => ["dist", "node_modules", ".git", ".web-patch-build.lock"].includes(part))) return false;
  // Native plugin UI is source input. Backend implementations and external
  // integrations may contain local runtimes/data and are not Vite dependencies.
  if (normalized === "src/plugins") return true;
  if (normalized.startsWith("src/plugins/")) {
    const parts = normalized.split("/");
    return parts.length === 3 || parts[3] === "web" || (parts.length === 4 && parts[3] === "package.json");
  }
  return webPatchInputs.some(input => normalized === input || normalized.startsWith(`${input}/`));
}

export async function webPatchInputHash(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) { hash.update(`${relative}\0absent\n`); return; }
    if (stat.isSymbolicLink()) throw new Error("Web build inputs cannot contain symbolic links.");
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) {
        const child = `${relative}/${name}`;
        if (isWebPatchInput(child)) await visit(child);
      }
    } else if (stat.isFile()) {
      hash.update(`${relative}\0${createHash("sha256").update(await fs.readFile(filename)).digest("hex")}\n`);
    }
  }
  for (const input of webPatchInputs) await visit(input);
  return hash.digest("hex");
}
