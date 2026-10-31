import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicRecordingJson } from "./allDayRecording.js";
import type { CompanionResumeIntent, CompanionSession } from "../shared/companionActivity.js";

/** Machine-local recovery checkpoint for an explicitly enabled desktop producer; no frames or replies. */
export class CompanionContinuationStore {
  constructor(private readonly root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "RabiRoute", "companion-recovery")) {}
  private file(roleId: string): string {
    if (!roleId || roleId.length > 128 || /[\\/]/.test(roleId) || roleId === "." || roleId === "..") throw new Error("Invalid companion persona");
    return path.join(this.root, `${encodeURIComponent(roleId)}.json`);
  }
  async read(roleId: string): Promise<CompanionResumeIntent | null> {
    let value: any;
    try {
      const file = this.file(roleId);
      if ((await fs.stat(file)).size > 4096) return null;
      value = JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch { return null; }
    const i = value?.intent;
    if (value?.schemaVersion !== 1 || value.enabled !== true || i?.observationOwner !== "desktop"
      || typeof i.gatewayId !== "string" || !i.gatewayId || i.gatewayId.length > 128
      || typeof i.presetId !== "string" || !i.presetId || i.presetId.length > 64
      || typeof i.title !== "string" || i.title.length > 200
      || ![i.autoReview, i.voice, i.saveSummary].every(v => typeof v === "boolean")) return null;
    return { gatewayId: i.gatewayId, presetId: i.presetId, title: i.title, autoReview: i.autoReview,
      voice: i.voice, saveSummary: i.saveSummary, observationOwner: "desktop" };
  }
  async save(session: CompanionSession, assertCurrent?: () => void): Promise<void> {
    if (session.observationOwner !== "desktop") return;
    const intent: CompanionResumeIntent = { gatewayId: session.gatewayId, presetId: session.presetId,
      title: session.title, autoReview: session.autoReview, voice: session.voice,
      saveSummary: session.saveSummary, observationOwner: "desktop" };
    await atomicRecordingJson(this.file(session.roleId), { schemaVersion: 1, enabled: true, intent }, assertCurrent);
  }
  async clear(roleId: string, assertCurrent?: () => void): Promise<void> {
    await atomicRecordingJson(this.file(roleId), { schemaVersion: 1, enabled: false }, assertCurrent);
  }
}
