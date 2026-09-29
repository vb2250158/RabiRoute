import { auditRecordingArchiveMutation } from "./recordingArchiveAudit.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { storageRevisionToken } from "../shared/storageRevision.js";

export interface ArchiveAdminInput { owner: string; roleId: string; storageNamespaceId: string; provision: boolean; enabled: boolean; expectedRevision: number }
export class ArchiveAdminError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export function validateArchiveAdminInput(value: unknown): ArchiveAdminInput {
  keys(value, ["owner", "roleId", "storageNamespaceId", "provision", "enabled", "expectedRevision"]);
  if (typeof value.provision !== "boolean" || typeof value.enabled !== "boolean") throw new ArchiveAdminError(400, "invalid_request");
  return { owner: opaque(value.owner), roleId: opaque(value.roleId), storageNamespaceId: namespace(value.storageNamespaceId), provision: value.provision, enabled: value.enabled, expectedRevision: revision(value.expectedRevision) };
}
export const archiveAdminDigest = (input: ArchiveAdminInput, etag: string) => createHash("sha256").update(JSON.stringify({ input: validateArchiveAdminInput(input), etag })).digest("hex");
export const archiveSettingsEtag = (value: unknown) => `"${storageRevisionToken(value)}"`;
export interface ArchiveAdminResult { revision: number; ownerRoleBindings: Record<string, RecordingArchiveBinding>; etag: string }

import type { RecordingArchiveNamespace } from "./recordingArchiveStore.js";

export interface RecordingArchiveBinding { roleId: string; storageNamespaceId: string; bindingRevision: number; enabled: boolean }
interface Configuration { schemaVersion: 1; revision: number; ownerRoleBindings: Record<string, RecordingArchiveBinding> }
const opaque = (v: unknown): string => { if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v) || ["__proto__", "prototype", "constructor"].includes(v)) throw new Error("Invalid archive binding identity"); return v; };
const namespace = (v: unknown): string => { if (typeof v !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) || v === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid namespace"); return v; };
const revision = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("Invalid revision"); return v; };
function keys(v: unknown, expected: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== expected.length || Object.keys(v).some(k => !expected.includes(k))) throw new Error("Invalid binding configuration");
}
async function directory(p: string) { const s = await fs.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe archive directory"); }
async function readJson(file: string) { const s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024) throw new Error("Unsafe configuration file"); return JSON.parse(await fs.readFile(file, "utf8")); }

/** Local administrative configuration only. Upload bodies must never reach configure/provisionNamespace.
 * Owner is the authenticated persistent device identity, never a token-derived scope.
 * A stale lock fails closed; no automatic lock breaking or role migration is performed.
 */
