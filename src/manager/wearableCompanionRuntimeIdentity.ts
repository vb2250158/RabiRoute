import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WearableCompanionRuntimeIdentity = Readonly<{
  schemaVersion: 1;
  hostOwned: boolean;
  managerBaseUrl: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  runtimeRoot: string;
  stateRoot: string;
  logRoot: string;
  pwshPath?: string;
  unavailableReason?: string;
  environment: Readonly<Record<string, string>>;
}>;

type RuntimeIdentityInput = Readonly<{
  hostOwned: boolean;
  managerBaseUrl: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  runtimeRoot: string;
  explicitPwshPath?: string;
  environment?: NodeJS.ProcessEnv;
}>;

type RuntimeIdentityDependencies = Readonly<{
  isFile?: (candidate: string) => boolean;
  realpath?: (candidate: string) => string;
  wherePwsh?: (environment: NodeJS.ProcessEnv) => readonly string[];
}>;

function required(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function loopbackManagerUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(required(value, "managerBaseUrl")); } catch {
    throw new Error("managerBaseUrl must be an HTTP loopback URL.");
  }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("managerBaseUrl must be an HTTP loopback authority without credentials or a path.");
  }
  return parsed.origin;
}

function localAbsolutePath(value: string, field: string): string {
  const normalized = path.resolve(required(value, field));
  if (normalized.startsWith("\\\\")) throw new Error(`${field} must be on a local disk.`);
  return normalized;
}

function defaultWherePwsh(environment: NodeJS.ProcessEnv): readonly string[] {
  const systemRoot = String(environment.SystemRoot || environment.SYSTEMROOT || "").trim();
  const whereExe = systemRoot ? path.join(systemRoot, "System32", "where.exe") : "where.exe";
  try {
    return String(execFileSync(whereExe, ["pwsh.exe"], {
      encoding: "utf8",
      windowsHide: true,
      env: environment
    })).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  } catch {
    return Object.freeze([]);
  }
}

export function resolveWearableCompanionPwshPath(
  explicitPath = "",
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeIdentityDependencies = {}
): string | undefined {
  const isFile = dependencies.isFile ?? (candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  const realpath = dependencies.realpath ?? (candidate => fs.realpathSync.native(candidate));
  const candidates = explicitPath.trim()
    ? [explicitPath.trim()]
    : [...(dependencies.wherePwsh ?? defaultWherePwsh)(environment)];
  for (const candidate of candidates) {
    let absolute: string;
    try { absolute = localAbsolutePath(candidate, "pwshPath"); } catch { continue; }
    if (!isFile(absolute)) continue;
    try { absolute = localAbsolutePath(realpath(absolute), "pwshPath"); } catch { continue; }
    if (path.basename(absolute).toLowerCase() !== "pwsh.exe") continue;
    return absolute;
  }
  return undefined;
}

function safeWorkerEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const allowed = [
    "SystemRoot", "SYSTEMROOT", "PATH", "Path", "PATHEXT", "TEMP", "TMP",
    "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ANDROID_HOME", "ANDROID_SDK_ROOT"
  ];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = String(environment[key] || "").trim();
    if (value) result[key] = value;
  }
  return Object.freeze(result);
}

export function createWearableCompanionRuntimeIdentity(
  input: RuntimeIdentityInput,
  dependencies: RuntimeIdentityDependencies = {}
): WearableCompanionRuntimeIdentity {
  const runtimeRoot = path.resolve(required(input.runtimeRoot, "runtimeRoot"));
  const runtimeIsLocal = !runtimeRoot.startsWith("\\\\");
  const hostOwned = input.hostOwned === true;
  const environment = input.environment ?? process.env;
  const pwshPath = hostOwned && runtimeIsLocal ? resolveWearableCompanionPwshPath(
    input.explicitPwshPath,
    environment,
    dependencies
  ) : undefined;
  const unavailableReason = !hostOwned
    ? "Wearable companion requires a Host-owned Manager generation."
    : !runtimeIsLocal
    ? "Wearable companion runtime root must be on a local disk."
    : pwshPath
      ? undefined
      : "PowerShell 7 (pwsh.exe) was not found on a verified local path.";
  return Object.freeze({
    schemaVersion: 1,
    hostOwned,
    managerBaseUrl: loopbackManagerUrl(input.managerBaseUrl),
    applicationGenerationId: required(input.applicationGenerationId, "applicationGenerationId"),
    managerInstanceId: required(input.managerInstanceId, "managerInstanceId"),
    runtimeRoot,
    stateRoot: path.join(runtimeRoot, "data", "wearable-companion"),
    logRoot: path.join(runtimeRoot, "logs", "wearable-companion"),
    ...(pwshPath ? { pwshPath } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    environment: safeWorkerEnvironment(environment)
  });
}
