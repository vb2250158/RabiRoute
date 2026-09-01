import fs from "node:fs";
import path from "node:path";

export type ConfigWatchDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

export type ConfigWatchDirectoryReader = (
  directory: string
) => Promise<ConfigWatchDirectoryEntry[]>;

type CollectWatchedConfigFilesOptions = {
  routeRoot: string;
  rolesRoot: string;
  explicitFiles?: readonly string[];
  timeoutMs?: number;
  readDirectory?: ConfigWatchDirectoryReader;
  fileExists?: (filePath: string) => Promise<boolean>;
  adapterConfigPath: (name: string) => string;
  personaConfigPath: (name: string) => string;
  includeDirectory?: (name: string) => boolean;
};

export type WatchedConfigFilesResult = {
  files: string[];
  partial: boolean;
  errors: string[];
};

function errorSummary(directory: string, error: unknown): string {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${directory}: ${code ? `${code} ` : ""}${message}`.trim();
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { watchTarget: label });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectWatchedConfigFiles(
  options: CollectWatchedConfigFilesOptions
): Promise<WatchedConfigFilesResult> {
  const timeoutMs = Math.max(10, options.timeoutMs ?? 1500);
  const readDirectory = options.readDirectory ?? (async directory =>
    fs.promises.readdir(directory, { withFileTypes: true }) as unknown as ConfigWatchDirectoryEntry[]);
  const fileExists = options.fileExists ?? (async filePath => {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  });
  const files = new Set<string>();
  const errors: string[] = [];

  const read = async (directory: string): Promise<ConfigWatchDirectoryEntry[]> => {
    try {
      return await bounded(Promise.resolve(readDirectory(directory)), timeoutMs, directory);
    } catch (error) {
      errors.push(errorSummary(directory, error));
      return [];
    }
  };

  const [routeEntries, roleEntries] = await Promise.all([
    read(options.routeRoot),
    read(options.rolesRoot)
  ]);
  for (const file of options.explicitFiles ?? []) files.add(path.resolve(file));
  await Promise.all(routeEntries
    .filter(entry => entry.isDirectory() && (options.includeDirectory?.(entry.name) ?? true))
    .map(async entry => {
      const candidate = options.adapterConfigPath(entry.name);
      try {
        if (await bounded(Promise.resolve(fileExists(candidate)), timeoutMs, candidate)) files.add(candidate);
      } catch (error) {
        errors.push(errorSummary(candidate, error));
      }
    }));
  await Promise.all(roleEntries
    .filter(entry => entry.isDirectory() && (options.includeDirectory?.(entry.name) ?? true))
    .map(async entry => {
    const candidate = options.personaConfigPath(entry.name);
    try {
      if (await bounded(Promise.resolve(fileExists(candidate)), timeoutMs, candidate)) files.add(candidate);
    } catch (error) {
      errors.push(errorSummary(candidate, error));
    }
    }));

  return {
    files: [...files].sort((left, right) => left.localeCompare(right)),
    partial: errors.length > 0,
    errors
  };
}

export async function configFilesSnapshot(
  files: string[],
  timeoutMs = 1500
): Promise<{ snapshot: string; partial: boolean; errors: string[] }> {
  const errors: string[] = [];
  const rows = await Promise.all(files.map(async file => {
    try {
      const stat = await bounded(fs.promises.stat(file), timeoutMs, file);
      return `${file}|${stat.mtimeMs}|${stat.size}`;
    } catch (error) {
      errors.push(errorSummary(file, error));
      return `${file}|unavailable`;
    }
  }));
  return { snapshot: rows.join("\n"), partial: errors.length > 0, errors };
}
