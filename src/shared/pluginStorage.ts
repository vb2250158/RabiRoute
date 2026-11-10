import { resolvePluginPackageRoots } from "./pluginPackageRoots.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { applicationRuntimeLayout, type RuntimeLayout } from "./runtimeLayout.js";
import { atomicWriteFileSync } from "./filePersistence.js";

function component(value: string): string {
  if (!value) throw new Error("Plugin storage identity is empty.");
  // Distinct accepted identities must also remain distinct on Windows filesystems.
  const characters = Array.from(value), trailingDots = /\.+$/.exec(value)?.[0].length ?? 0;
  const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(value);
  return characters.map((character, index) => /^[A-Z]$/.test(character) || character === "*"
    || character === "." && index >= characters.length - trailingDots || reserved && index === 0
    ? `%${character.charCodeAt(0).toString(16)}` : encodeURIComponent(character)).join("");
}

/** Source and package versions never select the location of formal plugin data. */
export function pluginStorageRoot(pluginId: string, instanceId?: string, layout: RuntimeLayout = applicationRuntimeLayout()): string {
  const root = path.join(layout.stateRoot, "data", "plugins", component(pluginId));
  return instanceId === undefined ? root : path.join(root, "instances", component(instanceId));
}

export type PluginStorageMigration = Readonly<{
  id: string;
  kind: "file" | "directory" | "external-reference";
  source: Readonly<{ root: "state" | "localAppData"; path: string }>;
  target: string;
  unlessEnvironment?: string;
  unlessConfig?: string;
  resource?: string;
}>;
export type PluginStorageMigrationDeclaration = Readonly<{ schemaVersion: 1; scope: "plugin" | "instance"; migrations: readonly PluginStorageMigration[] }>;
/** Supplied by the accepted updater's original owner metadata; never discovered by scanning caches. */
export type PluginStorageLegacySource = Readonly<{ pluginId: string; migrationId: string; sourcePath: string }>;
export type PluginStorageMigrationResult = Readonly<{
  pluginId: string; instanceId?: string; migrationId: string;
  status: "migrated" | "unchanged" | "custom_path" | "pending" | "failed";
  source?: string; target?: string; backupPath?: string; message?: string;
  inputFingerprint?: string;
}>;

// Startup diagnostics are derived from the single explicit migration run, never business data or a second ledger.
const migrationFailures = new Map<string, Map<string, Error>>();
function failureOwner(pluginId: string, instanceId?: string): string { return JSON.stringify([pluginId, instanceId ?? null]); }
function failureScope(stateRoot: string): string { return process.platform === "win32" ? path.resolve(stateRoot).toLowerCase() : path.resolve(stateRoot); }
function failuresFor(stateRoot: string): Map<string, Error> {
  const key = failureScope(stateRoot);
  let failures = migrationFailures.get(key);
  if (!failures) { failures = new Map(); migrationFailures.set(key, failures); }
  return failures;
}
export function pluginStorageMigrationFailure(pluginId: string, stateRoot = applicationRuntimeLayout().stateRoot, instanceId?: string): Error | undefined {
  const failures = migrationFailures.get(failureScope(stateRoot));
  return failures?.get(failureOwner(pluginId)) ?? (instanceId === undefined ? undefined : failures?.get(failureOwner(pluginId, instanceId)));
}

/** An adopted external resource is an explicit editable binding, not a search of retired storage paths. */
export function pluginStorageResourceRoot(pluginId: string, resource: string, defaultRelative: string, layout: RuntimeLayout = applicationRuntimeLayout()): string {
  const root = pluginStorageRoot(pluginId, undefined, layout), file = path.join(root, "resources.json");
  let value: { schemaVersion: number; resources: Record<string, unknown> };
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return inside(root, defaultRelative); throw new Error("Plugin resource binding is unreadable; repair its resources.json before continuing.", { cause: error }); }
  if (value?.schemaVersion !== 1 || !value.resources || typeof value.resources !== "object" || Array.isArray(value.resources)) throw new Error("Plugin resource binding schema is invalid.");
  const selected = value.resources[resource];
  if (selected === undefined) return inside(root, defaultRelative);
  if (typeof selected !== "string" || !path.isAbsolute(selected)) throw new Error("Plugin resource binding must be an absolute path.");
  return path.resolve(selected);
}

