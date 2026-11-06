import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const privateDirectories = new Set(["node_modules", "dist", ".git", "data", "logs", "credentials", "session", "sessions", "auth", "storage", "cache", "runtime", ".deps", ".builddeps"]);
const generatedDirectories = new Set(["node_modules", "dist", ".git", ".venv", "venv", "__pycache__"]);
const publicJson = new Set(["package.json", "package-lock.json", "rabi.plugin.json", "rabi-plugin.json", "plugin.json", "manifest.json", "hooks.json", "catalog.json", "model-catalog.json", "storage-migrations.json", "agent-adapter.json", "route-config.json", "route-message-endpoint.json", "config.schema.json", "tsconfig.json"]);

/** Repository defaults and schemas are public. Local accounts, saves and build outputs are separate owners. */
export function isPublicPluginSource(relative) {
  const parts = relative.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length) return true;
  if (parts.some(part => generatedDirectories.has(part.toLowerCase()))) return false;
  if (privateDirectories.has(parts[0].toLowerCase())) return false;
  const name = parts.at(-1).toLowerCase();
  const publicDefinition = /\.(?:schema|default|example)\.json$/.test(name);
  if (/\.(?:pem|key|p8|p12|pfx|jks|keystore|sqlite3?|db)(?:-(?:wal|shm|journal))?$/.test(name)
      || /\.py[co]$/.test(name)) return false;
  if ((!publicDefinition && /^(?:credentials?|auth|sessions?|secrets?|tokens?)(?:[.-].*)?\.json$/.test(name))
      || name === ".env" || name.startsWith(".env.") && name !== ".env.example"
      || (!publicDefinition && /\.local\./.test(name))) return false;
  if (parts.length === 1 && name.endsWith(".json") && !publicJson.has(name)
      && !publicDefinition && !/\.build\.json$/.test(name)) return false;
  return true;
}

/** Development tests stay in repository exports; automatic runtime copying omits them. */
export function isPluginRuntimeSource(relative) {
  if (!isPublicPluginSource(relative)) return false;
  const parts = relative.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some(part => ["test", "tests", "__tests__", "__fixtures__"].includes(part.toLowerCase()))) return false;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return !/\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(name)
    && !/^(?:test_.*|conftest)\.py$/.test(name) && !/_(?:test|fixture)\.py$/.test(name)
    && !/\.(?:tests?|fixture)\.(?:ps1|cs)$/.test(name);
}

export async function copyPluginPublicSource(source, destination, { replace = false, runtime = false } = {}) {
  const include = runtime ? isPluginRuntimeSource : isPublicPluginSource;
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    if (!include(entry.name) || input === destination || destination.startsWith(input + path.sep)) continue;
    await fs.cp(input, path.join(destination, entry.name), { recursive: true, force: replace, errorOnExist: !replace,
      filter: file => include(path.relative(source, file)) });
  }
}

export function isPublicPluginInput(root, file) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  if (!relative.startsWith("src/plugins/")) return true;
  return isPublicPluginSource(relative.split("/").slice(3).join("/"));
}

/** Apply the same runtime rule to the canonical plugin trees copied into Windows payloads. */
export function isPluginRuntimeInput(relative) {
  const normalized = relative.replaceAll(String.fromCharCode(92), "/");
  if (normalized.startsWith("src/plugins/") || normalized.startsWith("plugins/contracts/plugin-sdk/")) {
    return isPluginRuntimeSource(normalized.split("/").slice(3).join("/"));
  }
  return true;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, root, manifestFile] = process.argv.slice(2);
  if (command !== "--runtime-exclusions" || !root) throw new Error("Usage: public-source.mjs --runtime-exclusions <source-root> [tracked-manifest]");
  const paths = manifestFile
    ? JSON.parse(await fs.readFile(manifestFile, "utf8")).files.map(entry => entry.path)
    : execFileSync("git", ["-C", root, "ls-files", "-z", "--", "src/plugins", "plugins/contracts/plugin-sdk"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
  if (!Array.isArray(paths) || paths.some(name => typeof name !== "string")) throw new Error("Runtime source selection requires file paths.");
  const excluded = paths.filter(name => !isPluginRuntimeInput(name));
  // Native Windows PowerShell receives ASCII JSON, including non-ASCII asset paths losslessly.
  console.log(JSON.stringify(excluded).split("").map(character => character.charCodeAt(0) > 126 ? String.fromCharCode(92) + "u" + character.charCodeAt(0).toString(16).padStart(4, "0") : character).join(""));
}
