#!/usr/bin/env node
// Splits a built Windows portable distribution into per-component archives so the
// installer can ship a small core payload and fetch optional modules on demand.
//
// Usage:
//   node scripts/split-windows-release-components.mjs --distribution <dir> --output <dir>
//
// The distribution directory is the unpacked portable layout
// (RabiRouteHost.exe + current.json + versions/<releaseId>/...). Every file of the
// distribution lands in exactly one component archive; the split fails closed when
// the component rules leave a file unassigned or assign it twice.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import yazl from "yazl";

const MANIFEST_FILE = "release-manifest.json";
const COMPONENTS_FILE = "components.json";

// Directory rules end in a slash. File rules match an exact path.
// `core` is the fallback and must never be shadowed.
//
// `distributionPrefixes` match paths inside the portable distribution
// (`versions/<releaseId>/...`). `manifestPrefixes` are the same locations
// relative to the release directory, which is what `release-manifest.json` and
// the install transaction use to decide whether an uninstalled component may be
// absent.
// This same trusted, versioned definition is copied beside the transaction script.
const definition = JSON.parse(fs.readFileSync(new URL("./windows-release-components.json", import.meta.url), "utf8"));
if (definition.schemaVersion !== 1 || !Array.isArray(definition.components)) throw new Error("Unsupported component definition.");
const ids = new Set(), prefixes = [];
function matchesRule(relativePath, rule) {
  return rule.endsWith("/") ? relativePath.startsWith(rule) : relativePath === rule;
}
for (const component of definition.components) {
  if (!/^[a-z][a-z0-9-]*$/.test(component.id) || ids.has(component.id) || typeof component.required !== "boolean" || !Array.isArray(component.manifestPrefixes)) throw new Error("Invalid component definition.");
  ids.add(component.id);
  for (const prefix of component.manifestPrefixes) {
    if (typeof prefix !== "string" || !/^[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)*\/?$/.test(prefix) || prefix.split("/").some(part => part === "." || part === "..") || prefixes.some(other => matchesRule(other, prefix.toLowerCase()) || matchesRule(prefix.toLowerCase(), other))) throw new Error("Invalid or overlapping component prefix.");
    prefixes.push(prefix.toLowerCase());
  }
}
const CORE = definition.components.find(component => component.id === "core");
if (!CORE || !CORE.required || CORE.manifestPrefixes.length !== 0) throw new Error("Invalid core component definition.");
const COMPONENT_RULES = definition.components.filter(component => component.id !== "core")
  .map(component => ({ ...component, distributionPrefixes: component.manifestPrefixes.map(prefix => `versions/*/${prefix}`) }));
CORE.distributionPrefixes = [];

function fail(message) {
  process.stderr.write(`[split-components] ${message}\n`);
  process.exit(1);
}

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
  const distribution = values.get("--distribution");
  const output = values.get("--output");
  if (!distribution || !output) {
    throw new Error("Usage: split-windows-release-components --distribution <dir> --output <dir>");
  }
  return { distribution: path.resolve(distribution), output: path.resolve(output) };
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, absolute)));
      } else {
        throw new Error(`Distribution contains a non-regular entry: ${absolute}`);
      }
    }
  };
  walk(root);
  return files.sort();
}