function inside(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error("Plugin storage migration paths must be relative.");
  const target = path.resolve(root, relative), suffix = path.relative(path.resolve(root), target);
  if (!suffix || suffix.startsWith("..") || path.isAbsolute(suffix)) throw new Error("Plugin storage migration path escapes its owner root.");
  return target;
}
function exists(filename: string): boolean {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function digestTree(root: string): string {
  const digest = createHash("sha256");
  const visit = (filename: string, relative: string): void => {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) { digest.update(JSON.stringify([relative, "link", fs.readlinkSync(filename)])); return; }
    if (stat.isDirectory()) {
      digest.update(JSON.stringify([relative, "directory"]));
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name), path.join(relative, name));
      return;
    }
    if (!stat.isFile()) throw new Error("Plugin storage migration encountered an unsupported file type.");
    digest.update(JSON.stringify([relative, stat.size]));
    const descriptor = fs.openSync(filename, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
    try { let count: number; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(descriptor); }
  };
  visit(root, ""); return digest.digest("hex");
}

/** Metadata only, scoped to the exact declared resource being copied. Discovery runs in a bounded child. */
function migrationSourceMetadata(source: string, kind: PluginStorageMigration["kind"]): unknown[] {
  const metadata: unknown[] = [];
  const visit = (filename: string): void => {
    const stat = fs.lstatSync(filename);
    metadata.push([path.relative(source, filename), stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]);
    if (kind === "directory" && stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name));
    }
  };
  visit(source); return metadata;
}

