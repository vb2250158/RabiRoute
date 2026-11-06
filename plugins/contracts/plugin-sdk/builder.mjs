#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { copyPluginPublicSource } from "./public-source.mjs";
import ts from "typescript";

const require = createRequire(import.meta.url);
const hostPrefix = "@rabiroute/host-api/";

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function localSource(root, id, value) {
  const prefix = `src/plugins/${id}/`;
  const relative = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error(`Plugin source must belong to ${id}: ${value}`);
  return file;
}

async function dependencyBoundary(pluginRoot) {
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; metadata = {}; }
  const declared = new Set(Object.keys({ ...metadata.dependencies, ...metadata.devDependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies }));
  const resolving = Symbol("owned-plugin-resolution");
  const packageNames = new Map();
  const inNodeModules = file => path.relative(pluginRoot, file).split(path.sep).some(part => part.toLowerCase() === "node_modules");
  async function dependencyName(file) {
    const parts = file.split(path.sep);
    const index = parts.map(part => part.toLowerCase()).lastIndexOf("node_modules");
    if (index >= 0) return parts[index + 1]?.startsWith("@") ? parts.slice(index + 1, index + 3).join("/") : parts[index + 1];
    // Linked packages resolve to their real source directory, outside node_modules.
    let directory = path.dirname(file);
    const visited = [];
    let name;
    for (;;) {
      if (packageNames.has(directory)) { name = packageNames.get(directory); break; }
      visited.push(directory);
      try { name = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")).name; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (name || path.dirname(directory) === directory) break;
      directory = path.dirname(directory);
    }
    for (const directory of visited) packageNames.set(directory, name);
    return name;
  }
  return { name: "owned-plugin-dependencies", setup(builder) {
    builder.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.[resolving] || !args.importer || args.namespace !== "file" || !inside(pluginRoot, args.importer) || inNodeModules(args.importer)
        || args.path.startsWith(hostPrefix) || isBuiltin(args.path)) return;
      const resolved = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir,
        kind: args.kind, namespace: args.namespace, pluginData: { [resolving]: true } });
      if (resolved.errors.length) return resolved;
      if (resolved.external && isBuiltin(resolved.path)) return { ...resolved, pluginData: args.pluginData };
      const local = inside(pluginRoot, resolved.path);
      const relativeOrAbsolute = args.path.startsWith(".") || path.isAbsolute(args.path);
      if (!resolved.external && !local && relativeOrAbsolute) {
        throw new Error(`Plugin imports outside its source folder: ${args.path}. Use @rabiroute/host-api/<moduleId> for shared host dependencies.`);
      }
      if (!local || inNodeModules(resolved.path)) {
        const dependency = resolved.external
          ? resolved.path.startsWith("@") ? resolved.path.split("/").slice(0, 2).join("/") : resolved.path.split("/")[0]
          : await dependencyName(resolved.path);
        if (!dependency || !declared.has(dependency)) throw new Error(`Declare direct plugin dependency in package.json: ${dependency ?? args.path}`);
      }
      // The recursive resolution marker belongs to this lookup, not subsequent imports.
      return { ...resolved, pluginData: args.pluginData };
    });
  } };
}

