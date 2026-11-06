import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { copyPluginPublicSource, isPluginRuntimeInput } from "../../plugins/contracts/plugin-sdk/public-source.mjs";
import { rewriteHostApiImports } from "../rewrite-built-host-api-imports.mjs";
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
async function exists(file) { try {
    await fs.access(file);
    return true;
}
catch (error) {
    if (error.code === "ENOENT")
        return false;
    throw error;
} }
/** Keep local modules separate: native services and lazy host namespaces need one identity. */
export async function buildInstanceAgentRuntime(root = process.cwd(), options = {}) {
    root = path.resolve(root);
    const output = path.resolve(options.outputDirectory ?? path.join(root, "apps/rabi-agent/runtime"));
    if (!inside(root, output))
        throw new Error("Remote Agent runtime output must remain in its workspace.");
    const packagesRoot = options.packagesRoot ?? path.join(root, "dist/plugins/packages");
    const profile = JSON.parse(await fs.readFile(options.profilePath ?? path.join(root, "dist/plugins/profiles/desktop.json"), "utf8"));
    const selected = [], hostModules = new Set();
    for (const instance of profile.instances) {
        const source = path.join(packagesRoot, encodeURIComponent(instance.package), instance.version);
        let descriptor;
        try {
            descriptor = JSON.parse(await fs.readFile(path.join(source, "agent-adapter.json"), "utf8"));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        const manifest = JSON.parse(await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8"));
        if (manifest.id !== instance.package || manifest.version !== instance.version || !manifest.entries?.manager || !manifest.provides.includes(descriptor.capability) || descriptor.manifest?.type !== descriptor.type)
            throw new Error(`Invalid remote Agent package: ${instance.package}.`);
        selected.push(instance);
        const runtimeEntries = ["runtime.mjs", "manager-runtime.mjs"];
        const buildSpec = path.join(source, "manager-runtime.build.json");
        if (await exists(buildSpec)) {
            for (const worker of JSON.parse(await fs.readFile(buildSpec, "utf8")).workers ?? []) {
                if (worker.mode === "host-factory") {
                    if (typeof worker.target !== "string" || !inside(source, path.resolve(source, worker.target))) throw new Error("Worker entry escapes its package.");
                    runtimeEntries.push(worker.target);
                }
            }
        }
        for (const name of runtimeEntries) {
            const file = path.join(source, name);
            if (!await exists(file))
                continue;
            const match = /export const hostModules = (\[[^;]*\]);/.exec(await fs.readFile(file, "utf8"));
            if (!match)
                throw new Error(`Missing native host dependencies: ${instance.package}/${name}.`);
            for (const id of JSON.parse(match[1]))
                hostModules.add(id);
        }
    }
    if (!selected.length)
        throw new Error("Build native Agent packages before building the remote runtime.");
    await fs.mkdir(path.dirname(output), { recursive: true });
    const stage = await fs.mkdtemp(path.join(path.dirname(output), ".agent-runtime-build-"));
    const backend = path.join(stage, "backend"), visited = new Set(), dependencies = new Set();
    const visit = async (file) => {
        file = path.resolve(file);
        if (visited.has(file))
            return;
        if (!inside(root, file))
            throw new Error(`Remote source escapes workspace: ${file}`);
        visited.add(file);
        const relative = path.relative(root, file), destination = path.join(backend, relative.replace(/\.ts$/, ".js"));
        if (!/\.[cm]?js$|\.ts$/.test(file)) {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(file, destination);
            return;
        }
        const original = await fs.readFile(file, "utf8");
        const transpiled = file.endsWith(".ts") ? ts.transpileModule(original, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : original;
        const contents = rewriteHostApiImports(transpiled, destination, path.join(backend, "src"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, contents);
        const parsed = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), imports = new Set(), moduleImports = new Set(), resourceCandidates = new Set();
        const addModule = specifier => { imports.add(specifier); moduleImports.add(specifier); };
        const inspect = node => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
                addModule(node.moduleSpecifier.text);
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]))
                addModule(node.arguments[0].text);
            const base = ts.isNewExpression(node) && node.arguments?.[1];
            const ownModuleUrl = base && ts.isPropertyAccessExpression(base) && base.name.text === "url" && ts.isMetaProperty(base.expression)
                && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword && base.expression.name.text === "meta";
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && ownModuleUrl) {
                const literal = value => { if (ts.isStringLiteral(value) && value.text.startsWith(".")) {
                    imports.add(value.text);
                    resourceCandidates.add(value.text);
                }
                else if (ts.isConditionalExpression(value)) {
                    literal(value.whenTrue);
                    literal(value.whenFalse);
                } };
                literal(node.arguments[0]);
            }
            ts.forEachChild(node, inspect);
        };
        inspect(parsed);
        for (const specifier of imports) {
            if (specifier.startsWith(".")) {
                let target = path.resolve(path.dirname(file), specifier);
                if (target !== root && !inside(root, target)) throw new Error(`Remote source escapes workspace: ${target}`);
                const resourceOnly = resourceCandidates.has(specifier) && !moduleImports.has(specifier);
                if (target.endsWith(".js") && await exists(target.slice(0, -3) + ".ts"))
                    target = target.slice(0, -3) + ".ts";
                if (!await exists(target)) {
                    if (resourceOnly)
                        continue;
                    throw new Error(`Missing remote dependency: ${relative} -> ${specifier}`);
                }
                if ((await fs.stat(target)).isDirectory()) {
                    if (resourceOnly) continue;
                    throw new Error(`Remote module dependency is a directory: ${relative} -> ${specifier}`);
                }
                await visit(target);
            }
            else if (!specifier.startsWith("node:"))
                dependencies.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
    };
    try {
        for (const entry of ["agentAdapters/instanceManagement", "agentAdapters/remoteAgentManager", "runtime/agentPluginRuntime", "runtime/agentAdapterHostPorts", "manager/agentManagerProviders", "manager/agentAdapterCatalogWorker"]) {
            await visit(path.join(root, "src", entry + ".ts"));
        }
        for (const id of hostModules) {
            if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id))
                throw new Error("Invalid remote host module ID.");
            await visit(path.join(root, "src", id + ".ts"));
        }
        const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        await fs.writeFile(path.join(backend, "package.json"), JSON.stringify({ name: "rabiroute-agent-native-runtime", version: packageJson.version, type: "module" }, null, 2) + "\n");
        const sdk = path.join(backend, "node_modules/@rabiroute/plugin-sdk");
        await fs.mkdir(path.dirname(sdk), { recursive: true });
        await copyPluginPublicSource(path.join(root, "plugins/contracts/plugin-sdk"), sdk, { replace: true, runtime: true });
        dependencies.delete("@rabiroute/plugin-sdk");
        const appPackage = JSON.parse(await fs.readFile(path.join(root, "apps/rabi-agent/package.json"), "utf8"));
        const missing = [...dependencies].filter(name => !appPackage.dependencies?.[name] && !appPackage.optionalDependencies?.[name]);
        if (missing.length)
            throw new Error(`Remote Agent dependencies must be declared: ${missing.sort().join(", ")}`);
        const nativePackages = path.join(stage, "plugins/packages");
        await fs.mkdir(nativePackages, { recursive: true });
        for (const instance of selected)
            await fs.cp(path.join(packagesRoot, encodeURIComponent(instance.package), instance.version), path.join(nativePackages, encodeURIComponent(instance.package), instance.version), { recursive: true });
        await fs.cp(path.join(root, "plugins/contracts"), path.join(stage, "plugins/contracts"), { recursive: true,
            filter: file => isPluginRuntimeInput(path.relative(root, file)) });
        await fs.mkdir(path.join(stage, "plugins/profiles"), { recursive: true });
        await fs.copyFile(path.join(root, "plugins/profiles/package-migrations.json"), path.join(stage, "plugins/profiles/package-migrations.json"));
        await fs.writeFile(path.join(stage, "agent-profile.json"), JSON.stringify({ ...profile, readyRequires: [], instances: selected }, null, 2) + "\n");
        await fs.writeFile(path.join(stage, "management.mjs"), [
            'export * from "./backend/src/agentAdapters/instanceManagement.js";',
            'export { mountRemoteAgentManager } from "./backend/src/agentAdapters/remoteAgentManager.js";',
            'export { mountAgentPluginRuntime } from "./backend/src/runtime/agentPluginRuntime.js";',
            'export { createAgentAdapterHostPorts } from "./backend/src/runtime/agentAdapterHostPorts.js";',
            'export { resolvePublishedAgentManagerProviders, invokeAgentManagerOperation } from "./backend/src/manager/agentManagerProviders.js";',
            'export { executeAgentAdapterCatalogWorkerTask } from "./backend/src/manager/agentAdapterCatalogWorker.js";'
        ].join("\n") + "\n");
        await fs.writeFile(path.join(stage, "native-runtime-build.json"), JSON.stringify({ schemaVersion: 1, packages: selected.map(instance => `${instance.package}@${instance.version}`), hostModules: [...hostModules].sort(), dependencies: [...dependencies].sort(), modules: [...visited].map(file => path.relative(root, file).replaceAll("\\", "/")).sort() }, null, 2) + "\n");
        const hooksRoot = options.hooksRoot ?? path.join(root, "dist/agent-hooks");
        const stagedHooks = path.join(stage, "agent-hooks");
        await fs.cp(hooksRoot, stagedHooks, { recursive: true });
        await fs.mkdir(output, { recursive: true });
        if (!inside(await fs.realpath(root), await fs.realpath(output)))
            throw new Error("Remote output resolves outside its workspace.");
        for (const name of ["backend", "plugins", "agent-profile.json", "management.mjs", "native-runtime-build.json"]) {
            const target = path.join(output, name);
            if (await exists(target) && (await fs.lstat(target)).isSymbolicLink())
                throw new Error("Remote output must not contain a symlink or junction.");
        }
        for (const name of ["backend", "plugins", "agent-profile.json", "management.mjs", "native-runtime-build.json"]) {
            await fs.rm(path.join(output, name), { recursive: true, force: true });
            await fs.rename(path.join(stage, name), path.join(output, name));
        }
        await fs.cp(stagedHooks, options.hooksOutputDirectory ?? path.join(root, "apps/rabi-agent/dist/agent-hooks"), { recursive: true, force: true });
        return { output, packages: selected.length, modules: visited.size };
    }
    finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}