export class RecordingArchiveBindings {
  private readonly file: string;
  constructor(private readonly stateDir: string, private readonly roleDirectory: (roleId: string) => string, configFile = path.join(stateDir, "resource-cache.json")) {
    if (!path.isAbsolute(stateDir) || /^(\\\\|\/\/)/.test(stateDir)) throw new Error("Bindings require a local absolute state directory");
    if (!path.isAbsolute(configFile) || path.dirname(path.resolve(configFile)) !== path.resolve(stateDir)) throw new Error("Configuration must remain in local state directory");
    this.file = configFile;
  }
  private async root(roleId: string): Promise<string> {
    opaque(roleId);
    const role = this.roleDirectory(roleId);
    if (!path.isAbsolute(role)) throw new Error("Role directory must be absolute");
    await directory(role);
    const parent = path.join(role, "all-day-recording");
    await directory(parent); // Never recursively recreate a missing NAS role tree.
    return path.join(parent, "media-archive");
  }
  private async marker(root: string, id: string) {
    await directory(root);
    const value = await readJson(path.join(root, "namespace.json"));
    keys(value, ["schemaVersion", "storageNamespaceId"]);
    if (value.schemaVersion !== 1 || value.storageNamespaceId !== namespace(id)) throw new Error("Archive namespace mismatch");
  }
  /** Explicit administrative provisioning; read and resolve never create a namespace. */
  async provisionNamespace(roleId: string, storageNamespaceId: string): Promise<RecordingArchiveNamespace> {
    return auditRecordingArchiveMutation("recording-archive-bindings", roleId + ":" + storageNamespaceId, async () => {
      namespace(storageNamespaceId);
      const root = await this.root(roleId);
      try { await fs.mkdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      await directory(root);
      const marker = path.join(root, "namespace.json"), temporary = marker + "." + randomUUID() + ".partial";
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, storageNamespaceId })); await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, marker); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      } finally { await fs.rm(temporary, { force: true }); }
      await this.marker(root, storageNamespaceId);
      return { root, storageNamespaceId };
    });
  }
  private async envelope(): Promise<Record<string, unknown>> {
    await directory(this.stateDir);
    try {
      const value = await readJson(this.file);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings envelope");
      return value;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  }
  private async configuration(envelope?: Record<string, unknown>): Promise<Configuration> {
    const value: unknown = (envelope ?? await this.envelope()).archiveBindings;
    if (value === undefined) return { schemaVersion: 1, revision: 0, ownerRoleBindings: Object.create(null) };
    keys(value, ["schemaVersion", "revision", "ownerRoleBindings"]);
    if (value.schemaVersion !== 1) throw new Error("Unsupported binding schema");
    revision(value.revision);
    const map = value.ownerRoleBindings;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Invalid bindings map");
    const result: Record<string, RecordingArchiveBinding> = Object.create(null);
    for (const [owner, raw] of Object.entries(map)) {
      opaque(owner); keys(raw, ["roleId", "storageNamespaceId", "bindingRevision", "enabled"]);
      const bindingRevision = revision(raw.bindingRevision);
      if (typeof raw.enabled !== "boolean" || bindingRevision < 1 || bindingRevision > (value.revision as number)) throw new Error("Invalid binding revision/state");
      result[owner] = { roleId: opaque(raw.roleId), storageNamespaceId: namespace(raw.storageNamespaceId), bindingRevision, enabled: raw.enabled };
    }
    return { schemaVersion: 1, revision: value.revision as number, ownerRoleBindings: result };
  }
  /** Local configuration lookup only; includes disabled bindings for administrative status. */
  async lookupOwner(owner: string): Promise<RecordingArchiveBinding | null> {
    opaque(owner);
    const binding = (await this.configuration()).ownerRoleBindings[owner];
    return binding ? { ...binding } : null;
  }
  /** Detached startup snapshot. Does not probe archive storage or imply NAS readiness. */
  async listBindings(): Promise<{ revision: number; ownerRoleBindings: Record<string, RecordingArchiveBinding> }> {
    const config = await this.configuration();
    const ownerRoleBindings: Record<string, RecordingArchiveBinding> = Object.create(null);
    for (const [owner, binding] of Object.entries(config.ownerRoleBindings)) ownerRoleBindings[owner] = { ...binding };
    return { revision: config.revision, ownerRoleBindings };
  }
  /** Offline catalog authorization: derive a path through the trusted resolver without touching NAS.
   * This is not a storage/durability check; writers must use resolveOwner instead. */
  async describeOwner(owner: string): Promise<RecordingArchiveNamespace & RecordingArchiveBinding> {
    const binding = await this.lookupOwner(owner);
    if (!binding || !binding.enabled) throw new Error("Archive owner is not enabled");
    const role = this.roleDirectory(opaque(binding.roleId));
    if (!path.isAbsolute(role)) throw new Error("Role directory must be absolute");
    return { ...binding, root: path.join(role, "all-day-recording", "media-archive") };
  }
  async resolveOwner(owner: string): Promise<RecordingArchiveNamespace & RecordingArchiveBinding> {
    const description = await this.describeOwner(owner);
    const root = await this.root(description.roleId);
    if (path.resolve(root) !== path.resolve(description.root)) throw new Error("Role directory changed during resolution");
    await this.marker(root, description.storageNamespaceId);
    return description;
  }
  async recoverAdministrative(operationId: string, requestDigest: string): Promise<ArchiveAdminResult | null> {
    const envelope = await this.envelope();
    const stamp = envelope.archiveAdminCommit as { operationId?: string; requestDigest?: string; result?: ArchiveAdminResult } | undefined;
    if (stamp?.operationId !== operationId || stamp.requestDigest !== requestDigest || !stamp.result) return null;
    const current = await this.listBindings();
    if (archiveSettingsEtag(current) !== stamp.result.etag) return null;
    return stamp.result;
  }
  /** All preconditions are checked under the SAME settings lock before any NAS provisioning.
   * The operation stamp is committed with configuration, not inferred from equal binding values. */
  async configureAdministrative(raw: ArchiveAdminInput, expectedEtag: string, operationId: string): Promise<ArchiveAdminResult> {
    const input = validateArchiveAdminInput(raw);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new ArchiveAdminError(400, "invalid_idempotency_key");
    const digest = archiveAdminDigest(input, expectedEtag);
    return withResourceCacheSettingsLock(this.file, async () => {
      const envelope = await this.envelope();
      const config = await this.configuration(envelope);
      const snapshot = { revision: config.revision, ownerRoleBindings: config.ownerRoleBindings };
      const old = config.ownerRoleBindings[input.owner];
      if (expectedEtag !== archiveSettingsEtag(snapshot) || (old?.bindingRevision ?? 0) !== input.expectedRevision)
        throw new ArchiveAdminError(412, "revision_conflict");
      if (old && (old.roleId !== input.roleId || old.storageNamespaceId !== input.storageNamespaceId))
        throw new ArchiveAdminError(409, "binding_migration_required");
      if (input.provision) await this.provisionNamespace(input.roleId, input.storageNamespaceId);
      const root = await this.root(input.roleId);
      await this.marker(root, input.storageNamespaceId);
      const next = revision(config.revision + 1);
      config.revision = next;
      config.ownerRoleBindings[input.owner] = { roleId: input.roleId, storageNamespaceId: input.storageNamespaceId, enabled: input.enabled, bindingRevision: next };
      const resultSnapshot = { revision: next, ownerRoleBindings: config.ownerRoleBindings };
      const result: ArchiveAdminResult = { ...resultSnapshot, etag: archiveSettingsEtag(resultSnapshot) };
      await auditRecordingArchiveMutation("recording-archive-bindings", this.file, async () => {
        const temporary = this.file + "." + randomUUID() + ".partial";
        try {
          const handle = await fs.open(temporary, "wx");
          try { await handle.writeFile(JSON.stringify({ ...envelope, archiveBindings: config, archiveAdminCommit: { operationId, requestDigest: digest, result } })); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, this.file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      return result;
    });
  }
  /** expectedRevision is this owner's bindingRevision; zero means it must not exist. */
  async configure(owner: string, roleId: string, storageNamespaceId: string, expectedRevision: number, enabled = true): Promise<RecordingArchiveBinding> {
    opaque(owner); opaque(roleId); namespace(storageNamespaceId); revision(expectedRevision);
    if (typeof enabled !== "boolean") throw new Error("Invalid enabled state");
    await directory(this.stateDir);
    return withResourceCacheSettingsLock(this.file, async () => {
      const envelope = await this.envelope();
      const config = await this.configuration(envelope), old = config.ownerRoleBindings[owner];
      if ((old?.bindingRevision ?? 0) !== expectedRevision) throw new Error("Binding revision conflict");
      if (old && (old.roleId !== roleId || old.storageNamespaceId !== storageNamespaceId)) throw new Error("Binding migration requires an explicit separate workflow");
      const root = await this.root(roleId);
      await this.marker(root, storageNamespaceId); // Provision must have succeeded explicitly first.
      if (old && old.enabled === enabled) return { ...old };
      const next = revision(config.revision + 1);
      const binding = { roleId, storageNamespaceId, bindingRevision: next, enabled };
      config.revision = next; config.ownerRoleBindings[owner] = binding;
      await auditRecordingArchiveMutation("recording-archive-bindings", this.file, async () => {
        const temporary = this.file + "." + randomUUID() + ".partial";
        try {
          const handle = await fs.open(temporary, "wx");
          try { await handle.writeFile(JSON.stringify({ ...envelope, archiveBindings: config })); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, this.file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      return { ...binding };
    });
  }
}

/** Shared by all resource-cache settings writers. Zero-wait contention is explicitly retriable;
 * a crash-left lock requires administrative recovery, never automatic stale-lock deletion. */
export async function withResourceCacheSettingsLock<T>(configFile: string, action: () => Promise<T>): Promise<T> {
  const lockFile = configFile + ".lock";
  const lock = await fs.open(lockFile, "wx");
  try { return await action(); }
  finally { await lock.close(); await fs.rm(lockFile); }
}
