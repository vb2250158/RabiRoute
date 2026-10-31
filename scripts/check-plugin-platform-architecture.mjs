import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { skipArchitectureDirectory } from "./lib/architecture-scan-boundary.mjs";
import { hasReleasablePluginScope, kernelImportViolations, publicationPackageViolations, relativeModuleSpecifiers } from "./lib/plugin-platform-contract.mjs";

const root = process.cwd();
const activeRoots = ["src", "scripts", "plugins", "ribiwebgui", "desktop"];
const forbidden = [
  ["rabi", "manager", "base"].join("."),
  ["manager", "Base", "Plugin", "Activation"].join(""),
  ["context", "services", "activate"].join("."),
  ["manager", "Plugins"].join(""),
  ["rabi", "manager", "builtin"].join("."),
  ["initialize", "Manager", "Plugin", "Profile"].join(""),
  ["resolve", "Manager", "Plugin", "Profile"].join(""),
  ["update", "From", "Reconciliation"].join(""),
  ["sync-rabi-manager-base", "web-bundle"].join("-")
];
const removedPaths = [
  "plugins/packages",
  "src/manager/managerPluginConfig.ts",
  "src/manager/managerPluginPackageLoader.ts",
  "src/manager/managerPluginRuntimeHost.ts",
  "src/manager/pluginProfile.ts",
  "src/runtime/managerPluginRuntime.ts",
  "src/runtime/managerPluginReconciler.ts",
  "src/runtime/pluginBundle.ts",
  "src/runtime/pluginCatalog.ts",
  "src/runtime/processManagerPlugin.ts",
  "src/runtime/processPluginHost.ts",
  "src/runtime/processPluginProtocol.ts",
  "ribiwebgui/src/bundles/rabiManagerBaseClient.ts"
];

async function exists(target) {
  try { await fs.stat(path.join(root, target)); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function filesRecursively(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!await exists(relativeRoot)) return [];
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && skipArchitectureDirectory(entry.name, path.relative(root, absolute))) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(absoluteRoot);
  return result;
}

function relative(file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

async function packageModuleSources(entryPath, packageRoot) {
  const realRoot = await fs.realpath(packageRoot);
  const modules = new Map();
  const pending = [entryPath];
  while (pending.length) {
    const file = pending.pop();
    const name = path.relative(packageRoot, file).replace(/\\/g, "/");
    if (modules.has(name)) continue;
    const realRelative = path.relative(realRoot, await fs.realpath(file));
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) continue;
    const source = await fs.readFile(file, "utf8");
    modules.set(name, source);
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      const packageRelative = path.relative(packageRoot, target);
      if (!packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative)
        || !/[.](?:mjs|js|ts)$/.test(target)) continue;
      const targetStat = await fs.lstat(target).catch(() => undefined);
      if (targetStat?.isFile() && !targetStat.isSymbolicLink()) pending.push(target);
    }
  }
  return modules;
}

const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".py", ".md"]);
const activeFiles = (await Promise.all(activeRoots.map(filesRecursively))).flat();
const violations = [];
const diagnostics = [];
for (const file of activeFiles) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  if (relative(file) === "scripts/check-plugin-platform-architecture.mjs") continue;
  const source = await fs.readFile(file, "utf8");
  for (const value of forbidden) if (source.includes(value)) violations.push(`${relative(file)} contains removed identifier ${value}`);
}
for (const target of removedPaths) if (await exists(target)) violations.push(`Removed path still exists: ${target}`);

for (const file of await filesRecursively("src/plugin-kernel")) {
  if (!/[.](?:ts|js|mjs)$/.test(file) || file.endsWith(".test.ts")) continue;
  const source = await fs.readFile(file, "utf8");
  violations.push(...kernelImportViolations(relative(file), source));
}

const sdkRoot = path.join(root, "plugins", "contracts", "plugin-sdk");
violations.push(...publicationPackageViolations(
  JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8")),
  await fs.readFile(path.join(sdkRoot, "publication.mjs"), "utf8"),
  await fs.readFile(path.join(sdkRoot, "publication.d.ts"), "utf8")
));

