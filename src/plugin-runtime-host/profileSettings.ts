import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireFileLockSync, atomicWriteFileSync } from "../shared/filePersistence.js";
import { readPluginProfile, type PluginProfile } from "../plugin-kernel/profile.js";

type Override = { enabled?: boolean; config?: Record<string, unknown> };
export type PluginProfileSettingsSnapshot = Readonly<{
  revision: string;
  profile: PluginProfile;
  diagnostics: readonly Readonly<{ instanceId: string; message: string }>[];
}>;
export type PluginInstanceSettingsUpdate = Override & { expectedRevision: string };

export class PluginSettingsConflict extends Error {
  readonly status = 409;
  constructor() { super("Plugin settings changed. Refresh before saving this instance."); }
}

/** User settings overlay immutable package defaults; each instance owns its file. */
export class PluginProfileSettings {
  constructor(readonly options: Readonly<{ profilePath: string; settingsRoot: string }>) {}

  private settingsPath(instanceId: string): string {
    return path.join(this.options.settingsRoot, createHash("sha256").update(instanceId).digest("hex") + ".json");
  }

  async snapshot(): Promise<PluginProfileSettingsSnapshot> {
    let base: PluginProfile;
    try { base = await readPluginProfile(this.options.profilePath); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error("Plugin profile is invalid JSON.");
      throw error;
    }
    const diagnostics: { instanceId: string; message: string }[] = [];
    const hash = createHash("sha256").update(JSON.stringify(base));
    const rows = await Promise.all(base.instances.map(async instance => {
      let raw: string | undefined;
      try { raw = await fs.readFile(this.settingsPath(instance.id), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { instance, revision: "absent" };
        const message = `Cannot read settings: ${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}`;
        return { instance: { ...instance, enabled: false }, revision: message, error: message };
      }
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
        const saved = value as Record<string, unknown>;
        if (saved.schemaVersion !== 1 || saved.instanceId !== instance.id) throw new Error("Settings identity or version does not match this instance.");
        if (saved.enabled !== undefined && typeof saved.enabled !== "boolean") throw new Error("enabled must be boolean.");
        if (saved.config !== undefined && (!saved.config || typeof saved.config !== "object" || Array.isArray(saved.config))) throw new Error("config must be an object.");
        return { instance: { ...instance, ...(saved.enabled !== undefined ? { enabled: saved.enabled as boolean } : {}),
          ...(saved.config !== undefined ? { config: saved.config } : {}) }, revision: raw };
      } catch (error) {
        return { instance: { ...instance, enabled: false }, revision: raw,
          error: error instanceof SyntaxError ? "Invalid JSON in this instance settings file."
            : error instanceof Error ? error.message : "Invalid instance settings." };
      }
    }));
    for (const row of rows) {
      hash.update(JSON.stringify([row.instance.id, row.revision]));
      if (row.error) diagnostics.push({ instanceId: row.instance.id, message: row.error });
    }
    return { revision: hash.digest("hex"), profile: { ...base, instances: rows.map(row => row.instance) }, diagnostics };
  }

  async update(instanceId: string, input: PluginInstanceSettingsUpdate, assertCurrent: () => void = () => {}): Promise<PluginProfileSettingsSnapshot> {
    assertCurrent();
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) throw new Error("expectedRevision is required.");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be boolean.");
    if (input.config !== undefined && (!input.config || typeof input.config !== "object" || Array.isArray(input.config))) throw new Error("config must be an object.");
    await fs.mkdir(this.options.settingsRoot, { recursive: true });
    assertCurrent();
    // Contention is local to a settings save; never wait on the Manager thread.
    const release = acquireFileLockSync(path.join(this.options.settingsRoot, "profile-settings.lock"), { timeoutMs: 1 });
    try {
      const current = await this.snapshot();
      assertCurrent();
      if (current.revision !== input.expectedRevision) throw new PluginSettingsConflict();
      if (current.diagnostics.some(row => row.instanceId === instanceId)) throw Object.assign(new Error("Repair this plugin instance settings file before changing its enabled state."), { status: 409 });
      if (!current.profile.instances.some(instance => instance.id === instanceId)) throw Object.assign(new Error("Plugin instance was not found."), { status: 404 });
      const target = this.settingsPath(instanceId);
      let saved: Record<string, unknown> = {};
      try { saved = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      assertCurrent();
      const value = { ...saved, schemaVersion: 1, instanceId,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}) };
      atomicWriteFileSync(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      return await this.snapshot();
    } finally { release(); }
  }
}
