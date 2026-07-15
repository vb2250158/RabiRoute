import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseVersionMarker = "__RABILINK_RELEASE_VERSION__";

function fail(message) {
  throw new Error(message);
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readReleaseVersion() {
  const release = JSON.parse(readText(path.join(projectRoot, "craft-release.json")));
  const version = String(release.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail("craft-release.json version must use semantic versioning.");
  }
  return version;
}

function normalizedPackageVersionId(value) {
  const versionId = String(value || "").trim();
  if (!versionId) return randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId)) {
    fail("AIUI package VERSION must be a UUIDv4.");
  }
  return versionId.toLowerCase();
}

function copyFile(relativePath, stagingRoot) {
  const source = path.join(projectRoot, relativePath);
  const target = path.join(stagingRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function normalizedRelayBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    fail("RABILINK_AIUI_RELAY_URL must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    fail("RABILINK_AIUI_RELAY_URL must use https, localhost, or 127.0.0.1.");
  }
  return url.toString().replace(/\/+$/, "");
}

function applyPrivateRelayDefaultToAppJson(stagingRoot, relayBaseUrl) {
  if (!relayBaseUrl) return;
  const appJsonPath = path.join(stagingRoot, "app.json");
  const appJson = JSON.parse(readText(appJsonPath));
  appJson.rabiLink = {
    ...(appJson.rabiLink || {}),
    relayBaseUrl,
    token: ""
  };
  writeText(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
}

function extractTag(source, tagName, marker = "") {
  const markerPattern = marker ? `[^>]*${marker}[^>]*` : "[^>]*";
  const match = source.match(new RegExp(`<${tagName}${markerPattern}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? match[1].trim() : "";
}

async function bundlePageSetup(setupSource, relayBaseUrl, releaseVersion) {
  const markerCount = setupSource.split(releaseVersionMarker).length - 1;
  if (markerCount !== 1) {
    fail(`pages/home/index.ink must contain exactly one ${releaseVersionMarker} marker.`);
  }
  const versionedSetupSource = setupSource.replace(releaseVersionMarker, releaseVersion);
  const plugins = [];
  if (relayBaseUrl) {
    plugins.push({
      name: "rabilink-private-defaults",
      setup(build) {
        build.onLoad({ filter: /rabilink-defaults\.js$/ }, (args) => ({
          contents: readText(args.path).replace(
            /relayBaseUrl:\s*"[^"]*"/,
            `relayBaseUrl: ${JSON.stringify(relayBaseUrl)}`
          ),
          loader: "js"
        }));
      }
    });
  }

  const result = await build({
    stdin: {
      contents: versionedSetupSource,
      resolveDir: path.join(projectRoot, "pages", "home"),
      sourcefile: "pages/home/index.js",
      loader: "js"
    },
    bundle: true,
    charset: "utf8",
    external: ["wx"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    platform: "browser",
    plugins,
    target: "es2020",
    treeShaking: true,
    write: false
  });
  const output = result.outputFiles?.[0]?.text || "";
  if (!output.trim()) fail("Bundled pages/home/index.js is empty.");
  if (/from\s+["']\.\.\//.test(output)) {
    fail("Bundled pages/home/index.js still contains relative imports.");
  }
  return output.trimEnd();
}

async function buildCompiledPage(stagingRoot, relayBaseUrl) {
  const pageSource = readText(path.join(projectRoot, "pages", "home", "index.ink"));
  const defSource = extractTag(pageSource, "script", "def");
  const setupSource = extractTag(pageSource, "script", "setup");
  const pageMarkup = extractTag(pageSource, "page");
  const pageStyle = extractTag(pageSource, "style");

  if (!defSource) fail("pages/home/index.ink is missing <script def>.");
  if (!setupSource) fail("pages/home/index.ink is missing <script setup>.");
  if (!pageMarkup) fail("pages/home/index.ink is missing <page>.");
  if (!pageStyle) fail("pages/home/index.ink is missing <style>.");

  const pageJson = JSON.parse(defSource);
  const compiledPageScript = await bundlePageSetup(setupSource, relayBaseUrl, readReleaseVersion());
  writeText(path.join(stagingRoot, "pages", "home", "index.json"), `${JSON.stringify(pageJson, null, 2)}\n`);
  writeText(path.join(stagingRoot, "pages", "home", "index.js"), `${compiledPageScript}\n`);
  writeText(path.join(stagingRoot, "pages", "home", "index.wxml"), `${pageMarkup}\n`);
  writeText(path.join(stagingRoot, "pages", "home", "index.wxss"), `${pageStyle}\n`);
}

export async function buildPackageStaging(stagingRoot, options = {}) {
  const relayBaseUrl = normalizedRelayBaseUrl(
    options.relayBaseUrl === undefined
      ? process.env.RABILINK_AIUI_RELAY_URL
      : options.relayBaseUrl
  );
  const versionId = normalizedPackageVersionId(options.versionId || process.env.RABILINK_AIUI_PACKAGE_VERSION_ID);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });

  for (const file of [".aixignore", "AGENTS.md", "app.js", "app.json"]) {
    copyFile(file, stagingRoot);
  }
  await buildCompiledPage(stagingRoot, relayBaseUrl);
  applyPrivateRelayDefaultToAppJson(stagingRoot, relayBaseUrl);
  writeText(path.join(stagingRoot, "VERSION"), `${versionId}\n`);
}

if (process.argv[1] === import.meta.filename) {
  const stagingArgIndex = process.argv.indexOf("--staging");
  const versionArgIndex = process.argv.indexOf("--version-id");
  const stagingRoot = stagingArgIndex >= 0 ? process.argv[stagingArgIndex + 1] : "";
  const versionId = versionArgIndex >= 0 ? process.argv[versionArgIndex + 1] : "";
  if (!stagingRoot) fail("Usage: node Build-RabiLinkAiuiPackage.mjs --staging <dir> [--version-id <uuidv4>]");
  await buildPackageStaging(path.resolve(stagingRoot), { versionId });
  console.log(`Built RabiLink AIUI staging at ${path.resolve(stagingRoot)}`);
}
