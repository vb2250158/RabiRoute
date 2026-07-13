import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");

const webguiSrcDir = path.join(repoRoot, "ribiwebgui", "src");
const aiuiPagePath = path.join(projectRoot, "pages", "home", "index.ink");
const relayPath = path.join(repoRoot, "scripts", "rabilink-relay-server.mjs");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function walkSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
    } else if (/\.(vue|ts|js)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function addEndpoint(endpoints, endpoint, file) {
  if (!endpoint.startsWith("/")) return;
  if (!endpoints.has(endpoint)) endpoints.set(endpoint, new Set());
  endpoints.get(endpoint).add(path.relative(repoRoot, file).replaceAll("\\", "/"));
}

function extractFetchEndpoints() {
  const endpoints = new Map();
  for (const file of walkSourceFiles(webguiSrcDir)) {
    const source = read(file);
    for (const match of source.matchAll(/fetch\(\s*(?:`\$\{apiBase\}([^`$]+)|[`'"]([^`'"]+))/g)) {
      const raw = match[1] || match[2] || "";
      const endpoint = raw.replace(/\$\{[^}]+\}/g, ":param").split("?")[0];
      addEndpoint(endpoints, endpoint, file);
    }
  }
  return endpoints;
}

function endpointCoveredByAiui(endpoint, aiuiSource) {
  if (aiuiSource.includes(endpoint)) return true;
  if (endpoint === "/gateways") return aiuiSource.includes("loadWebguiConfigData");
  if (endpoint === "/manager-config") return aiuiSource.includes("loadManagerConfig");
  if (endpoint === "/open-config-file") return aiuiSource.includes("openPcConfigFile");
  if (endpoint.startsWith("/gateways/")) return aiuiSource.includes("gatewayActionPath");
  if (endpoint.startsWith("/api/scan/message-adapters")) return aiuiSource.includes("runMessageScan");
  return false;
}

function endpointAllowedByRelay(endpoint, relaySource) {
  if (relaySource.includes(`pathname === "${endpoint}"`)) return true;
  if (endpoint.startsWith("/gateways/")) return relaySource.includes("\\/gateways\\/[^/]+\\/");
  if (endpoint.startsWith("/api/scan/message-adapters")) return relaySource.includes('pathname === "/api/scan/message-adapters"');
  return false;
}

const aiuiSource = read(aiuiPagePath);
const relaySource = read(relayPath);
const endpoints = extractFetchEndpoints();
const misses = [];

for (const [endpoint, files] of [...endpoints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const coveredByAiui = endpointCoveredByAiui(endpoint, aiuiSource);
  const allowedByRelay = endpointAllowedByRelay(endpoint, relaySource);
  if (!coveredByAiui || !allowedByRelay) {
    misses.push({
      endpoint,
      coveredByAiui,
      allowedByRelay,
      files: [...files]
    });
  }
}

if (misses.length) {
  for (const miss of misses) {
    console.error(
      `${miss.coveredByAiui ? "AIUI" : "MISS"} ${miss.allowedByRelay ? "ALLOW" : "BLOCK"} ${miss.endpoint} <= ${miss.files.join(", ")}`
    );
  }
  throw new Error(`RabiLink AIUI misses ${misses.length} RibiWebGUI fetch endpoint(s).`);
}

console.log(`RabiLink AIUI WebGUI coverage passed (${endpoints.size} endpoint patterns).`);
