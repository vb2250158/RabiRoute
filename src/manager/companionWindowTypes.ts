import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicRecordingJson } from "./allDayRecording.js";
import type { CompanionObservation, CompanionSession } from "../shared/companionActivity.js";

type Window = NonNullable<CompanionObservation["window"]>;
type Kind = CompanionSession["activityKind"];
type Entry = { processName: string; title: string; kind: Exclude<Kind, "uncertain"> };
const key = (window: Window) => JSON.stringify([window.processName.trim().toLowerCase(), window.title.trim().toLowerCase()]);

/** Persona-owned learned classifications; exact window evidence, no captured frames. */
export class CompanionWindowTypes {
  private roles = new Map<string, Map<string, Entry>>();
  private retained = new Map<string, unknown[]>();
  private blocked = new Map<string, Set<string>>();
  private roots = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: (roleId: string) => string) {}
  private file(roleId: string) { return path.join(this.directory(roleId), "companion", "window-types.json"); }
  async load(roleId: string, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    const originalFile = this.file(roleId);
    if (this.roles.has(roleId) && this.roots.get(roleId) === originalFile) return;
    const rows = new Map<string, Entry>();
    const blocked = new Set<string>();
    const seen = new Set<string>();
    let entries: unknown[] = [];
    try {
      const file = originalFile;
      if ((await fs.stat(file)).size > 1024 * 1024) throw new Error("Window type catalog is too large");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid window type catalog");
      entries = value.entries;
      for (const value of entries) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Partial<Entry>;
        if (typeof row.processName !== "string" || typeof row.title !== "string") continue;
        const identity = key(row as Window);
        const valid = Boolean(row.processName.trim()) && row.processName.length <= 120
          && row.title.length <= 200 && ["play", "watch", "other"].includes(row.kind as string);
        if (seen.has(identity) || !valid) {
          rows.delete(identity);
          blocked.add(identity);
        } else if (!blocked.has(identity)) rows.set(identity, row as Entry);
        seen.add(identity);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assertCurrent?.();
    if (this.file(roleId) !== originalFile) throw new Error("Companion role directory changed");
    this.roots.set(roleId, originalFile);
    this.roles.set(roleId, rows);
    this.retained.set(roleId, entries);
    this.blocked.set(roleId, blocked);
  }
  classify(roleId: string, window: Window | undefined): Kind {
    return window && this.roots.get(roleId) === this.file(roleId) ? this.roles.get(roleId)?.get(key(window))?.kind || "uncertain" : "uncertain";
  }
  async flush(): Promise<void> { await Promise.allSettled(this.pending.values()); }
  learn(roleId: string, window: Window, kind: Exclude<Kind, "uncertain">, assertCurrent?: () => void): Promise<void> {
    const originalFile = this.file(roleId);
    const task = (this.pending.get(roleId) || Promise.resolve()).catch(() => undefined).then(async () => {
      assertCurrent?.();
      if (this.file(roleId) !== originalFile) throw new Error("Companion role directory changed");
      await this.load(roleId, assertCurrent);
      assertCurrent?.();
      const rows = this.roles.get(roleId)!;
      const identity = key(window);
      if (this.blocked.get(roleId)?.has(identity)) throw new Error("Window classification has conflicting or invalid stored evidence");
      if (!window.processName.trim() || rows.get(key(window))?.kind === kind) return;
      const updated = new Map(rows);
      const learned = { processName: window.processName.trim(), title: window.title.trim(), kind };
      updated.set(identity, learned);
      const entries = [...(this.retained.get(roleId) || [])];
      const previous = rows.get(identity);
      if (previous) entries[entries.indexOf(previous)] = learned;
      else entries.push(learned);
      if (Buffer.byteLength(JSON.stringify(entries)) > 1000_000) throw new Error("Window type catalog is full");
      assertCurrent?.();
      if (this.file(roleId) !== originalFile) throw new Error("Companion role directory changed");
      await atomicRecordingJson(originalFile, { schemaVersion: 1, entries }, assertCurrent);
      this.roles.set(roleId, updated);
      this.retained.set(roleId, entries);
    });
    this.pending.set(roleId, task);
    return task;
  }
}
