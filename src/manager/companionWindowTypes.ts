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
  private pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: (roleId: string) => string) {}
  private file(roleId: string) { return path.join(this.directory(roleId), "companion", "window-types.json"); }
  async load(roleId: string): Promise<void> {
    if (this.roles.has(roleId)) return;
    const rows = new Map<string, Entry>();
    try {
      const file = this.file(roleId);
      if ((await fs.stat(file)).size > 1024 * 1024) throw new Error("Window type catalog is too large");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid window type catalog");
      for (const row of value.entries) {
        if (typeof row.processName !== "string" || !row.processName.trim() || row.processName.length > 120
          || typeof row.title !== "string" || row.title.length > 200 || !["play", "watch", "other"].includes(row.kind)) continue;
        rows.set(key(row), row);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.roles.set(roleId, rows);
  }
  classify(roleId: string, window: Window | undefined): Kind {
    return window ? this.roles.get(roleId)?.get(key(window))?.kind || "uncertain" : "uncertain";
  }
  async flush(): Promise<void> { await Promise.allSettled(this.pending.values()); }
  learn(roleId: string, window: Window, kind: Exclude<Kind, "uncertain">): Promise<void> {
    const task = (this.pending.get(roleId) || Promise.resolve()).catch(() => undefined).then(async () => {
      await this.load(roleId);
      const rows = this.roles.get(roleId)!;
      if (!window.processName.trim() || rows.get(key(window))?.kind === kind) return;
      const updated = new Map(rows);
      updated.set(key(window), { processName: window.processName.trim(), title: window.title.trim(), kind });
      if (Buffer.byteLength(JSON.stringify([...updated.values()])) > 1000_000) throw new Error("Window type catalog is full");
      this.roles.set(roleId, updated);
      await atomicRecordingJson(this.file(roleId), { schemaVersion: 1, entries: [...updated.values()] });
    });
    this.pending.set(roleId, task);
    return task;
  }
}