/** Preserve each owned module's URL and descriptor-mapped worker/resource URLs after bundling. */
export function transformPluginSourceUrls(contents, { file, pluginRoot, outputModule = "manager-runtime.mjs", workers = [], resources = [], packageId, runtimeFactory = true, runtimeModuleUrlIdentifier = "__pluginModuleUrl" }) {
  const kind = /[.]tsx$/.test(file) ? ts.ScriptKind.TSX : /[.]jsx$/.test(file) ? ts.ScriptKind.JSX : /[.]ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, kind);
  const meta = node => ts.isPropertyAccessExpression(node) && ["url", "dirname", "filename"].includes(node.name.text) && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === "meta";
  const metaUrl = node => meta(node) && node.name.text === "url";
  const mappings = [...workers, ...resources].map(item => ({ source: localSource(pluginRoot, packageId, item.source), target: item.target }));
  const fromOutput = target => path.relative(path.dirname(path.resolve(pluginRoot, outputModule)), path.resolve(pluginRoot, target)).replaceAll("\\", "/");
  const nativeBase = () => runtimeFactory ? ts.factory.createIdentifier(runtimeModuleUrlIdentifier)
    : ts.factory.createPropertyAccessExpression(ts.factory.createMetaProperty(ts.SyntaxKind.ImportKeyword, ts.factory.createIdentifier("meta")), "url");
  const url = relative => ts.factory.createNewExpression(ts.factory.createIdentifier("URL"), undefined, [ts.factory.createStringLiteral(relative), nativeBase()]);
  const mappedTarget = node => {
    if (ts.isParenthesizedExpression(node)) return mappedTarget(node.expression);
    if (ts.isConditionalExpression(node)) {
      const left = mappedTarget(node.whenTrue), right = mappedTarget(node.whenFalse);
      return left && left === right ? left : undefined;
    }
    if (!ts.isStringLiteralLike(node)) return;
    const target = path.resolve(path.dirname(file), node.text);
    return mappings.find(item => item.source === target || item.source === target.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts"))?.target;
  };
  const compiledFile = file.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.[jt]sx?$/, ".js");
  const sourceUrl = () => url(fromOutput(path.relative(pluginRoot, compiledFile)));
  let changed = false, fileHelpers = false;
  const result = ts.transform(source, [context => {
    const visit = node => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2
        && metaUrl(node.arguments[1])) {
        const target = mappedTarget(node.arguments[0]);
        if (target) { changed = true; return url(fromOutput(target)); }
      }
      if (meta(node)) {
        changed = true;
        if (node.name.text === "url") return ts.factory.createPropertyAccessExpression(sourceUrl(), "href");
        // Node's file URL conversion handles drive letters and escaped path segments.
        fileHelpers = true;
        const filename = ts.factory.createCallExpression(ts.factory.createIdentifier("__pluginFileURLToPath"), undefined, [sourceUrl()]);
        return node.name.text === "filename" ? filename : ts.factory.createCallExpression(ts.factory.createIdentifier("__pluginDirname"), undefined, [filename]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit);
  }]);
  const output = (fileHelpers ? 'import { fileURLToPath as __pluginFileURLToPath } from "node:url"; import { dirname as __pluginDirname } from "node:path";\n' : "") + (changed ? ts.createPrinter().printFile(result.transformed[0]) : contents);
  result.dispose();
  return output;
}

function sourceUrlPlugin(pluginRoot, specification, { packageId, outputModule, runtimeFactory }) {
  return { name: "owned-plugin-source-urls", setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|[jt]sx?)$/, namespace: "file" }, async args => {
      if (!inside(pluginRoot, args.path) || args.path.split(path.sep).includes("node_modules")) return;
      const source = await fs.readFile(args.path, "utf8");
      const contents = transformPluginSourceUrls(source, { file: args.path, pluginRoot, packageId, outputModule,
        runtimeFactory, workers: specification.workers, resources: specification.resources });
      return { contents, loader: /\.tsx$/.test(args.path) ? "tsx" : /\.jsx$/.test(args.path) ? "jsx" : /\.[cm]?ts$/.test(args.path) ? "ts" : "js", resolveDir: path.dirname(args.path) };
    });
  } };
}

