import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initAix, { AixReaderWasm } from "@yodaos-pkg/aix/pkg/aix_web.js";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";
import { writeDeterministicZip } from "./Write-DeterministicZip.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseVersion = String(JSON.parse(fs.readFileSync(path.join(projectRoot, "craft-release.json"), "utf8")).version || "").trim();
const tempRoot = path.join(os.tmpdir(), `rabilink-aiui-aix-audit-${process.pid}-${Date.now()}`);
const stagingRoot = path.join(tempRoot, "staging");
const freshAixPath = path.join(tempRoot, "rabilink-aiui.aix");
const argumentIndex = process.argv.indexOf("--aix");
const deliveryAixPath = argumentIndex >= 0
  ? path.resolve(process.argv[argumentIndex + 1] || "")
  : path.join(projectRoot, "dist", "rabilink-aiui.aix");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validateReader(reader, label) {
  const names = reader.list().map((entry) => entry.name);
  const version = String(reader.get_version() || "").trim();
  const title = reader.get_title() || "";
  const pages = reader.get_pages() || [];
  const tools = reader.get_tools() || [];

  for (const required of [".aixignore", "AGENTS.md", "VERSION", "app.js", "app.json", "pages/home/index.js", "pages/home/index.json", "pages/home/index.wxml", "pages/home/index.wxss"]) {
    assert(names.includes(required), `${label} is missing ${required}.`);
  }
  assert(!names.some((name) => name.endsWith(".ink") || name.startsWith("utils/")), `${label} must contain only the generated self-contained runtime, not source modules.`);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(version), `${label} VERSION is not UUIDv4: ${version}`);
  assert(title === "RabiLink AIUI", `Unexpected ${label} title: ${title}`);
  assert(pages.some((page) => page.name === "pages/home/index"), `${label} reader did not find pages/home/index.`);
  assert(pages.length === 1, `${label} must expose one page containing both product modes.`);

  const homeTool = tools.find((tool) => tool?.function?.name === "pages/home/index");
  assert(homeTool, `${label} reader did not generate the pages/home/index UI tool.`);
  assert(homeTool.function.parameters?.properties?.token?.type === "string", `${label} UI tool is missing the token parameter.`);
  assert(homeTool.function.parameters?.properties?.mode?.type === "string", `${label} UI tool is missing the dual-mode parameter.`);
  assert(
    JSON.stringify(homeTool.function.parameters?.properties?.mode?.enum) === JSON.stringify(["transcription", "configuration"]),
    `${label} UI tool mode enum is incorrect.`
  );
  assert(homeTool.function.parameters?.properties?.surface?.type === "string", `${label} UI tool is missing the surface parameter.`);
  assert(homeTool.function.parameters?.properties?.panel?.type === "string", `${label} UI tool is missing the panel parameter.`);
  assert(
    Array.isArray(homeTool.function.parameters?.required)
      && !homeTool.function.parameters.required.includes("token"),
    `${label} UI tool must allow rendering before the platform token is bound.`
  );
  assert(tools.length === 1, `${label} must expose exactly one dual-mode UI tool.`);

  const markup = Buffer.from(reader.read_file("pages/home/index.wxml")).toString("utf8");
  const pageScript = Buffer.from(reader.read_file("pages/home/index.js")).toString("utf8");
  const appJson = JSON.parse(Buffer.from(reader.read_file("app.json")).toString("utf8"));
  assert(markup.includes("unifiedModeHud"), `${label} is missing the shared transcription/configuration HUD.`);
  assert((markup.match(/class="releaseVersion"/g) || []).length === 1, `${label} must show its release version beside battery in the shared card/immersive HUD.`);
  assert(pageScript.includes(JSON.stringify(releaseVersion)), `${label} does not contain visible release version ${releaseVersion}.`);
  assert(/appVersion\s*:\s*this\.data\.releaseVersion/.test(pageScript), `${label} runtime proof must use the injected Craft release version.`);
  assert(!pageScript.includes("__RABILINK_RELEASE_VERSION__"), `${label} contains an unresolved release version marker.`);
  assert(
    !markup.includes("legacyConfigurationModeHost")
      && !markup.includes("configurationViewport")
      && !markup.includes("Token {{maskedToken}}"),
    `${label} still contains the old manual configuration dashboard.`
  );

  return {
    names,
    version,
    relayBaseUrl: String(appJson?.rabiLink?.relayBaseUrl || "").trim()
  };
}

let freshReader;
let deliveryReader;
try {
  assert(fs.existsSync(deliveryAixPath), `Delivery AIX was not found: ${deliveryAixPath}`);
  const wasmPath = path.join(projectRoot, "node_modules", "@yodaos-pkg", "aix", "pkg", "aix_web_bg.wasm");
  await initAix({ module_or_path: fs.readFileSync(wasmPath) });

  const deliveryBytes = fs.readFileSync(deliveryAixPath);
  deliveryReader = new AixReaderWasm(deliveryBytes);
  const delivery = validateReader(deliveryReader, "delivery AIX");

  await buildPackageStaging(stagingRoot, {
    versionId: delivery.version,
    relayBaseUrl: delivery.relayBaseUrl
  });
  writeDeterministicZip(stagingRoot, freshAixPath);
  freshReader = new AixReaderWasm(fs.readFileSync(freshAixPath));
  const fresh = validateReader(freshReader, "fresh AIX build");

  assert(JSON.stringify(delivery.names) === JSON.stringify(fresh.names), "Delivery AIX file list does not match the current source build.");
  for (const name of fresh.names) {
    const freshHash = sha256(Buffer.from(freshReader.read_file(name)));
    const deliveryHash = sha256(Buffer.from(deliveryReader.read_file(name)));
    assert(deliveryHash === freshHash, `Delivery AIX contains stale content: ${name}.`);
  }

  const craftVersionPath = path.join(path.dirname(deliveryAixPath), "craft-upload", "VERSION");
  if (fs.existsSync(craftVersionPath)) {
    const craftVersion = fs.readFileSync(craftVersionPath, "utf8").trim();
    assert(craftVersion === delivery.version, "Delivery AIX and sibling craft-upload folder must share the same VERSION.");
  }

  console.log(`RabiLink AIUI delivery AIX audit passed (${delivery.names.length} files, VERSION ${delivery.version}, SHA256 ${sha256(deliveryBytes)}).`);
} finally {
  freshReader?.free();
  deliveryReader?.free();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
