import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_FILE = "release-manifest.json";
const APP_ID = "io.rabiroute.windows";
const RETIRED_MANAGER_PATTERNS = Object.freeze([
  ["fixed Manager URL value", /\b(?:managerBaseUrl|managerUrl|GATEWAY_MANAGER_URL|RABIROUTE_MANAGER_URL)\b["']?\s*[:=]\s*["']?https?:(?:\\?\/){2}[^\s"'?#]+:879[0-9]\b/i],
  ["fixed Manager port label", /\bManager\s+(?:port\s*)?879[0-9]\b/i],
  ["fixed Manager port value", /\b(?:managerPort|GATEWAY_MANAGER_PORT|RABIROUTE_MANAGER_PORT)\b["']?\s*[:=]\s*["']?879[0-9]\b/i],
  ["fixed Manager port fallback", /\b(?:managerPort|GATEWAY_MANAGER_PORT|RABIROUTE_MANAGER_PORT)\b[^\r\n]{0,80}(?:\?\?|\|\|)\s*(?:Number\(\s*)?["']?879[0-9]\b/i],
  ["fixed Manager CLI endpoint", /--manager(?:-?(?:port|url))?\b[^\r\n]{0,120}\b879[0-9]\b/i],
  ["fixed Manager URL prose", /(?:\bManager\b[^\r\n]{0,160}https?:(?:\\?\/){2}[^\s"']+:879[0-9]\b|https?:(?:\\?\/){2}[^\s"']+:879[0-9]\b[^\r\n]{0,160}\bManager\b)/i],
  ["retired Manager firewall guidance", /RabiRoute\/Node\.js[^\r\n]{0,180}(?:port\s+879[0-9]|879[0-9]\s*端口)/i],
]);
const RETIRED_OPERATIONAL_MANAGER_PATTERNS = Object.freeze([
  ...RETIRED_MANAGER_PATTERNS,
  ["legacy Manager port-range literal", /\b879[0-9]\b/],
]);
const RETIRED_DOCUMENTATION_MANAGER_PATTERNS = Object.freeze([
  ...RETIRED_MANAGER_PATTERNS,
]);
const RETIRED_PLUGIN_LIFECYCLE_PATTERNS = Object.freeze([
  ["plugin access to Windows Task Scheduler cmdlets", /\b(?:Disable|Enable|Export|Get|New|Register|Set|Start|Stop|Unregister)-ScheduledTask(?:Action|Principal|SettingsSet|Trigger)?\b/i],
  ["plugin access to Windows Task Scheduler CLI", /\bschtasks(?:\.exe)?\b/i],
  ["plugin access to Windows Task Scheduler COM", /\bSchedule\.Service\b/i],
]);
const TEXT_EXTENSIONS = Object.freeze(new Set([
  ".bat", ".cjs", ".cmd", ".conf", ".config", ".html", ".ini", ".js", ".json",
  ".jsx", ".md", ".mjs", ".ps1", ".psd1", ".psm1", ".py", ".sh", ".toml", ".ts",
  ".tsx", ".txt", ".vbs", ".xml", ".yaml", ".yml",
]));

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${name}`);
    }
    values.set(name, argv[index + 1]);
    index += 1;
  }
  const payloadRoot = values.get("--payload");
  const packageVersion = values.get("--version");
  if (!payloadRoot || !packageVersion) {
    throw new Error("Usage: create-windows-release-manifest --payload <local-directory> --version <version>");
  }
  return { payloadRoot: path.resolve(payloadRoot), packageVersion };
}

function toReleasePath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error(`Invalid release path: ${relativePath}`);
  }
  return normalized;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function collectFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath === MANIFEST_FILE) continue;
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Release payload contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      collectFiles(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release payload contains an unsupported entry: ${relativePath}`);
    }
    const releasePath = toReleasePath(relativePath);
    if (/^(?:data|logs|recordings|transcripts)(?:\/|$)/i.test(releasePath)) {
      throw new Error(`Runtime/private path cannot enter a release manifest: ${releasePath}`);
    }
    output.push({
      path: releasePath,
      size: stats.size,
      sha256: sha256File(absolutePath),
    });
  }
  return output;
}

function isActiveManagerTruthPath(releasePath) {
  const normalized = releasePath.toLowerCase();
  return normalized.startsWith("dist/")
    || normalized.startsWith("ribiwebgui/dist/")
    || normalized.startsWith("scripts/")
    || normalized.startsWith("plugin-adapters/")
    || normalized.startsWith("docs/")
    || /^README(?:_zh)?\.md$/i.test(releasePath)
    || /^plugin-adapters\/[^/]+\/README(?:_en)?\.md$/i.test(releasePath);
}

function readTextFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < body.length; index += 2) {
      const first = body[index];
      body[index] = body[index + 1];
      body[index + 1] = first;
    }
    return body.toString("utf16le");
  }
  const probeLength = Math.min(bytes.length, 4096);
  let oddNuls = 0;
  for (let index = 1; index < probeLength; index += 2) {
    if (bytes[index] === 0) oddNuls += 1;
  }
  if (probeLength >= 8 && oddNuls >= Math.floor(probeLength / 4)) {
    return bytes.toString("utf16le");
  }
  return bytes.toString("utf8");
}

function assertNoRetiredManagerSemantics(payloadRoot, files) {
  for (const entry of files) {
    if (!isActiveManagerTruthPath(entry.path)) continue;
    const extension = path.extname(entry.path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const normalized = entry.path.toLowerCase();
    if (/\.test\.[^.]+$/i.test(entry.path) && !normalized.startsWith("dist/plugins/packages/")) continue;
    const content = readTextFile(path.join(payloadRoot, ...entry.path.split("/")));
    const pluginPackage = normalized.startsWith("dist/plugins/packages/");
    const pluginOwned = pluginPackage || normalized.startsWith("plugin-adapters/");
    const strictOperational = normalized.startsWith("dist/manager")
      || (normalized.startsWith("scripts/") && /(?:^|[\/_.-])manager/i.test(normalized));
    const documentation = normalized.startsWith("docs/") || /^readme(?:_zh)?\.md$/i.test(entry.path);
    const managerPatterns = strictOperational
      ? RETIRED_OPERATIONAL_MANAGER_PATTERNS
      : documentation
        ? RETIRED_DOCUMENTATION_MANAGER_PATTERNS
        : RETIRED_MANAGER_PATTERNS;
    const patterns = pluginOwned
      ? [...managerPatterns, ...RETIRED_PLUGIN_LIFECYCLE_PATTERNS]
      : managerPatterns;
    for (const [name, pattern] of patterns) {
      if (pattern.test(content)) {
        throw new Error(`Release payload contains retired Manager semantics (${name}): ${entry.path}`);
      }
    }
  }
}

function writeManifest(payloadRoot, packageVersion) {
  if (!fs.statSync(payloadRoot).isDirectory()) {
    throw new Error(`Payload root is not a directory: ${payloadRoot}`);
  }
  const files = collectFiles(payloadRoot).sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (files.length === 0) throw new Error("Release payload is empty.");
  assertNoRetiredManagerSemantics(payloadRoot, files);
  const canonical = files.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join("");
  const payloadSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const releaseId = `${packageVersion}-${payloadSha256.slice(0, 12)}`;
  const topLevelEntries = [...new Set(files.map((entry) => entry.path.split("/", 1)[0]))].sort((a, b) => a.localeCompare(b, "en"));
  const manifest = {
    schemaVersion: 1,
    appId: APP_ID,
    packageVersion,
    releaseId,
    payloadSha256,
    topLevelEntries,
    files,
  };
  const destination = path.join(payloadRoot, MANIFEST_FILE);
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to replace a pre-existing scoped manifest: ${destination}`);
  }
  const temporary = `${destination}.${process.pid}.${createHash("sha256").update(releaseId).digest("hex").slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { payloadRoot, packageVersion } = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(writeManifest(payloadRoot, packageVersion))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { assertNoRetiredManagerSemantics, collectFiles, writeManifest };