const builtinRoot = path.join(root, "plugins", "builtin");
const packageDirectories = (await fs.readdir(builtinRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
const profilePath = path.join(root, "plugins", "profiles", "desktop.json");
const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
const selectedBuiltins = new Map((profile.instances ?? []).map(instance => [instance.package, instance]));
const allowedManifestFields = new Set(["schemaVersion", "id", "version", "entries", "provides", "requires", "optional", "permissions", "configSchema", "stateSchemaVersion"]);
for (const packageEntry of packageDirectories) {
  const selected = selectedBuiltins.get(packageEntry.name);
  if (!selected || typeof selected.version !== "string") {
    violations.push(`${packageEntry.name} has no selected desktop profile version`);
    continue;
  }
  const versionRoot = path.join(builtinRoot, packageEntry.name, selected.version);
  const manifestPath = path.join(versionRoot, "rabi.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 2) violations.push(`${relative(manifestPath)} must use plugin manifest schema 2`);
  const unknownFields = Object.keys(manifest).filter(field => !allowedManifestFields.has(field));
  if (unknownFields.length) violations.push(`${relative(manifestPath)} contains removed manifest fields: ${unknownFields.join(", ")}`);
  if (manifest.id !== packageEntry.name) violations.push(`${relative(manifestPath)} package identity mismatch`);
  const managerEntry = manifest.entries?.manager;
  if (!managerEntry || !["in_process", "isolated", "declarative"].includes(managerEntry.execution)) {
    violations.push(`${relative(manifestPath)} has no valid Manager entry`);
  }
  for (const [host, entry] of Object.entries(manifest.entries ?? {})) {
    if (!entry || typeof entry !== "object" || !["in_process", "isolated", "declarative"].includes(entry.execution)) {
      violations.push(`${relative(manifestPath)} has an invalid ${host} execution entry`);
      continue;
    }
    const allowedEntryFields = entry.execution === "declarative"
      ? new Set(["execution", "resource"])
      : new Set(["execution", "module"]);
    const invalidEntryFields = Object.keys(entry).filter(field => !allowedEntryFields.has(field));
    if (invalidEntryFields.length) violations.push(`${relative(manifestPath)} has forbidden ${host} entry fields: ${invalidEntryFields.join(", ")}`);
  }
  if (managerEntry?.execution !== "declarative" && typeof managerEntry?.module === "string") {
    const managerPath = path.join(versionRoot, managerEntry.module);
    const managerSource = await fs.readFile(managerPath, "utf8");
    const imports = [...managerSource.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    for (const specifier of imports) {
      if (specifier === "@rabiroute/plugin-sdk" || specifier.startsWith("node:")) continue;
      const target = path.resolve(path.dirname(managerPath), specifier);
      const packageRelative = path.relative(versionRoot, target);
      if (!specifier.startsWith("./") || !packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative)) {
        violations.push(`${relative(managerPath)} imports outside its package and shared SDK: ${specifier}`);
      } else {
        const targetStat = await fs.lstat(target).catch(() => undefined);
        if (!targetStat?.isFile() || targetStat.isSymbolicLink()) violations.push(`${relative(managerPath)} imports a missing or linked package module: ${specifier}`);
      }
    }
    if (!managerSource.includes("definePlugin(")) violations.push(`${relative(managerPath)} does not use definePlugin`);
    if (!hasReleasablePluginScope(managerSource, {
      modules: await packageModuleSources(managerPath, versionRoot),
      fileName: path.relative(versionRoot, managerPath).replace(/\\/g, "/")
    })) diagnostics.push(`${relative(managerPath)}: no local releasable scope was identified by source inspection; confirm its actual resource owner with lifecycle tests.`);
  }
}

if (Object.keys(profile).some(field => !["schemaVersion", "readyRequires", "instances"].includes(field))) violations.push("desktop profile contains unsupported top-level fields");
if (profile.schemaVersion !== 2) violations.push("desktop profile must use schema 2");
if (!Array.isArray(profile.readyRequires) || !profile.readyRequires.includes("manager.core@1")) violations.push("desktop profile must declare manager.core@1 readiness");
if (!Array.isArray(profile.instances) || profile.instances.length !== packageDirectories.length) violations.push("desktop profile must select every built-in package exactly once");
if (new Set(profile.instances?.map(instance => instance.package)).size !== profile.instances?.length) violations.push("desktop profile contains duplicate packages");

const packageLoaderSource = await fs.readFile(path.join(root, "src", "plugin-kernel", "packageLoader.ts"), "utf8");
if (/\bimport\s*\(\s*pathToFileURL\s*\(entryPath\)/.test(packageLoaderSource)) {
  violations.push("packageLoader imports plugin code before execution policy selection");
}
for (const target of [
  "src/plugin-runtime-host/main.ts",
  "src/plugin-runtime-host/executor.ts",
  "src/plugin-runtime-host/protocol.ts",
  "src/runtime/processLeaseRegistry.ts"
]) if (!await exists(target)) violations.push(`Plugin lifecycle runtime is missing: ${target}`);

for (const file of await filesRecursively("src")) {
  if (!/[.]ts$/.test(file) || file.endsWith(".test.ts")) continue;
  const source = await fs.readFile(file, "utf8");
  if (source.includes("io.rabiroute.manager.")) violations.push(`${relative(file)} branches on a concrete built-in package ID`);
}

// Local source inspection cannot prove the absence of a parent-owned resource.
// Keep this heuristic visible without inventing a second lifecycle admission gate.
if (diagnostics.length) console.warn(diagnostics.map(value => `Warning: ${value}`).join("\n"));
if (violations.length) {
  console.error(violations.map(value => `- ${value}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Plugin platform architecture check passed for ${packageDirectories.length} built-in packages.`);
}
