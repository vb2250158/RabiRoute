import fs from "node:fs";
import path from "node:path";
import { collectWatchedConfigFiles, configFilesSnapshot } from "./configWatchSnapshot.js";
import { adapterConfigPath, personaConfigPath } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

export type ConfigWatchSnapshotRequest = {
  kind?: "config";
  routeRoot: string;
  rolesRoot: string;
  explicitFiles?: readonly string[];
  operationTimeoutMs?: number;
};

export type PluginTreeWatchSnapshotRequest = {
  kind: "plugin_tree";
  roots: readonly string[];
  operationTimeoutMs?: number;
};

export type ManagerWatchSnapshotRequest = ConfigWatchSnapshotRequest | PluginTreeWatchSnapshotRequest;

export type ManagerWatchSnapshotResult = {
  files: string[];
  snapshot: string;
  partial: boolean;
  errors: string[];
};

export type ManagerWatchWorkerResponse =
  | { ok: true; result: ManagerWatchSnapshotResult }
  | { ok: false; message: string; stack?: string };

function errorSummary(target: string, error: unknown): string {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${target}: ${code ? `${code} ` : ""}${message}`.trim();
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, target: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error(`timed out after ${timeoutMs}ms`),
          { code: "ETIMEDOUT", watchTarget: target }
        )), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ignoredPluginEntry(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.includes(".runtime") || normalized.endsWith(".tmp");
}

async function pluginTreeSnapshot(
  request: PluginTreeWatchSnapshotRequest
): Promise<ManagerWatchSnapshotResult> {
  const timeoutMs = Math.max(10, request.operationTimeoutMs ?? 1_500);
  const errors: string[] = [];
  const rows: string[] = [];
  const files: string[] = [];

  const walk = async (root: string, directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await bounded(
        fs.promises.readdir(directory, { withFileTypes: true }),
        timeoutMs,
        directory
      );
    } catch (error) {
      errors.push(errorSummary(directory, error));
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (ignoredPluginEntry(relative)) continue;
      if (entry.isDirectory()) {
        await walk(root, target);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(target);
      try {
        const stat = await bounded(fs.promises.stat(target), timeoutMs, target);
        rows.push(`${target}|${stat.mtimeMs}|${stat.size}`);
      } catch (error) {
        errors.push(errorSummary(target, error));
        rows.push(`${target}|unavailable`);
      }
    }
  };

  for (const root of [...new Set(request.roots.map(value => path.resolve(value)))].sort()) {
    await walk(root, root);
  }
  files.sort((left, right) => left.localeCompare(right));
  rows.sort((left, right) => left.localeCompare(right));
  return {
    files,
    snapshot: rows.join("\n"),
    partial: errors.length > 0,
    errors
  };
}

async function configSnapshot(request: ConfigWatchSnapshotRequest): Promise<ManagerWatchSnapshotResult> {
  const timeoutMs = Math.max(10, request.operationTimeoutMs ?? 1_500);
  const discovered = await collectWatchedConfigFiles({
    routeRoot: request.routeRoot,
    rolesRoot: request.rolesRoot,
    explicitFiles: request.explicitFiles,
    timeoutMs,
    adapterConfigPath: name => adapterConfigPath(request.routeRoot, name),
    personaConfigPath: name => personaConfigPath(request.rolesRoot, name),
    includeDirectory: name => Boolean(sanitizeRoleId(name))
  });
  const snapshot = await configFilesSnapshot(discovered.files, timeoutMs);
  const errors = [...discovered.errors, ...snapshot.errors];
  return {
    files: discovered.files,
    snapshot: snapshot.snapshot,
    partial: errors.length > 0,
    errors
  };
}

async function execute(request: ManagerWatchSnapshotRequest): Promise<ManagerWatchSnapshotResult> {
  return request.kind === "plugin_tree"
    ? pluginTreeSnapshot(request)
    : configSnapshot(request);
}

let responseExitPending = false;

function sendAndExit(message: ManagerWatchWorkerResponse): void {
  if (!process.send || !process.connected) process.exit(1);
  responseExitPending = true;
  process.send(message, error => {
    if (process.connected) process.disconnect();
    process.exit(error ? 1 : 0);
  });
}

if (!process.send) {
  throw new Error("Manager watch worker requires an IPC channel.");
}

process.once("disconnect", () => {
  if (responseExitPending) return;
  process.removeAllListeners("message");
  process.exit(0);
});

process.once("message", (request: ManagerWatchSnapshotRequest) => {
  void execute(request)
    .then(result => sendAndExit({ ok: true, result }))
    .catch(error => sendAndExit({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }));
});
