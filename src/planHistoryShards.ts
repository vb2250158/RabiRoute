import fs from "node:fs";
import path from "node:path";

// Physical rotation only: plan archival remains a separate lifecycle operation.
export const PLAN_HISTORY_FILE = "history.jsonl";
export const PLAN_HISTORY_FILE_LIMIT = 16 * 1024 * 1024;
const SHARD_NAME = /^history\/(\d{6})\.jsonl$/;

export function isPlanHistoryPath(relativePath: string): boolean {
  return relativePath === PLAN_HISTORY_FILE || relativePath.startsWith("history/");
}

/** Return physical files in append order, refusing gaps and unknown files in the reserved directory. */
export function orderedPlanHistoryPaths(paths: Iterable<string>): string[] {
  const all = [...paths];
  const shards = all.filter(file => file.startsWith("history/"));
  if (!all.includes(PLAN_HISTORY_FILE)) {
    if (shards.length) throw new Error("Plan history shards require history.jsonl.");
    return [];
  }
  const numbered = shards.map(file => {
    const match = SHARD_NAME.exec(file);
    if (!match || Number(match[1]) < 1) throw new Error(`Invalid plan history shard: ${file}`);
    return { file, number: Number(match[1]) };
  }).sort((left, right) => left.number - right.number);
  numbered.forEach(({ file, number }, index) => {
    if (number !== index + 1) throw new Error(`Plan history shard is missing or duplicated before: ${file}`);
  });
  return [PLAN_HISTORY_FILE, ...numbered.map(({ file }) => file)];
}

export function readPlanHistoryBytes(files: Map<string, Buffer>): Buffer {
  const paths = orderedPlanHistoryPaths(files.keys());
  // A legacy base file may contain a complete last JSON row without LF. Treat
  // the physical shard boundary as a logical line break without changing old bytes.
  const chunks: Buffer[] = [];
  for (const file of paths) {
    const previous = chunks.at(-1);
    if (previous?.byteLength && previous.at(-1) !== 10) chunks.push(Buffer.from("\n"));
    chunks.push(files.get(file)!);
  }
  return Buffer.concat(chunks);
}

export function appendPlanHistoryRecord(files: Map<string, Buffer>, record: unknown): void {
  const row = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (row.byteLength > PLAN_HISTORY_FILE_LIMIT) throw new Error("Plan history record exceeds the per-file limit.");
  const paths = orderedPlanHistoryPaths(files.keys());
  const latest = paths.at(-1) ?? PLAN_HISTORY_FILE;
  const current = files.get(latest) ?? Buffer.alloc(0);
  const separator = current.byteLength && current.at(-1) !== 10 ? Buffer.from("\n") : Buffer.alloc(0);
  if (current.byteLength + separator.byteLength + row.byteLength <= PLAN_HISTORY_FILE_LIMIT) {
    files.set(latest, Buffer.concat([current, separator, row]));
    return;
  }
  if (!current.byteLength) throw new Error("Plan history base must contain a complete record.");
  const next = `history/${String(paths.length).padStart(6, "0")}.jsonl`;
  if (paths.length > 999999 || files.has(next)) throw new Error("Plan history shard capacity exceeded.");
  files.set(next, row);
}

function existingHistoryEntry(location: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link is an occupied entry even though existsSync reports false.
      const parent = path.dirname(location);
      try {
        if (fs.readdirSync(parent).includes(path.basename(location))) {
          throw new Error(`Invalid plan history entry: ${location}`);
        }
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
      }
      return undefined;
    }
    throw error;
  }
}

export function readPlanHistoryDirectory(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const owner = existingHistoryEntry(directory);
  if (owner && !owner.isDirectory()) throw new Error(`Invalid plan history owner directory: ${directory}`);
  if (!owner) return files;
  const base = path.join(directory, PLAN_HISTORY_FILE);
  const baseEntry = existingHistoryEntry(base);
  if (baseEntry) {
    if (!baseEntry.isFile()) throw new Error(`Invalid plan history base: ${base}`);
    files.set(PLAN_HISTORY_FILE, fs.readFileSync(base));
  }
  const shardDirectory = path.join(directory, "history");
  const shardEntry = existingHistoryEntry(shardDirectory);
  if (shardEntry) {
    if (!shardEntry.isDirectory()) throw new Error(`Invalid plan history directory: ${shardDirectory}`);
    for (const entry of fs.readdirSync(shardDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Invalid plan history shard: ${entry.name}`);
      files.set(`history/${entry.name}`, fs.readFileSync(path.join(shardDirectory, entry.name)));
    }
  }
  orderedPlanHistoryPaths(files.keys());
  return files;
}
