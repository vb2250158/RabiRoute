import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { bundleMessageEndpointRuntime } from "./build-message-endpoint-runtime.mjs";
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

/** Read physical modules or compile outputs declared by the same descriptors consumed by the packager. */
export function packageModuleSourceReader(packageRoot, buildRoot = root) {
  const reads = new Map();
  const inside = (directory, file) => {
    const value = path.relative(directory, file);
    return value !== "" && !value.startsWith("..") && !path.isAbsolute(value);
  };
  const physical = async file => {
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (!inside(await fs.realpath(packageRoot), await fs.realpath(file))) return null;
    return fs.readFile(file, "utf8");
  };
  return file => {
    file = path.resolve(file);
    if (!reads.has(file)) reads.set(file, (async () => {
      if (!inside(packageRoot, file)) return;
      const source = await physical(file);
      if (source !== undefined) return source ?? undefined;
      // These are output mappings from build-plugin-packages, not exemptions for missing files.
      const descriptorName = ["runtime.build.json", "manager-runtime.build.json", "egress-runtime.build.json"].find(name =>
        path.resolve(packageRoot, name.replace(".build.json", ".mjs")) === file);
      if (!descriptorName) return;
      const descriptor = await physical(path.join(packageRoot, descriptorName));
      if (descriptor == null) return;
      const specification = JSON.parse(descriptor);
      if (!specification || typeof specification !== "object" || Array.isArray(specification)
        || !(Array.isArray(specification.exports) ? specification.exports.length > 0 : typeof specification.source === "string" && typeof specification.factory === "string")) {
        throw new Error(`Invalid generated runtime descriptor: ${descriptorName}`);
      }
      // No output path: compile the real implementation and dependencies without touching source or dist.
      return (await bundleMessageEndpointRuntime(buildRoot, specification)).contents;
    })());
    return reads.get(file);
  };
}

async function packageModuleSources(entryPath, packageRoot, readSource = packageModuleSourceReader(packageRoot)) {
  const modules = new Map();
  const pending = [entryPath];
  while (pending.length) {
    const file = pending.pop();
    const name = path.relative(packageRoot, file).replace(/\\/g, "/");
    if (modules.has(name)) continue;
    const source = await readSource(file);
    if (source === undefined) continue;
    modules.set(name, source);
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      const packageRelative = path.relative(packageRoot, target);
      if (!packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative)
        || !/[.](?:mjs|js|ts)$/.test(target)) continue;
      if (await readSource(target) !== undefined) pending.push(target);
    }
  }
  return modules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
const installedVersions = (await Promise.all(packageDirectories.map(async entry => {
  const versions = await fs.readdir(path.join(builtinRoot, entry.name), { withFileTypes: true });
  return versions.filter(version => version.isDirectory()).map(version => ({ name: entry.name, version: version.name }));
}))).flat();
const installedVersionKeys = new Set(installedVersions.map(entry => JSON.stringify([entry.name, entry.version])));
const allowedManifestFields = new Set(["schemaVersion", "id", "version", "displayName", "description", "icon", "entries", "provides", "requires", "optional", "permissions", "configSchema", "stateSchemaVersion"]);
// Installed compatibility packages can be omitted from the default profile.
// Their source contracts still receive the same validation as selected packages.
for (const packageEntry of installedVersions) {
  const versionRoot = path.join(builtinRoot, packageEntry.name, packageEntry.version);
  const manifestPath = path.join(versionRoot, "rabi.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 2) violations.push(`${relative(manifestPath)} must use plugin manifest schema 2`);
  const unknownFields = Object.keys(manifest).filter(field => !allowedManifestFields.has(field));
  if (unknownFields.length) violations.push(`${relative(manifestPath)} contains removed manifest fields: ${unknownFields.join(", ")}`);
  if (manifest.id !== packageEntry.name || manifest.version !== packageEntry.version) violations.push(`${relative(manifestPath)} package identity mismatch`);
  for (const [field, maximum] of [["displayName", 160], ["description", 2000], ["icon", 160]]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value.trim())
      || (field === "icon" && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.trim()))) {
      violations.push(`${relative(manifestPath)} has an invalid ${field}`);
    }
  }
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
    try {
    const managerPath = path.join(versionRoot, managerEntry.module);
    const readSource = packageModuleSourceReader(versionRoot);
    const managerSource = await fs.readFile(managerPath, "utf8");
    const imports = [...managerSource.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    for (const specifier of imports) {
      if (specifier === "@rabiroute/plugin-sdk" || specifier.startsWith("node:")) continue;
      const target = path.resolve(path.dirname(managerPath), specifier);
      const packageRelative = path.relative(versionRoot, target);
      if (!specifier.startsWith("./") || !packageRelative || packageRelative.startsWith("..") || path.isAbsolute(packageRelative)) {
        violations.push(`${relative(managerPath)} imports outside its package and shared SDK: ${specifier}`);
      } else {
        if (await readSource(target) === undefined) violations.push(`${relative(managerPath)} imports a missing or linked package module: ${specifier}`);
      }
    }
    if (!managerSource.includes("definePlugin(")) violations.push(`${relative(managerPath)} does not use definePlugin`);
    if (!hasReleasablePluginScope(managerSource, {
      modules: await packageModuleSources(managerPath, versionRoot, readSource),
      fileName: path.relative(versionRoot, managerPath).replace(/\\/g, "/")
    })) diagnostics.push(`${relative(managerPath)}: no local releasable scope was identified by source inspection; confirm its actual resource owner with lifecycle tests.`);
    } catch (error) {
      violations.push(`${relative(manifestPath)} package module validation failed: ${error.message}`);
    }
  }
}

if (Object.keys(profile).some(field => !["schemaVersion", "readyRequires", "instances"].includes(field))) violations.push("desktop profile contains unsupported top-level fields");
if (profile.schemaVersion !== 2) violations.push("desktop profile must use schema 2");
if (!Array.isArray(profile.readyRequires) || !profile.readyRequires.includes("manager.core@1")) violations.push("desktop profile must declare manager.core@1 readiness");
if (!Array.isArray(profile.instances)) violations.push("desktop profile must declare its selected instances");
for (const instance of profile.instances ?? []) {
  if (!installedVersionKeys.has(JSON.stringify([instance.package, instance.version]))) {
    violations.push(`desktop profile selects an unavailable package version: ${instance.package}@${instance.version}`);
  }
}
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
}
