import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

async function exportedValues(source, file, inputs, visited = new Set()) {
  if (visited.has(file)) return [];
  visited.add(file);
  inputs.add(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();
  const binding = name => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (element.name) binding(element.name);
  };
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = path.resolve(path.dirname(file), statement.moduleSpecifier.text).replace(/\.js$/, ".ts");
      for (const name of await exportedValues(await fs.readFile(target, "utf8"), target, inputs, visited)) names.add(name);
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
    }
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) binding(declaration.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return [...names];
}

/** Platforms own their implementation; the bundle imports only shared host owners as ports. */
function platformSource(relative, specification) {
  if (specification.hostSources?.includes(relative)) return false;
  return relative.startsWith("src/adapters/")
    || relative.startsWith("src/messageEndpoints/")
    || specification.ownedSources?.includes(relative)
    || specification.ownedPrefixes?.some(prefix => relative.startsWith(prefix))
    || /^src\/(?:napcat|wecom|weixin|feishu|rabilink|wearable)[^/]*\.ts$/i.test(relative);
}

export async function bundleMessageEndpointRuntime(root, specification, outputFile, options = {}) {
  root = path.resolve(root);
  const modules = new Set();
  const inputs = new Set();
  const initializationImports = new Map();
  const entry = specification.exports
    ? specification.exports.map(item => `export { ${item.exportName ?? item.name} as ${item.name} } from ${JSON.stringify(path.join(root, item.source))};`).join("\n")
    : `export { ${specification.factory} as create } from ${JSON.stringify(path.join(root, specification.source))};`;
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: entry, resolveDir: root, sourcefile: "endpoint-entry.ts", loader: "ts" },
    bundle: true, write: false, platform: "node", format: "iife", globalName: "endpointImplementation", target: "node22", metafile: true,
    define: { "import.meta.url": "__endpointModuleUrl", ...(specification.scopedEnvironment ? { "process.env": "__endpointEnvironment" } : {}) },
    nodePaths: [path.join(options.dependencyRoot ?? root, "node_modules")],
    external: ["bufferutil", "utf-8-validate"],
    plugins: [{ name: "message-endpoint-host-owners", setup(builder) {
      builder.onResolve({ filter: /^\./ }, async args => {
        if (!args.importer || args.namespace === "endpoint-host-owner") return;
        const candidate = path.resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts");
        const relative = path.relative(root, candidate).replaceAll("\\", "/");
        if (!relative.startsWith("src/") || !candidate.endsWith(".ts") || platformSource(relative, specification)) return;
        const moduleId = relative.slice(4, -3);
        modules.add(moduleId);
        if (!initializationImports.has(args.importer)) initializationImports.set(args.importer, fs.readFile(args.importer, "utf8").then(source => {
          const importer = ts.createSourceFile(args.importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
          return new Set(importer.statements.filter(statement => ts.isImportDeclaration(statement) && !statement.importClause && ts.isStringLiteral(statement.moduleSpecifier))
            .map(statement => statement.moduleSpecifier.text));
        }));
        const explicitInitialization = (await initializationImports.get(args.importer)).has(args.path);
        // These virtual modules only read an already-owned namespace. An explicit
        // bare import retains initialization; unused value imports add no dependency.
        return { path: relative, namespace: "endpoint-host-owner", sideEffects: explicitInitialization };
      });
      builder.onLoad({ filter: /.*/, namespace: "endpoint-host-owner" }, async args => {
        const sourcePath = path.resolve(root, args.path);
        inputs.add(sourcePath);
        const moduleId = args.path.slice(4).replace(/\.ts$/, "");
        const values = await exportedValues(await fs.readFile(sourcePath, "utf8"), sourcePath, inputs);
        return { contents: `const owner = __endpointHostPorts.module(${JSON.stringify(moduleId)});\n${values.map(name => `export const ${name} = owner[${JSON.stringify(name)}];`).join("\n")}`, loader: "js" };
      });
    } }]
  });
  const emittedOwners = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([input, data]) => input.startsWith("endpoint-host-owner:") && data.bytesInOutput > 0)
    .map(([input]) => input.slice("endpoint-host-owner:src/".length).replace(/\.ts$/, ""))));
  const hostModules = [...modules].filter(id => emittedOwners.has(id)).sort();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith("endpoint-host-owner:") || input === "endpoint-entry.ts") continue;
    const absolute = path.resolve(root, input);
    if (!absolute.includes(`${path.sep}node_modules${path.sep}`)) inputs.add(absolute);
  }
  const contents = `// Generated from the endpoint-owned sources. Shared owners enter through host ports.\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const hostModules = ${JSON.stringify(hostModules)};\nexport function createImplementation(__endpointHostPorts) {\nconst __endpointModuleUrl = import.meta.url;\n${specification.scopedEnvironment ? "const __endpointEnvironment = Object.freeze({ ...process.env, ...__endpointHostPorts.environment });\n" : ""}${result.outputFiles[0].text}\nreturn endpointImplementation;\n}\n${specification.factory ? "export function createEndpoint(host) { return createImplementation(host).create(); }\n" : ""}`;
  if (outputFile) await fs.writeFile(outputFile, contents, "utf8");
  return { contents, hostModules, inputs: [...inputs].sort() };
}

/** A dedicated worker owns its whole process, so it bundles its own dependencies rather than host singletons. */
export async function bundleMessageEndpointWorker(root, specification, outputFile, options = {}) {
  const result = await build({ absWorkingDir: root, entryPoints: [path.join(root, specification.source)], bundle: true, write: false,
    platform: "node", format: "esm", target: "node22", metafile: true, nodePaths: [path.join(options.dependencyRoot ?? root, "node_modules")],
    external: ["bufferutil", "utf-8-validate"], banner: { js: 'import { createRequire as __endpointWorkerRequire } from "node:module"; const require = __endpointWorkerRequire(import.meta.url);' } });
  const inputs = Object.keys(result.metafile.inputs).map(input => path.resolve(root, input)).filter(input => !input.includes(`${path.sep}node_modules${path.sep}`));
  const contents = result.outputFiles[0].text;
  if (outputFile) await fs.writeFile(outputFile, contents, "utf8");
  return { contents, inputs };
}
