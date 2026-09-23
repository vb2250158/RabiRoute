import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Disposable projection, never a substitute for source metadata reconciliation. */
const FORMAT = "plan-file-projection-v1";
const MAX_BYTES = 512 * 1024 * 1024;

export function planPageCheckpointPath(roleDir: string): string {
  // Outside plans/: checkpoint publication must not trigger the source watcher.
  return path.join(roleDir, ".cache", "plan-page-catalog.json");
}

export async function loadPlanPageCheckpoint<T>(
  roleDir: string,
  validate: (value: unknown) => value is T
): Promise<Map<string, T> | undefined> {
  try {
    const file = await fs.open(planPageCheckpointPath(roleDir), "r");
    let text: string;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_BYTES) return undefined;
      // Bound allocation and reads even if another writer grows the open file.
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat();
      if (offset !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return undefined;
      text = buffer.subarray(0, offset).toString("utf8");
    } finally { await file.close(); }
    const envelope = JSON.parse(text) as { format?: unknown; root?: unknown; payload?: unknown; sha256?: unknown };
    if (envelope.format !== FORMAT || envelope.root !== await fs.realpath(roleDir)
      || typeof envelope.payload !== "string" || typeof envelope.sha256 !== "string") return undefined;
    if (createHash("sha256").update(envelope.payload).digest("hex") !== envelope.sha256) return undefined;
    const entries: unknown = JSON.parse(envelope.payload);
    if (!Array.isArray(entries)) return undefined;
    const result = new Map<string, T>();
    for (const row of entries) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !validate(row[1])) return undefined;
      const relative = row[0];
      if (!/^(active|archive)\/[^/\\:]+\/plan\.json$/.test(relative)
        || relative.split("/").some(part => part === "." || part === "..")) return undefined;
      const source = path.resolve(roleDir, "plans", relative);
      if (result.has(source)) return undefined;
      result.set(source, row[1]);
    }
    return result;
  } catch {
    // Missing, obsolete, inaccessible or corrupt cache: read the JSON truth.
    return undefined;
  }
}

export async function savePlanPageCheckpoint<T>(roleDir: string, entries: ReadonlyMap<string, T>): Promise<void> {
  const rows = [...entries].map(([file, value]) => [path.relative(path.join(roleDir, "plans"), file).split(path.sep).join("/"), value]);
  const payload = JSON.stringify(rows);
  const text = JSON.stringify({ format: FORMAT, root: await fs.realpath(roleDir), payload,
    sha256: createHash("sha256").update(payload).digest("hex") });
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("PLAN_CHECKPOINT_TOO_LARGE");
  const destination = planPageCheckpointPath(roleDir);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(text, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