/** Invoke only at full-generation startup after the previous application owners retired. */
export function applyPluginStorageMigrations(input: Readonly<{
  phase: "owners-retired"; pluginId: string; instanceId?: string; declaration: PluginStorageMigrationDeclaration;
  layout?: RuntimeLayout; config?: Readonly<Record<string, unknown>>; environment?: NodeJS.ProcessEnv;
  localAppDataRoot?: string; legacyStateRoot?: string; legacySources?: readonly PluginStorageLegacySource[]; readOnly?: boolean;
  /** Only constrains adoption of an existing old shared source, never a new namespace. */
  ambiguousLegacyOwner?: boolean;
  migrationPolicy?: "inspect" | "defer";
  confirmedMigrationIds?: readonly string[];
}>): readonly PluginStorageMigrationResult[] {
  if (input.phase !== "owners-retired") throw new Error("Plugin storage migration requires retired application owners.");
  const layout = input.layout ?? applicationRuntimeLayout(), environment = input.environment ?? process.env;
  const ownerRoot = pluginStorageRoot(input.pluginId, input.instanceId, layout), results: PluginStorageMigrationResult[] = [];
  failuresFor(layout.stateRoot).delete(failureOwner(input.pluginId, input.instanceId));
  for (const migration of input.declaration.migrations) {
    const identity = { pluginId: input.pluginId, ...(input.instanceId ? { instanceId: input.instanceId } : {}), migrationId: migration.id };
    let source: string | undefined, target: string | undefined, backupPath: string | undefined, staged: string | undefined;
    try {
      if (!migration.id || !["file", "directory", "external-reference"].includes(migration.kind)
        || !migration.source || !["state", "localAppData"].includes(migration.source.root)
        || typeof migration.source.path !== "string" || typeof migration.target !== "string"
        || migration.kind === "external-reference" && (migration.target !== "resources.json" || input.instanceId !== undefined)) {
        throw new Error("Invalid plugin storage migration resource declaration.");
      }
      if (migration.unlessEnvironment && environment[migration.unlessEnvironment]?.trim()
        || migration.unlessConfig && typeof input.config?.[migration.unlessConfig] === "string" && (input.config[migration.unlessConfig] as string).trim()) {
        results.push({ ...identity, status: "custom_path" }); continue;
      }
      target = inside(ownerRoot, migration.target);
      if (input.legacyStateRoot !== undefined && !path.isAbsolute(input.legacyStateRoot)) throw new Error("The exact legacy plugin state root must be absolute.");
      const legacySources = input.legacySources?.filter(item => item.pluginId === input.pluginId && item.migrationId === migration.id) ?? [];
      if (legacySources.length > 1) throw new Error("The original updater supplied conflicting legacy source claims for this resource.");
      const exactSource = legacySources[0]?.sourcePath;
      if (exactSource !== undefined && (!path.isAbsolute(exactSource) || path.resolve(exactSource) === path.parse(path.resolve(exactSource)).root)) {
        throw new Error("An exact legacy resource source must be an absolute file or directory below its volume root.");
      }
      source = exactSource === undefined ? inside(migration.source.root === "state" ? (input.legacyStateRoot ?? layout.stateRoot)
        : (input.localAppDataRoot ?? environment.LOCALAPPDATA?.trim()) || os.tmpdir(), migration.source.path) : path.resolve(exactSource);
      backupPath = inside(path.join(layout.stateRoot, "data", ".runtime", "plugin-storage-backups", "0.7", component(input.pluginId),
        input.instanceId ? component(input.instanceId) : "shared"), component(migration.id));
      const receiptPath = path.join(backupPath, "receipt.json");
      // Metadata discovery never hashes/copies the store or resumes a transaction.
      // An already prepared transaction belongs to ordinary recovery, not new consent.
      if (input.migrationPolicy) {
        const previous = exists(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) : undefined;
        const settled = previous?.schemaVersion === 1 && previous.target === target
          && ["migrated", "fresh", "external_reference"].includes(previous.status)
          && !(previous.status === "fresh" && previous.source !== source && (exactSource !== undefined || input.legacyStateRoot !== undefined));
        if (input.migrationPolicy === "inspect") {
          results.push({ ...identity, source, target, backupPath,
            inputFingerprint: createHash("sha256").update(JSON.stringify([migration, source, target,
              exists(source) ? migrationSourceMetadata(source, migration.kind) : null,
              exists(target) ? fs.lstatSync(target).mtimeMs : null])).digest("hex"),
            status: !settled && previous?.status !== "prepared" && exists(source) ? "pending" : "unchanged" });
          continue;
        }
        if (!settled && previous?.status !== "prepared" && exists(source)
          && !input.confirmedMigrationIds?.includes(JSON.stringify([input.pluginId, input.instanceId ?? null, migration.id]))) {
          const message = "Storage upgrade awaits confirmation in the WebGUI overview and the next application restart.";
          failuresFor(layout.stateRoot).set(failureOwner(input.pluginId, input.instanceId), new Error(message));
          results.push({ ...identity, source, target, backupPath, status: "pending", message });
          continue;
        }
      }
      let recoveryDigest: string | undefined;
      let adoptingFreshSource = false;
      if (exists(receiptPath)) {
        const previous = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
        if (previous.schemaVersion === 1 && previous.target === target && ["migrated", "fresh", "external_reference"].includes(previous.status)) {
          if (previous.status === "fresh" && (exactSource !== undefined || input.legacyStateRoot !== undefined) && previous.source !== source) {
            if (exists(target)) throw new Error("An exact original source was supplied after new storage already exists; preserve and reconcile both claims.");
            if (input.readOnly) throw new Error("Read-only startup preserved the newly identified original storage for writable adoption.");
            atomicWriteFileSync(path.join(backupPath, "fresh-source-before-adoption.json"), JSON.stringify(previous, null, 2), { mode: 0o600 });
            adoptingFreshSource = true;
          } else {
            results.push({ ...identity, target, backupPath, status: "unchanged" }); continue;
          }
        }
        if (!adoptingFreshSource) {
          if (previous.schemaVersion !== 1 || previous.status !== "prepared" || previous.source !== source || previous.target !== target
            || typeof previous.originalDigest !== "string" || previous.targetDigest !== previous.originalDigest
            || digestTree(path.join(backupPath, "raw")) !== previous.originalDigest) {
            throw new Error("The original migration recovery receipt or raw backup does not prove this owner; inspect its preserved files.");
          }
          const sourcePresent = exists(source);
          if (sourcePresent && digestTree(source) !== previous.originalDigest) throw new Error("Original storage changed after migration preparation; preserve both claims and resolve the conflict.");
          if (exists(target)) {
            if (digestTree(target) !== previous.targetDigest) throw new Error("Published storage conflicts with the original prepared migration; neither claim was overwritten.");
            if (input.readOnly) throw new Error("Read-only startup preserved a verified prepared migration; writable startup can finish its original receipt.");
            if (sourcePresent) fs.rmSync(source, { recursive: migration.kind === "directory" });
            atomicWriteFileSync(receiptPath, JSON.stringify({ ...previous, status: "migrated" }, null, 2), { mode: 0o600 });
            results.push({ ...identity, source, target, backupPath, status: "migrated", message: "Finished the original verified publication." }); continue;
          }
          if (!sourcePresent) throw new Error("Both original and published storage are absent; preserve the recovery backup for explicit owner recovery.");
          recoveryDigest = previous.originalDigest;
        }
      }
      if (migration.kind === "external-reference" && exists(target)) {
        pluginStorageResourceRoot(input.pluginId, migration.resource ?? "runtime", "runtime", layout);
        results.push({ ...identity, target, status: "custom_path" }); continue;
      }
      if (!exists(source)) {
        if (!input.readOnly) {
          fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
          atomicWriteFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, ...identity, source, target, status: "fresh" }), { mode: 0o600 });
        }
        results.push({ ...identity, source, target, status: "unchanged" }); continue;
      }
      if (input.ambiguousLegacyOwner && !recoveryDigest) throw new Error("Legacy storage has no unambiguous instance owner; identify its original instance before migrating.");
      if (exists(target)) throw new Error("Both legacy and plugin-owned storage exist; inspect the original files and resolve the conflict without overwriting either owner.");
      if (input.readOnly) throw new Error("This plugin requires its one-time storage migration; read-only startup preserved the original files.");
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || (migration.kind === "file" ? !stat.isFile() : !stat.isDirectory())) throw new Error("Legacy plugin storage does not match the declared resource type.");
      if (!recoveryDigest && !adoptingFreshSource && exists(backupPath)) throw new Error("An earlier migration recovery directory exists; inspect its original receipt before continuing.");
      fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
      if (migration.kind === "external-reference") {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(target, JSON.stringify({ schemaVersion: 1, resources: { [migration.resource ?? "runtime"]: source } }, null, 2), { mode: 0o600 });
        atomicWriteFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, ...identity, source, target, status: "external_reference" }), { mode: 0o600 });
        results.push({ ...identity, source, target, backupPath, status: "migrated", message: "Existing external runtime adopted without moving its VM, media, credentials or ledger." });
        continue;
      }
      const raw = path.join(backupPath, "raw"), originalDigest = recoveryDigest ?? digestTree(source);
      if (!recoveryDigest) fs.cpSync(source, raw, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (digestTree(raw) !== originalDigest) throw new Error("Private raw migration backup failed its content check.");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      staged = inside(ownerRoot, `${migration.target}.migration-${randomUUID()}`);
      fs.cpSync(raw, staged, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (digestTree(staged) !== originalDigest) throw new Error("Plugin storage candidate failed its raw content check.");
      const targetDigest = digestTree(staged);
      atomicWriteFileSync(path.join(backupPath, "receipt.json"), JSON.stringify({ schemaVersion: 1, ...identity, source, target,
        originalDigest, targetDigest, status: "prepared" }, null, 2), { mode: 0o600 });
      fs.renameSync(staged, target);
      staged = undefined;
      if (digestTree(target) !== targetDigest) throw new Error("Published plugin storage failed its content check.");
      // The source is resolved from its declared owner root or exact updater-provided resource path above.
      fs.rmSync(source, { recursive: migration.kind === "directory" });
      atomicWriteFileSync(path.join(backupPath, "receipt.json"), JSON.stringify({ schemaVersion: 1, ...identity, source, target,
        originalDigest, targetDigest, status: "migrated" }, null, 2), { mode: 0o600 });
      results.push({ ...identity, source, target, backupPath, status: "migrated" });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (staged) {
        try { fs.rmSync(staged, { recursive: migration.kind === "directory", force: true }); }
        catch (cleanupError) { message += ` Candidate cleanup failed at ${staged}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`; }
      }
      failuresFor(layout.stateRoot).set(failureOwner(input.pluginId, input.instanceId), new Error(`Plugin storage migration ${migration.id} failed: ${message}`));
      results.push({ ...identity, source, target, backupPath, status: "failed", message });
    }
  }
  return results;
}

