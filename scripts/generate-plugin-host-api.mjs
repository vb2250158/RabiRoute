import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function moduleId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) throw new Error(`Invalid public host module ID: ${value}`);
  if (value.startsWith("plugins/")) throw new Error(`Plugin implementation cannot be published as a shared host API: ${value}`);
  return value;
}

function packageName(specifier) {
  if (isBuiltin(specifier) || specifier.startsWith(".")) return;
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

async function publishGeneratedPackage(output, metadata, modules, declarations) {
  const candidate = await fs.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}-candidate-`));
  const backup = candidate + "-previous";
  try {
    // README, requested modules and other maintained package files retain their bytes.
    await fs.cp(output, candidate, { recursive: true });
    await fs.writeFile(path.join(candidate, "modules.json"), JSON.stringify({ schemaVersion: 1, modules }, null, 2) + "\n");
    await fs.writeFile(path.join(candidate, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
    if (declarations) {
      const typeRoot = path.join(candidate, "types");
      await fs.rm(typeRoot, { recursive: true, force: true });
      for (const [relative, contents] of declarations) {
        const file = path.join(typeRoot, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
      }
    }
    await fs.rename(output, backup);
    try { await fs.rename(candidate, output); }
    catch (error) {
      try { await fs.rename(backup, output); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Host API publication failed; previous package is retained at ${backup}`); }
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

/** Host-side publication only. Plugin builds consume its output and never read these source files. */
export async function generatePluginHostApi(root, options = {}) {
  root = path.resolve(root);
  const output = path.resolve(options.outputDirectory ?? path.join(root, "plugins/contracts/host-api"));
  const requested = options.moduleIds ?? JSON.parse(await fs.readFile(options.modulesFile ?? path.join(output, "requested-modules.json"), "utf8"));
  const ids = [...new Set((Array.isArray(requested) ? requested : Object.keys(requested.modules ?? requested)).map(moduleId))].sort();
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(ids.map(id => path.join(root, "src", id + ".ts")), { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const modules = {};
  for (const id of ids) {
    const source = program.getSourceFile(path.join(root, "src", id + ".ts"));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`Public host source module is unavailable: ${id}`);
    const exports = checker.getExportsOfModule(symbol).filter(item => {
      const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      return Boolean(target.flags & ts.SymbolFlags.Value);
    }).map(item => item.name).sort();
    modules[id] = { exports };
  }
  const packageFile = path.join(output, "package.json");
  const metadata = JSON.parse(await fs.readFile(packageFile, "utf8"));
  metadata.exports = { "./modules.json": "./modules.json", ...Object.fromEntries(ids.map(id => ["./" + id, { types: `./types/src/${id}.d.ts` }])) };
  if (options.signaturesOnly) {
    await publishGeneratedPackage(output, metadata, modules);
    return { modules: ids.length, declarations: 0, signaturesOnly: true };
  }

  const declarations = path.resolve(root, options.declarationsDirectory ?? "dist/host-api-types");
  const queue = ids.map(id => ({ projectPath: `src/${id}.d.ts`, input: path.join(declarations, id + ".d.ts") }));
  const copied = new Map();
  const dependencies = new Set();
  while (queue.length) {
    const item = queue.pop();
    if (copied.has(item.projectPath)) continue;
    if (!await exists(item.input)) throw new Error(`Emit the host declaration closure before publishing its API: ${item.input}`);
    const contents = await fs.readFile(item.input, "utf8");
    copied.set(item.projectPath, contents);
    const source = ts.createSourceFile(item.projectPath, contents, ts.ScriptTarget.Latest, true);
    const specifiers = new Set();
    function inspect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifiers.add(node.argument.literal.text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        const name = packageName(specifier);
        if (name === "@rabiroute/host-api") {
          const publicPath = specifier === name ? "." : "." + specifier.slice(name.length);
          if (!Object.hasOwn(metadata.exports, publicPath)) {
            throw new Error(`Public declaration ${item.projectPath} references unpublished host API module: ${specifier}. Request that public module explicitly or use a relative declaration import for private types.`);
          }
        } else if (name && name !== "@rabiroute/plugin-sdk") dependencies.add(name);
        continue;
      }
      const suffix = specifier.endsWith(".mjs") ? ".d.mts" : specifier.endsWith(".cjs") ? ".d.cts" : ".d.ts";
      const relative = specifier.replace(/\.(?:mjs|cjs|js|ts)$/, "") + suffix;
      const projectPath = path.posix.normalize(path.posix.join(path.posix.dirname(item.projectPath), relative));
      if (projectPath.startsWith("../") || path.posix.isAbsolute(projectPath)) throw new Error(`Public declaration escapes its project namespace: ${specifier}`);
      let input = projectPath.startsWith("src/") ? path.join(declarations, projectPath.slice(4)) : path.join(root, projectPath);
      if (!await exists(input) && await exists(path.join(root, projectPath))) input = path.join(root, projectPath);
      queue.push({ projectPath, input });
    }
  }
  const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  metadata.dependencies = { "@types/node": rootPackage.devDependencies?.["@types/node"] ?? "^22.10.7" };
  for (const name of dependencies) {
    const version = rootPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name] ?? rootPackage.optionalDependencies?.[name];
    if (!version) throw new Error(`Public declaration dependency needs a publishable package version: ${name}`);
    metadata.dependencies[name] = version;
    const typesPackage = "@types/" + (name.startsWith("@") ? name.slice(1).replace("/", "__") : name);
    if (rootPackage.devDependencies?.[typesPackage]) metadata.dependencies[typesPackage] = rootPackage.devDependencies[typesPackage];
  }
  for (const [name, version] of Object.entries(metadata.dependencies)) {
    if (typeof version !== "string" || !version.trim() || /^(?:file:|link:|workspace:|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(version)) {
      throw new Error(`Public declaration dependency needs a publishable package version: ${name}`);
    }
  }
  await publishGeneratedPackage(output, metadata, modules, copied);
  return { modules: ids.length, declarations: copied.size, signaturesOnly: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const result = await generatePluginHostApi(value("--root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), {
    modulesFile: value("--modules-file"), declarationsDirectory: value("--declarations"), outputDirectory: value("--output"), signaturesOnly: args.includes("--signatures-only")
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
