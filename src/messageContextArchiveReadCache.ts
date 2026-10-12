import fs from "node:fs";
import path from "node:path";
import type { MessageContextRecord } from "./messageContextStore.js";

type CachedArchive = { fingerprint: string; records: MessageContextRecord[]; bytes: number; usedAt: number };

/** Derived worker-local data only. File replacement, editing and expiry force a fresh read. */
export class MessageContextArchiveReadCache {
  private readonly cached = new Map<string, CachedArchive>();
  private bytes = 0;

  constructor(private readonly maxBytes = 384 * 1024 * 1024, private readonly maxFiles = 128,
    private readonly ttlMs = 120_000, private readonly now = () => performance.now()) {}

  private stamp(file: string): { fingerprint: string; size: number } {
    const stat = fs.statSync(file);
    return { fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, size: stat.size };
  }

  private remove(file: string): void {
    const item = this.cached.get(file);
    if (!item) return;
    this.bytes -= item.bytes;
    this.cached.delete(file);
  }

  read(file: string, load: (file: string) => MessageContextRecord[]): MessageContextRecord[] {
    const key = path.resolve(file);
    const now = this.now();
    for (const [name, item] of this.cached) if (now - item.usedAt >= this.ttlMs) this.remove(name);
    let before: ReturnType<MessageContextArchiveReadCache["stamp"]>;
    try { before = this.stamp(key); }
    catch { this.remove(key); return load(key); }
    const cached = this.cached.get(key);
    if (cached?.fingerprint === before.fingerprint) {
      cached.usedAt = now;
      this.cached.delete(key);
      this.cached.set(key, cached);
      return cached.records;
    }
    this.remove(key);
    const records = load(key);
    let after: ReturnType<MessageContextArchiveReadCache["stamp"]>;
    try { after = this.stamp(key); } catch { return records; }
    // Account conservatively for UTF-16 strings and normalized object overhead.
    const bytes = before.size * 4 + records.length * 512;
    if (!records.length || before.fingerprint !== after.fingerprint || bytes > this.maxBytes || this.maxFiles < 1) return records;
    while (this.cached.size && (this.bytes + bytes > this.maxBytes || this.cached.size >= this.maxFiles)) {
      this.remove(this.cached.keys().next().value!);
    }
    this.cached.set(key, { fingerprint: before.fingerprint, records, bytes, usedAt: now });
    this.bytes += bytes;
    return records;
  }
}
