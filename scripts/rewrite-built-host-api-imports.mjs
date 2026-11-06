import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** TypeScript paths describe the public API at source time; native host output reuses its actual modules. */
export function rewriteHostApiImports(contents, outputFile, outputRoot) {
  return contents.replace(/(["'])@rabiroute\/host-api\/([^"'\n]+)\1/g, (_match, quote, id) => {
    const target = path.resolve(outputRoot, id + ".js");
    const within = path.relative(outputRoot, target);
    if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("Host API module escapes its application output.");
    let specifier = path.relative(path.dirname(outputFile), target).replaceAll("\\", "/");
    if (!specifier.startsWith(".")) specifier = "./" + specifier;
    return quote + specifier + quote;
  });
}

export async function rewriteBuiltHostApiImports(root) {
  const outputRoot = path.resolve(root, "dist");
  let changed = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const before = await fs.readFile(file, "utf8"), after = rewriteHostApiImports(before, file, outputRoot);
        if (after !== before) { await fs.writeFile(file, after); changed++; }
      }
    }
  }
  await visit(outputRoot);
  return changed;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Resolved public Host API imports in ${await rewriteBuiltHostApiImports(process.cwd())} native modules.`);
}
