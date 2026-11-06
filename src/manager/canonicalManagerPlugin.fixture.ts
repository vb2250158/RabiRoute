import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import type { PluginManifest, PluginModule } from "../plugin-kernel/types.js";

/** Lifecycle unit fixtures load the shipped entry, with explicitly controlled plugin-owned runtime doubles.
 * Full runtime bundling and shared module identity are verified by the SDK/built-plugin integration tests.
 * No factory is supplied through the production shared host service ABI.
 */
export async function canonicalManagerPluginFixture(name: string, ownedRuntime: unknown, implementation?: unknown) {
  const directory = path.resolve(`src/plugins/io.rabiroute.manager.${name}`);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "rabi.plugin.json"), "utf8")) as PluginManifest;
  const key = `__rabi_fixture_${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = implementation ?? { createOwnedRuntime: () => ownedRuntime };
  const runtime = `const implementation = globalThis[${JSON.stringify(key)}]; export const hostModules = []; export function createImplementation() { return implementation; }`;
  const runtimeUrl = "data:text/javascript;base64," + Buffer.from(runtime).toString("base64");
  let source = await fs.readFile(path.join(directory, "manager.mjs"), "utf8");
  source = source.replace('"./manager-runtime.mjs"', JSON.stringify(runtimeUrl))
    .replace('"@rabiroute/plugin-sdk"', JSON.stringify(pathToFileURL(path.resolve("plugins/contracts/plugin-sdk/index.mjs")).href));
  // Other entry-local lifecycle modules continue to use their canonical single source.
  source = source.replace(/(["'])(\.\/[^"']+\.mjs)\1/g, (_match, _quote, relative: string) => JSON.stringify(pathToFileURL(path.resolve(directory, relative)).href));
  source = (await transform(source, { loader: "js", format: "esm", define: { "import.meta.url": JSON.stringify(pathToFileURL(path.join(directory, "manager.mjs")).href) } })).code;
  try {
    const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as PluginModule;
    return { module, manifest, entry: path.join(directory, "manager.mjs"), ports: { async prepareModules() {} } };
  } finally { delete globals[key]; }
}
