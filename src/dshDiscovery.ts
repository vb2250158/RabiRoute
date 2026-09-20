import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Documented `dsh web` default. The live owner may listen on another loopback port. */
export const DEFAULT_DSH_BASE_URL = "http://127.0.0.1:3080";

const LAUNCH_BANNER = /dsh web: (https?:\/\/[^\s<>"']+)/g;
const LOG_TAIL_BYTES = 256 * 1024;

export type DshInstallCandidate = { label: string; path?: string; url?: string };

export type DshLocalDiscovery = {
  installed: boolean;
  homeDir: string;
  installCandidates: DshInstallCandidate[];
  discoveredBaseUrls: string[];
  warnings: string[];
};

export type DshDiscoveryOptions = {
  homeDir?: string;
  env?: NodeJS.Dict<string>;
};

function dshHomeDir(env: NodeJS.Dict<string> = process.env): string {
  const configured = env.DSH_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".dsh");
}

function loopbackOrigin(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return undefined;
  return url.origin;
}

function readLogTail(logPath: string): string {
  const fd = fs.openSync(logPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return "";
    const length = Math.min(stat.size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function originsFromLaunchLog(logPath: string): string[] {
  let tail: string;
  try { tail = readLogTail(logPath); }
  catch { return []; }
  const origins: string[] = [];
  for (const match of tail.matchAll(LAUNCH_BANNER)) {
    const origin = loopbackOrigin(match[1]);
    if (origin && origins[origins.length - 1] !== origin) origins.push(origin);
  }
  return origins;
}

function newestMatchingLog(logsDir: string, prefix: string, suffix: string): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(logsDir, { withFileTypes: true }); }
  catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
    const fullPath = path.join(logsDir, entry.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(fullPath).mtimeMs; }
    catch { continue; }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: fullPath, mtimeMs };
  }
  return newest?.path;
}

function pushUnique(target: string[], value: string | undefined): void {
  if (value && !target.includes(value)) target.push(value);
}

/**
 * Read-only discovery of a local DSH owner. Never starts DSH, never reads tokens
 * out of launch URLs, and never treats a missing default port as "not installed".
 */
export function discoverLocalDsh(options: DshDiscoveryOptions = {}): DshLocalDiscovery {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ? path.resolve(options.homeDir) : dshHomeDir(env);
  const warnings: string[] = [];
  const installCandidates: DshInstallCandidate[] = [];
  const discoveredBaseUrls: string[] = [];

  const webProfile = path.join(homeDir, "profiles", "web", "package.json");
  const webProfileExists = fs.existsSync(webProfile);
  if (webProfileExists) {
    installCandidates.push({ label: "DSH web profile", path: path.dirname(webProfile) });
  } else if (fs.existsSync(homeDir)) {
    installCandidates.push({ label: "DSH Home", path: homeDir });
  }

  pushUnique(discoveredBaseUrls, loopbackOrigin(env.DSH_WEB_URL?.trim() || ""));

  const logsDir = path.join(homeDir, "logs");
  const currentLog = path.join(logsDir, "web-host.stdout.log");
  for (const origin of originsFromLaunchLog(currentLog)) pushUnique(discoveredBaseUrls, origin);
  const previousLog = newestMatchingLog(logsDir, "dsh-web-", ".stdout.log");
  if (previousLog && path.resolve(previousLog) !== path.resolve(currentLog)) {
    for (const origin of originsFromLaunchLog(previousLog)) pushUnique(discoveredBaseUrls, origin);
  }

  if (discoveredBaseUrls.length) {
    installCandidates.push({ label: "本机 DSH web", url: discoveredBaseUrls[0] });
  }

  const installed = webProfileExists || fs.existsSync(homeDir) || discoveredBaseUrls.length > 0;
  if (!installed) {
    warnings.push("未发现本机 DSH Home 或 web profile；请先安装 DSH。");
  }
  return { installed, homeDir, installCandidates, discoveredBaseUrls, warnings };
}

export function resolveDshBaseUrl(
  value?: string,
  discovery: Pick<DshLocalDiscovery, "discoveredBaseUrls"> = discoverLocalDsh()
): string {
  const explicit = value?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return discovery.discoveredBaseUrls[0] || DEFAULT_DSH_BASE_URL;
}
