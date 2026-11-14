import { FsAwaitDiagnostics, traceFsAwait, type SlowFsReporter } from "../shared/fsAwaitDiagnostics.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireFileLockSync, atomicWriteFileSync } from "../shared/filePersistence.js";
import { applicationRuntimeLayout } from "../shared/runtimeLayout.js";
import { parsePluginProfile, readPluginProfile, type PluginProfile, type PluginProfileDiagnostic, type PluginProfileEntry } from "../plugin-kernel/profile.js";

type Override = { enabled?: boolean; config?: Record<string, unknown> };
export type PluginProfileSettingsSnapshot = Readonly<{
  revision: string;
  profile: PluginProfile;
  /** Removed membership retains its original settings and storage identity for reinstall. */
  removedInstances: readonly PluginProfileEntry[];
  diagnostics: readonly Readonly<{ instanceId?: string; message: string; rowIndex?: number; source?: PluginProfileDiagnostic["source"] }>[];
}>;
export type PluginInstanceSettingsUpdate = Override & { expectedRevision: string };

export class PluginSettingsConflict extends Error {
  readonly status = 409;
  readonly code = "PLUGIN_SETTINGS_REVISION_CONFLICT";
  constructor() { super("Plugin settings changed. Refresh before saving this instance."); }
}

/** User settings overlay immutable package defaults; each instance owns its file. */
export class PluginProfileSettings {
  constructor(readonly options: Readonly<{ profilePath: string; settingsRoot: string; migrationsPath?: string; onSlowFs?: SlowFsReporter }>) {}

  private settingsPath(instanceId: string): string {
    return path.join(this.options.settingsRoot, createHash("sha256").update(instanceId).digest("hex") + ".json");
  }

  async snapshot(): Promise<PluginProfileSettingsSnapshot> {
    const trace = this.options.onSlowFs ? new FsAwaitDiagnostics("PluginProfileSettings", "snapshot", this.options.onSlowFs) : undefined;
    try { return await this.readSnapshot(trace); } finally { trace?.finish(); }
  }

