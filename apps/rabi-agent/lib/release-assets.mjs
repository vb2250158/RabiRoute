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

/** The signed source release and explicit Windows bundle share one asset inventory. */
export function collectReleaseAssetPaths(root, relative = "", options = {}) {
  const assets = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (child === "node_modules" || child === "test" || child === "windows-runtime") return [];
      return collectReleaseAssetPaths(root, child, options);
    }
    if (!entry.isFile()) return [];
    // runtime/ is the native-runtime builder's public output closure, including
    // generated JS, JSON manifests and future package resources.
    if (child.startsWith("runtime/") || entry.name === "package.json" || child === "package-lock.json" || entry.name.endsWith(".mjs")
      || ["desktop/tray.ps1", "desktop/start-windows.ps1", "desktop/rabi-agent.ico", "desktop/computer.ps1", "terminal/host.ps1"].includes(child)
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