function prefixToRegExp(prefix) {
  // `versions/*/desktop-runtime/` matches any release id.
  const escaped = prefix
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}${prefix.endsWith("/") ? "" : "$"}`, "i");
}

const MATCHERS = [...COMPONENT_RULES, CORE].map((component) => ({
  component,
  patterns: component.distributionPrefixes.map(prefixToRegExp),
}));

function assignComponent(relativePath) {
  for (const entry of MATCHERS) {
    if (entry.patterns.some((pattern) => pattern.test(relativePath))) {
      return entry.component.id;
    }
  }
  return CORE.id;
}

function sha256File(absolutePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(absolutePath));
  return hash.digest("hex");
}

async function writeArchive({ distribution, output, archiveName, files, baseDirectory }) {
  const archivePath = path.join(output, archiveName);
  await fs.promises.rm(archivePath, { force: true });
  const zip = new yazl.ZipFile();
  for (const relativePath of files) {
    zip.addFile(path.join(distribution, relativePath), relativePath, { mtime: baseDirectory });
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(archivePath);
    zip.outputStream.pipe(stream);
    zip.outputStream.on("error", reject);
    stream.on("error", reject);
    stream.on("close", resolve);
    zip.end();
  });
  return archivePath;
}

async function main() {
  const { distribution, output } = parseArgs(process.argv.slice(2));

  const versionsRoot = path.join(distribution, "versions");
  if (!fs.existsSync(versionsRoot)) {
    fail(`Distribution has no versions directory: ${versionsRoot}`);
  }
  const releaseDirectories = fs
    .readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (releaseDirectories.length !== 1) {
    fail(`Expected exactly one release directory, found ${releaseDirectories.length}.`);
  }
  const releaseId = releaseDirectories[0].name;
  const versionManifestPath = path.join(versionsRoot, releaseId, MANIFEST_FILE);
  if (!fs.existsSync(versionManifestPath)) {
    fail(`Release manifest is missing: ${versionManifestPath}`);
  }
  const versionManifest = JSON.parse(fs.readFileSync(versionManifestPath, "utf8"));

  const distributionFiles = listFiles(distribution).filter(
    (relativePath) => relativePath !== COMPONENTS_FILE,
  );
  const buckets = new Map([[CORE.id, []], ...COMPONENT_RULES.map((rule) => [rule.id, []])]);
  for (const relativePath of distributionFiles) {
    buckets.get(assignComponent(relativePath)).push(relativePath);
  }

  const assigned = [...buckets.values()].reduce((total, files) => total + files.length, 0);
  if (assigned !== distributionFiles.length) {
    fail(`Component split lost files: assigned ${assigned} of ${distributionFiles.length}.`);
  }

  // The install transaction must know which components were skipped before the
  // optional archives are extracted, so the core archive carries a metadata-only
  // component map. Archive names and hashes are added only to the copy written
  // under the output directory, because they do not exist until packing finishes.
  const componentState = {
    schemaVersion: 1,
    releaseId,
    packageVersion: versionManifest.packageVersion,
    components: [CORE, ...COMPONENT_RULES].map((component) => ({
      id: component.id,
      required: component.required,
      manifestPrefixes: component.manifestPrefixes,
    })),
  };
  fs.writeFileSync(
    path.join(distribution, COMPONENTS_FILE),
    `${JSON.stringify(componentState, null, 2)}\n`,
    "utf8",
  );
  buckets.get(CORE.id).push(COMPONENTS_FILE);

  fs.mkdirSync(output, { recursive: true });
  const mtime = new Date("2020-01-01T00:00:00Z");
  const components = [];
  for (const component of [CORE, ...COMPONENT_RULES]) {
    const files = buckets.get(component.id);
    if (files.length === 0) {
      fail(`Component ${component.id} resolved to zero files; the rules are stale.`);
    }
    const archiveName = `component-${component.id}.zip`;
    const archivePath = await writeArchive({
      distribution,
      output,
      archiveName,
      files,
      baseDirectory: mtime,
    });
    const size = fs.statSync(archivePath).size;
    components.push({
      id: component.id,
      title: component.title,
      description: component.description,
      required: component.required,
      default: component.default,
      manifestPrefixes: component.manifestPrefixes,
      archive: archiveName,
      sha256: sha256File(archivePath),
      sizeBytes: size,
      fileCount: files.length,
    });
    process.stdout.write(
      `[split-components] ${component.id.padEnd(12)} ${files.length
        .toString()
        .padStart(6)} files ${(size / 1048576).toFixed(1).padStart(7)} MB\n`,
    );
  }

  const document = {
    schemaVersion: 1,
    releaseId,
    packageVersion: versionManifest.packageVersion,
    payloadSha256: versionManifest.payloadSha256,
    components,
  };
  const documentPath = path.join(output, COMPONENTS_FILE);
  fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.stdout.write(`[split-components] wrote ${documentPath}\n`);
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