  private async readSnapshot(trace?: FsAwaitDiagnostics): Promise<PluginProfileSettingsSnapshot> {
    let base: PluginProfile;
    try { base = await traceFsAwait(trace, "profile.readPluginProfile", readPluginProfile(this.options.profilePath, { migrationsPath: this.options.migrationsPath
      ?? path.join(applicationRuntimeLayout().packageRoot, "dist", "plugins", "profiles", "package-migrations.json") })); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error("Plugin profile is invalid JSON.");
      throw error;
    }
    const diagnostics: Array<PluginProfileSettingsSnapshot["diagnostics"][number]> = [...(base.diagnostics ?? [])];
    const hash = createHash("sha256").update(JSON.stringify(base));
    const definitions = new Map(base.instances.map(instance => [instance.id, instance]));
    const extraFiles = new Map<string, string>();
    let filenames: string[] = [];
    try { filenames = await traceFsAwait(trace, "settings.readdir", fs.readdir(this.options.settingsRoot)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const baseNames = new Set(base.instances.map(instance => path.basename(this.settingsPath(instance.id))));
    for (const filename of filenames.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename) || baseNames.has(filename)) continue;
      let raw: string | undefined;
      try {
        raw = await traceFsAwait(trace, "settings.extra.readFile", fs.readFile(path.join(this.options.settingsRoot, filename), "utf8"));
        const saved = JSON.parse(raw);
        if (typeof saved?.instanceId !== "string" || path.basename(this.settingsPath(saved.instanceId)) !== filename) throw new Error("Plugin settings file identity does not match its name.");
        const definition = this.readDefinition(saved.definition, saved.instanceId);
        if (!definition) throw new Error("Installed plugin settings have no instance definition.");
        definitions.set(definition.id, definition);
        extraFiles.set(definition.id, raw);
      } catch (error) {
        hash.update(JSON.stringify([filename, raw ?? "unreadable"]));
        diagnostics.push({ message: error instanceof SyntaxError ? "Invalid JSON in an installed plugin settings file."
          : error instanceof Error ? error.message : "Cannot read installed plugin settings." });
      }
    }
    const rows: { instance: PluginProfileEntry; revision: string; error?: string; removed?: boolean }[] = await Promise.all([...definitions.values()].map(async instance => {
      let raw: string | undefined;
      try { raw = extraFiles.get(instance.id) ?? await traceFsAwait(trace, "settings.instance.readFile", fs.readFile(this.settingsPath(instance.id), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { instance, revision: "absent" };
        const message = `Cannot read settings: ${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}`;
        return { instance: { ...instance, enabled: false }, revision: message, error: message };
      }
      try {
        const saved = this.decodeSettings(raw, instance.id);
        const definition = this.readDefinition(saved.definition, instance.id) ?? instance;
        return { instance: { ...definition, ...(saved.enabled !== undefined ? { enabled: saved.enabled as boolean } : {}),
          ...(saved.config !== undefined ? { config: saved.config } : {}) }, revision: raw, removed: saved.installed === false };
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
    return { revision: hash.digest("hex"), profile: { ...base, instances: rows.filter(row => !row.removed).map(row => row.instance) },
      removedInstances: rows.filter(row => row.removed).map(row => row.instance), diagnostics };
  }

  private readDefinition(value: unknown, instanceId: string): PluginProfileEntry | undefined {
    if (value === undefined) return undefined;
    const parsed = parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: [value] });
    const definition = parsed.instances[0];
    if (!definition || definition.id !== instanceId) throw new Error("Installed plugin definition is invalid or belongs to another instance.");
    return definition;
  }

  private decodeSettings(raw: string, instanceId: string): Record<string, unknown> {
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Settings must be an object.");
    const value = saved as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.instanceId !== instanceId) throw new Error("Settings identity or version does not match this instance.");
    if (value.installed !== undefined && typeof value.installed !== "boolean") throw new Error("installed must be boolean.");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be boolean.");
    if (value.config !== undefined && (!value.config || typeof value.config !== "object" || Array.isArray(value.config))) throw new Error("config must be an object.");
    this.readDefinition(value.definition, instanceId);
    return value;
  }

  private async savedSettings(instanceId: string): Promise<Record<string, unknown>> {
    try { return this.decodeSettings(await fs.readFile(this.settingsPath(instanceId), "utf8"), instanceId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw Object.assign(new Error("Repair this plugin instance settings file before changing it.", { cause: error }), { status: 409, code: "PLUGIN_INSTANCE_SETTINGS_INVALID" });
    }
  }

  /** Membership changes share the existing settings CAS, not the immutable release profile. */
  async install(definition: PluginProfileEntry, expectedRevision: string, assertCurrent: () => void = () => {}): Promise<PluginProfileSettingsSnapshot> {
    const normalized = this.readDefinition(definition, definition.id)!;
    return this.changeMembership(normalized.id, expectedRevision, normalized, assertCurrent);
  }

  async uninstall(instanceId: string, expectedRevision: string, assertCurrent: () => void = () => {}): Promise<PluginProfileSettingsSnapshot> {
    return this.changeMembership(instanceId, expectedRevision, undefined, assertCurrent);
  }

  private async changeMembership(instanceId: string, expectedRevision: string, definition: PluginProfileEntry | undefined,
    assertCurrent: () => void): Promise<PluginProfileSettingsSnapshot> {
    assertCurrent();
    await fs.mkdir(this.options.settingsRoot, { recursive: true });
    const release = acquireFileLockSync(path.join(this.options.settingsRoot, "profile-settings.lock"), { timeoutMs: 1 });
    try {
      const current = await this.snapshot();
      assertCurrent();
      if (current.revision !== expectedRevision) throw new PluginSettingsConflict();
      if (current.diagnostics.some(row => row.instanceId === instanceId)) throw Object.assign(new Error("Repair this plugin instance settings before changing its installation."), { status: 409, code: "PLUGIN_INSTANCE_SETTINGS_INVALID" });
      const prior = [...current.profile.instances, ...current.removedInstances].find(row => row.id === instanceId);
      if (!definition && !prior) throw Object.assign(new Error("Plugin instance was not found."), { status: 404, code: "PLUGIN_INSTANCE_NOT_FOUND" });
      if (definition && prior && prior.package !== definition.package) throw Object.assign(new Error("This instance belongs to another plugin. Choose a new instance ID."), { status: 409, code: "PLUGIN_INSTANCE_ID_CONFLICT" });
      const target = this.settingsPath(instanceId);
      const saved = await this.savedSettings(instanceId);
      const value = { ...saved, schemaVersion: 1, instanceId, definition: definition ?? prior,
        installed: Boolean(definition), enabled: Boolean(definition) };
      assertCurrent();
      atomicWriteFileSync(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      return await this.snapshot();
    } finally { release(); }
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
      if (current.diagnostics.some(row => row.instanceId === instanceId)) throw Object.assign(new Error("Repair this plugin instance settings file before changing its enabled state."), { status: 409, code: "PLUGIN_INSTANCE_SETTINGS_INVALID" });
      if (!current.profile.instances.some(instance => instance.id === instanceId)) throw Object.assign(new Error("Plugin instance was not found."), { status: 404, code: "PLUGIN_INSTANCE_NOT_FOUND" });
      const target = this.settingsPath(instanceId);
      const saved = await this.savedSettings(instanceId);
      assertCurrent();
      const value = { ...saved, schemaVersion: 1, instanceId,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}) };
      atomicWriteFileSync(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      return await this.snapshot();
    } finally { release(); }
  }
}