/** Compile owned implementation; host module names come solely from the published API package. */
export async function bundlePluginRuntime(pluginRoot, specification, { packageId, hostApiPath, outputModule = "manager-runtime.mjs" } = {}) {
  pluginRoot = path.resolve(pluginRoot);
  const api = JSON.parse(await fs.readFile(hostApiPath ?? require.resolve("@rabiroute/host-api/modules.json"), "utf8"));
  if (api.schemaVersion !== 1 || !api.modules) throw new Error("Host API export manifest is invalid.");
  const modules = new Set();
  const exports = specification.exports ?? [{ source: specification.source, name: "create", exportName: specification.factory }];
  const entry = specification.exportAllSource
    ? `export * from ${JSON.stringify(localSource(pluginRoot, packageId, specification.exportAllSource))};`
    : exports.map(item => `export { ${item.exportName ?? item.name} as ${item.name} } from ${JSON.stringify(item.hostModule ? hostPrefix + item.hostModule : localSource(pluginRoot, packageId, item.source))};`).join("\n");
  const result = await build({
    absWorkingDir: pluginRoot, stdin: { contents: entry, resolveDir: pluginRoot, sourcefile: "plugin-owned-entry.ts", loader: "ts" },
    bundle: true, write: false, platform: "node", format: "iife", globalName: "pluginImplementation", target: "node22", metafile: true,
    define: { "import.meta.url": "__pluginModuleUrl", ...(specification.scopedEnvironment ? { "process.env": "__pluginEnvironment" } : {}) },
    external: ["bufferutil", "utf-8-validate"],
    plugins: [sourceUrlPlugin(pluginRoot, specification, { packageId, outputModule, runtimeFactory: true }), { name: "published-rabiroute-host-api", setup(builder) {
      builder.onResolve({ filter: /^@rabiroute\/host-api\// }, args => {
        const id = args.path.slice(hostPrefix.length);
        if (!Object.hasOwn(api.modules, id)) throw new Error(`Shared host API module is not published: ${id}`);
        modules.add(id);
        return { path: id, namespace: "rabiroute-host-api" };
      });
      builder.onLoad({ filter: /.*/, namespace: "rabiroute-host-api" }, args => {
        const names = api.modules[args.path].exports;
        if (!Array.isArray(names)) throw new Error(`Shared host export signature is invalid: ${args.path}`);
        return { loader: "js", contents: `const owner = __pluginHostPorts.module(${JSON.stringify(args.path)});\n${names.map(name => name === "default" ? "export default owner.default;" : `export const ${name} = owner[${JSON.stringify(name)}];`).join("\n")}` };
      });
    } }, await dependencyBoundary(pluginRoot)]
  });
  const used = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([name, input]) => name.startsWith("rabiroute-host-api:") && input.bytesInOutput > 0)
    .map(([name]) => name.slice("rabiroute-host-api:".length))));
  const hostModules = [...modules].filter(id => used.has(id)).sort();
  return {
    hostModules,
    inputs: Object.keys(result.metafile.inputs).filter(name => !name.startsWith("rabiroute-host-api:") && name !== "plugin-owned-entry.ts"),
    contents: `// Built from this plugin and published host API signatures.\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const hostModules = ${JSON.stringify(hostModules)};\nexport function createImplementation(__pluginHostPorts) {\nconst __pluginModuleUrl = import.meta.url;\n${specification.scopedEnvironment ? "const __pluginEnvironment = Object.freeze({ ...process.env, ...__pluginHostPorts.environment });\n" : ""}${result.outputFiles[0].text}\nreturn pluginImplementation;\n}\n${specification.factory ? "export function createEndpoint(host) { return createImplementation(host).create(); }\n" : ""}`
  };
}

