import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const activeRoots = ["src", "scripts", "plugins", "ribiwebgui", "desktop"];
const ignoredDirectories = new Set(["node_modules", "dist", "data", ".git", ".runtime", "__pycache__"]);
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
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
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

const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".py", ".md"]);
const activeFiles = (await Promise.all(activeRoots.map(filesRecursively))).flat();
const violations = [];
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
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith("node:") || specifier.startsWith("./")) continue;
    violations.push(`${relative(file)} imports outside the Plugin Kernel: ${specifier}`);
  }
}

const builtinRoot = path.join(root, "plugins", "builtin");
const packageDirectories = (await fs.readdir(builtinRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
const allowedManifestFields = new Set(["schemaVersion", "id", "version", "entries", "provides", "requires", "optional", "permissions", "configSchema", "stateSchemaVersion"]);
for (const packageEntry of packageDirectories) {
  const versionRoot = path.join(builtinRoot, packageEntry.name, "1.0.0");
  const manifestPath = path.join(versionRoot, "rabi.plugin.json");
  const managerPath = path.join(versionRoot, "manager.mjs");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const unknownFields = Object.keys(manifest).filter(field => !allowedManifestFields.has(field));
  if (unknownFields.length) violations.push(`${relative(manifestPath)} contains removed manifest fields: ${unknownFields.join(", ")}`);
  if (manifest.id !== packageEntry.name) violations.push(`${relative(manifestPath)} package identity mismatch`);
  if (!manifest.entries?.manager) violations.push(`${relative(manifestPath)} has no Manager entry`);
  const managerSource = await fs.readFile(managerPath, "utf8");
  const imports = [...managerSource.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
  if (imports.some(specifier => specifier !== "@rabiroute/plugin-sdk")) violations.push(`${relative(managerPath)} imports outside the shared SDK`);
  if (!managerSource.includes("definePlugin(")) violations.push(`${relative(managerPath)} does not use definePlugin`);
  if (!managerSource.includes("context.effects.add(")) violations.push(`${relative(managerPath)} has no releasable effect scope`);
}

const profilePath = path.join(root, "plugins", "profiles", "desktop.json");
const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
if (Object.keys(profile).some(field => !["schemaVersion", "instances"].includes(field))) violations.push("desktop profile contains unsupported top-level fields");
if (!Array.isArray(profile.instances) || profile.instances.length !== packageDirectories.length) violations.push("desktop profile must select every built-in package exactly once");
if (new Set(profile.instances?.map(instance => instance.package)).size !== profile.instances?.length) violations.push("desktop profile contains duplicate packages");

for (const file of await filesRecursively("src")) {
  if (!/[.]ts$/.test(file) || file.endsWith(".test.ts")) continue;
  const source = await fs.readFile(file, "utf8");
  if (source.includes("io.rabiroute.manager.")) violations.push(`${relative(file)} branches on a concrete built-in package ID`);
}

if (violations.length) {
  console.error(violations.map(value => `- ${value}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Plugin platform architecture check passed for ${packageDirectories.length} built-in packages.`);
}
