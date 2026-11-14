import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dshOwner = "io.rabiroute.agent.dsh";
const dshSource = `src/plugins/${dshOwner}/apps/rabi-agent/lib/dsh.mjs`;
const dshArtifact = `lib/plugin-owners/${dshOwner}/dsh.mjs`;
const sourceImports = new Map([
  ["rabi-agent.mjs", `../../${dshSource}`],
  ["lib/instance-agents.mjs", `../../../${dshSource}`]
]);

// Publisher-only projection. Materialized releases retain their original bytes
// and never load the source parser or look outside their package.
function projectSourceImports(root, relative, bytes, pluginSourceRoot) {
  if (!pluginSourceRoot) return { bytes, projected: false };
  const specifier = sourceImports.get(relative);
  if (!specifier) return { bytes, projected: false };
  const text = bytes.toString("utf8");
  if (!text.includes(specifier)) return { bytes, projected: false };
  const ts = require("typescript");
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier) continue;
    const importer = fs.realpathSync.native(path.join(root, relative));
    const actualSource = fs.realpathSync.native(path.resolve(path.dirname(importer), specifier));
    const selectedSource = fs.realpathSync.native(path.resolve(pluginSourceRoot, dshSource));
    if (actualSource !== selectedSource)
      throw new Error("Plugin source root does not match the Agent source import: " + relative);
    let target = path.posix.relative(path.posix.dirname(relative), dshArtifact);
    if (!target.startsWith(".")) target = "./" + target;
    edits.push({ start: statement.moduleSpecifier.getStart(source), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
  }
  let projected = text;
  for (const edit of edits.reverse()) projected = projected.slice(0, edit.start) + edit.text + projected.slice(edit.end);
  return { bytes: edits.length ? Buffer.from(projected) : bytes, projected: edits.length > 0 };
}

function hasSourceProjection(root, pluginSourceRoot) {
  if (!pluginSourceRoot) return false;
  for (const relative of sourceImports.keys()) {
    const file = path.join(root, relative);
    if (fs.existsSync(file) && projectSourceImports(root, relative, fs.readFileSync(file), pluginSourceRoot).projected) return true;
  }
  return false;
}

export function readReleaseAsset(root, relative, { pluginSourceRoot } = {}) {
  relative = normalizeReleaseAssetPath(relative);
  if (pluginSourceRoot && relative === dshArtifact && hasSourceProjection(root, pluginSourceRoot))
    return fs.readFileSync(path.resolve(pluginSourceRoot, dshSource));
  const bytes = fs.readFileSync(path.join(root, ...relative.split("/")));
  return projectSourceImports(root, relative, bytes, pluginSourceRoot).bytes;
}

export function normalizeReleaseAssetPath(value) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`Invalid LAN Agent release asset path: ${value}`);
  return normalized;
}

/** Read the official native builder's finite runtime closure once per inventory. */
function computerTrackingAssets(root) {
  const relative = "dist/native/computer-tracking-assets.json";
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return new Set();
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const specPath = "desktop/tracking/asset-spec.json";
  const specBytes = fs.readFileSync(path.join(root,specPath));
  const spec = JSON.parse(specBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.architecture !== "win-x64" || spec.schemaVersion !== 1 || spec.architecture !== manifest.architecture
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.inputs)) throw new Error("Invalid computer tracking asset manifest.");
  const expectedFiles=[...spec.managedFiles,...spec.nativeFiles.map(file=>file.path),...spec.notices.map(file=>file.path)];
  for (const [actual,expected] of [[manifest.files.map(file=>file.path),expectedFiles],[manifest.inputs.map(file=>file.path),spec.inputs]]) {
    if (actual.length!==expected.length || new Set(actual).size!==expected.length || expected.some(name=>!actual.includes(name))) throw new Error("Computer tracking asset closure is incomplete or duplicated.");
  }
  if (manifest.inputs.find(file=>file.path===specPath)?.sha256!==createHash("sha256").update(specBytes).digest("hex")) throw new Error("Computer tracking asset specification changed.");
  const assets = new Set([relative,specPath]);
  for (const item of manifest.files) {
    if (typeof item.path !== "string" || !/^[A-Za-z0-9_.-]+$/.test(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Invalid computer tracking asset.");
    const relative = "dist/native/" + item.path;
    const bytes = fs.readFileSync(path.join(root, relative));
    if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error("Computer tracking runtime closure differs from its builder receipt.");
    assets.add(relative);
  }
  return assets;
}

/** The signed source release and explicit Windows bundle share one asset inventory. */
export function collectReleaseAssetPaths(root, relative = "", options = {}) {
  const trackingAssets = options.trackingAssets ?? computerTrackingAssets(root);
  const assets = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (child === "node_modules" || child === "test" || child === "windows-runtime") return [];
      return collectReleaseAssetPaths(root, child, { ...options, trackingAssets });
    }
    if (!entry.isFile()) return [];
    // runtime/ is the native-runtime builder's public output closure, including
    // generated JS, JSON manifests and future package resources.
    if (trackingAssets.has(child) || child.startsWith("runtime/") || entry.name === "package.json" || child === "package-lock.json" || entry.name.endsWith(".mjs")
      || ["desktop/tray.ps1", "desktop/start-windows.ps1", "desktop/rabi-agent.ico", "desktop/computer.ps1", "desktop/computer-native.cs", "terminal/host.ps1"].includes(child)
      || /^dist\/native\/(terminal|computer|tray)-[a-f0-9]{64}\.dll$/.test(child)
      || /^dist\/native\/RabiAgent\.(Terminal|Computer|Tray)\.exe$/.test(child)
      || child.startsWith("dist/agent-hooks/") && /\.(json|md)$/.test(entry.name)) return [normalizeReleaseAssetPath(child)];
    return [];
  });
  if (!relative && hasSourceProjection(root, options.pluginSourceRoot)) {
    // Validate the canonical owner before publishing a manifest or any bytes.
    readReleaseAsset(root, dshArtifact, options);
    if (!assets.includes(dshArtifact)) assets.push(dshArtifact);
  }
  return assets;
}