/** Build one independently checked-out plugin without a RabiRoute source checkout. */
export async function buildPluginPackage({ pluginRoot = process.cwd(), outputDirectory, hostApiPath } = {}) {
  pluginRoot = path.resolve(pluginRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "rabi.plugin.json"), "utf8"));
  const destination = path.resolve(outputDirectory ?? path.join(pluginRoot, "dist"));
  if (destination === pluginRoot || inside(destination, pluginRoot)) throw new Error("Plugin output cannot replace its source folder.");
  if (inside(pluginRoot, destination) && path.dirname(destination) !== pluginRoot) throw new Error("Use a direct output subfolder or a directory outside the plugin source.");
  const ownedOutput = async () => {
    if (!await exists(destination)) return false;
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(path.join(destination, "build-evidence.json"), "utf8")); } catch { /* Unknown directories are never replaced. */ }
    if (receipt?.packageId !== manifest.id || receipt?.outputDirectory !== destination) throw new Error(`Plugin output already exists without this plugin's build receipt: ${destination}`);
    return true;
  };
  const replacing = await ownedOutput();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const output = await fs.mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}-candidate-`));
  let backup;
  try {
    await copyPluginPublicSource(pluginRoot, output, { replace: true, runtime: true });
    const runtimeEvidence = [];
    for (const name of ["runtime.build.json", "manager-runtime.build.json", "egress-runtime.build.json"]) {
      const file = path.join(pluginRoot, name);
      if (!await exists(file)) continue;
      const specification = JSON.parse(await fs.readFile(file, "utf8"));
      const bundle = await bundlePluginRuntime(pluginRoot, specification, { packageId: manifest.id, hostApiPath });
      await fs.writeFile(path.join(output, name.replace(".build.json", ".mjs")), bundle.contents);
      runtimeEvidence.push({ descriptor: name, hostModules: bundle.hostModules, inputs: bundle.inputs });
      for (const resource of specification.resources ?? []) {
        const target = path.resolve(output, resource.target);
        if (!inside(output, target)) throw new Error(`Resource output escapes its plugin: ${resource.target}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.cp(localSource(pluginRoot, manifest.id, resource.source), target, { recursive: true });
      }
      for (const worker of specification.workers ?? []) {
        const target = path.resolve(output, worker.target);
        if (!inside(output, target)) throw new Error(`Worker output escapes its plugin: ${worker.target}`);
        if (worker.mode === "host-factory") {
          const bundled = await bundlePluginRuntime(pluginRoot, { exportAllSource: worker.source,
            scopedEnvironment: specification.scopedEnvironment, resources: specification.resources },
          { packageId: manifest.id, hostApiPath, outputModule: worker.target });
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, bundled.contents);
          runtimeEvidence.push({ descriptor: `${name}#${worker.target}`, hostModules: bundled.hostModules, inputs: bundled.inputs });
          continue;
        }
        const workerBuild = await build({ absWorkingDir: pluginRoot, entryPoints: [localSource(pluginRoot, manifest.id, worker.source)],
          bundle: true, write: false, platform: "node", format: "esm", target: "node22",
          external: ["bufferutil", "utf-8-validate"],
          banner: { js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);' },
          plugins: [sourceUrlPlugin(pluginRoot, specification, { packageId: manifest.id, outputModule: worker.target, runtimeFactory: false }), await dependencyBoundary(pluginRoot),
            { name: "worker-host-boundary", setup(builder) { builder.onResolve({ filter: /^@rabiroute\/host-api\// }, args => { throw new Error(`Worker requires a process-local API instead of main-process host ports: ${args.path}`); }); } }] });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, workerBuild.outputFiles[0].text);
      }
    }
    const sdkSource = path.dirname(fileURLToPath(import.meta.url));
    const sdkTarget = path.join(output, ".rabi-deps", "plugin-sdk");
    let sdkUsed = false;
    for (const entry of Object.values(manifest.entries ?? {})) {
      if (!entry.module) continue;
      const file = path.resolve(output, entry.module);
      if (!inside(output, file)) throw new Error("Plugin entry escapes its output folder.");
      if (!await exists(file)) continue;
      const source = await fs.readFile(file, "utf8");
      let relative = path.relative(path.dirname(file), path.join(sdkTarget, "index.mjs")).replaceAll("\\", "/");
      if (!relative.startsWith("./") && !relative.startsWith("../")) relative = "./" + relative;
      const changed = source.replace(/(["'])@rabiroute\/plugin-sdk\1/g, (_, quote) => `${quote}${relative}${quote}`);
      if (changed !== source) { sdkUsed = true; await fs.writeFile(file, changed); }
    }
    if (sdkUsed) {
      await fs.mkdir(sdkTarget, { recursive: true });
      for (const name of ["index.mjs", "index.d.ts", "publication.mjs", "publication.d.ts", "api-operation-contract.d.ts", "package.json"]) {
        await fs.copyFile(path.join(sdkSource, name), path.join(sdkTarget, name));
      }
    }
    const evidence = { packageId: manifest.id, version: manifest.version, outputDirectory: destination, runtimes: runtimeEvidence };
    await fs.writeFile(path.join(output, "build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    if (replacing) {
      await ownedOutput();
      backup = output + "-previous";
      await fs.rename(destination, backup);
    }
    try { await fs.rename(output, destination); }
    catch (error) { if (backup) await fs.rename(backup, destination); throw error; }
    if (backup) await fs.rm(backup, { recursive: true, force: true });
    return evidence;
  } catch (error) {
    // Only this invocation's staging directory is removed; a failed rebuild keeps the previous output.
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const result = await buildPluginPackage({ pluginRoot: value("--root"), outputDirectory: value("--output"), hostApiPath: value("--host-api") });
  process.stdout.write(JSON.stringify(result) + "\n");
}
