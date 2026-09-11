import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compileAutomaticCode } from "./lib/automatic-code-compiler.mjs";
import { captureAutomaticInputs } from "./lib/automatic-update-inputs.mjs";
import { captureAutomaticWebInputs } from "./lib/automatic-web-build.mjs";

export async function instrumentAutomaticCode(root) {
  const output = path.join(root, "dist");
  const configuration = JSON.parse(await fs.readFile(path.join(root, "source-patches/modules.json"), "utf8"));
  const managed = new Set(configuration.modules.map(entry => entry.source));
  const modules = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) continue;
      const relative = path.relative(output, filename).replaceAll("\\", "/");
      const sourcePath = `src/${relative.replace(/\.js$/, ".ts")}`;
      const source = await fs.readFile(path.join(root, sourcePath), "utf8").catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (source === undefined) continue;
      const protectedReason = relative.startsWith("plugin-kernel/") || relative.startsWith("manager/automatic")
        ? "The patch runtime and publication owner require a controlled switch."
        : managed.has(sourcePath) ? "This module belongs to the managed source-patch runtime." : undefined;
      const compiled = await fs.readFile(filename, "utf8");
      const runtimeImport = path.relative(path.dirname(filename), path.join(output, "plugin-kernel/automaticCodeRuntime.js")).replaceAll("\\", "/");
      const candidate = protectedReason ? undefined : compileAutomaticCode(compiled, relative, runtimeImport.startsWith(".") ? runtimeImport : `./${runtimeImport}`);
      modules.push({ sourcePath, sourceHash: createHash("sha256").update(source).digest("hex"), protectedReason,
        definition: candidate?.definition });
      if (candidate) await fs.writeFile(filename, candidate.output);
    }
  }
  await visit(output);
  modules.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const inputs = await captureAutomaticInputs(root, ["src", "package.json", "package-lock.json", "tsconfig.json"]);
  const inputHashes = Object.fromEntries([...inputs.files].map(([filename, bytes]) => [filename, createHash("sha256").update(bytes).digest("hex")]));
  const webInputDigest = (await captureAutomaticWebInputs(root)).webDigest;
  const text = JSON.stringify({ schemaVersion: 1, modules, inputHashes, webInputDigest });
  await fs.mkdir(path.join(output, "automatic-code"), { recursive: true });
  await fs.writeFile(path.join(output, "automatic-code/catalog.json"), text);
  return { modules: modules.length, instrumented: modules.filter(entry => entry.definition && Object.keys(entry.definition.implementations).length).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await instrumentAutomaticCode(process.cwd())));
}