/** Single application startup entrance; reads the original profile/settings owner and each selected package's data declaration. */
export async function prepareApplicationPluginStorage(options: Readonly<{
  phase: "owners-retired"; readOnly?: boolean; layout?: RuntimeLayout; profilePath?: string; settingsRoot?: string;
  packageRoots?: readonly string[]; localAppDataRoot?: string; legacyStateRoot?: string; legacySources?: readonly PluginStorageLegacySource[];
  environment?: NodeJS.ProcessEnv; migrationsPath?: string;
  migrationPolicy?: "inspect" | "defer";
  confirmedMigrationIds?: readonly string[];
}>): Promise<readonly PluginStorageMigrationResult[]> {
  const layout = options.layout ?? applicationRuntimeLayout();
  const environment = options.environment ?? process.env;
  const { PluginProfileSettings } = await import("../plugin-runtime-host/profileSettings.js");
  const { PluginPackageCatalog } = await import("../plugin-kernel/profile.js");
  const profilePath = options.profilePath ?? (environment.RABIROUTE_PLUGIN_PROFILE?.trim()
    ? path.resolve(environment.RABIROUTE_PLUGIN_PROFILE.trim()) : path.join(layout.packageRoot, "dist", "plugins", "profiles", "desktop.json"));
  const snapshot = await new PluginProfileSettings({ profilePath, settingsRoot: options.settingsRoot ?? path.join(layout.stateRoot, "data", "plugins", "settings"),
    migrationsPath: options.migrationsPath ?? path.join(layout.packageRoot, "dist", "plugins", "profiles", "package-migrations.json") }).snapshot();
  const catalog = new PluginPackageCatalog(options.packageRoots ?? resolvePluginPackageRoots(layout, environment));
  const results: PluginStorageMigrationResult[] = [], packages = new Map<string, typeof snapshot.profile.instances[number][]>();
  for (const instance of snapshot.profile.instances) packages.set(instance.package, [...(packages.get(instance.package) ?? []), instance]);
  try {
    for (const [pluginId, instances] of packages) {
      if (options.migrationPolicy !== "inspect") failuresFor(layout.stateRoot).delete(failureOwner(pluginId));
      try {
        const declarations = new Map<string, PluginStorageMigrationDeclaration | undefined>();
        const sharedDeclarations = new Set<string>();
        const ownerResults: PluginStorageMigrationResult[] = [];
        for (const instance of instances) {
          if (!declarations.has(instance.version)) {
            const source = await catalog.resolve(pluginId, instance.version), filename = path.join(source.sourceRoot, "storage-migrations.json");
            const declaration = exists(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) as PluginStorageMigrationDeclaration : undefined;
            if (declaration && (declaration.schemaVersion !== 1 || !["plugin", "instance"].includes(declaration.scope) || !Array.isArray(declaration.migrations))) throw new Error("Invalid plugin storage migration declaration.");
            declarations.set(instance.version, declaration);
          }
          const declaration = declarations.get(instance.version);
          if (!declaration) continue;
          if (declaration.scope === "plugin") {
            const key = JSON.stringify(declaration);
            if (sharedDeclarations.has(key)) continue;
            sharedDeclarations.add(key);
          }
          const config = { ...(instance.config as Record<string, unknown>) };
          if (declaration.scope === "plugin") for (const migration of declaration.migrations) {
            if (migration.unlessConfig && !instances.every(item => typeof (item.config as Record<string, unknown>)[migration.unlessConfig!] === "string"
              && ((item.config as Record<string, unknown>)[migration.unlessConfig!] as string).trim())) delete config[migration.unlessConfig];
          }
          ownerResults.push(...applyPluginStorageMigrations({ ...options, layout, pluginId,
            ...(declaration.scope === "instance" ? { instanceId: instance.id, ambiguousLegacyOwner: instances.length > 1 } : {}), declaration,
            config }));
        }
        for (const failed of ownerResults.filter(result => result.status === "failed" && options.migrationPolicy !== "inspect")) {
          failuresFor(layout.stateRoot).set(failureOwner(pluginId, failed.instanceId), new Error(`Plugin storage migration ${failed.migrationId} failed: ${failed.message}`));
        }
        results.push(...ownerResults);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.migrationPolicy !== "inspect") failuresFor(layout.stateRoot).set(failureOwner(pluginId), new Error(`Plugin storage migration could not prepare: ${message}`));
        results.push({ pluginId, migrationId: "declaration", status: "failed", message });
      }
    }
  } finally { await catalog.dispose(); }
  return results;
}
