import { auditRecordingArchiveMutation } from "./recordingArchiveAudit.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateRecordingManifest, recordingManifestHash, validateArchiveReceipt,
  type RecordingManifest, type ArchiveReceipt } from "./recordingArchiveContract.js";

export const RECORDING_ARCHIVE_MAX_MANIFEST_BYTES = 1024 * 1024;
// Disk envelope includes receipt and ownership metadata; distinct from the wire manifest limit.
const MAX_RECORD_ENVELOPE_BYTES = 4 * 1024 * 1024;

export interface RecordingArchiveNamespace { root: string; storageNamespaceId: string }
export interface RecordingArchiveStoreOptions {
  resolveOwner(owner: string): Promise<RecordingArchiveNamespace>;
  workerId(): string;
  committed?(owner: string, manifest: RecordingManifest, receipt: ArchiveReceipt): Promise<void> | void;
}
const sha = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
const identity = (value: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid archive identity"); return value; };
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid archive hash"); return value; };
const namespace = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) || value === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid archive namespace");
  return value;
};
/** No TTL and no legacy-cache fallback. The atomic record envelope is the manifest AND receipt truth.
 * Publication requires same-filesystem hard-link support; unsupported NAS filesystems fail closed.
 * fsync is an application-level flush, not a claim about NAS hardware durability.
 */
export class RecordingArchiveStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly options: RecordingArchiveStoreOptions) {}
  private async serial<T>(owner: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(owner) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.locks.set(owner, current);
    try { return await current; } finally { if (this.locks.get(owner) === current) this.locks.delete(owner); }
  }
  private async existingRoot(root: string) {
    if (!path.isAbsolute(root)) throw new Error("Archive root must be absolute");
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Archive root must be an existing directory");
  }
  /** Local configuration operation only. Never called by read, upload or capability discovery. */
  async provision(target: RecordingArchiveNamespace): Promise<void> {
    namespace(target.storageNamespaceId); await this.existingRoot(target.root);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, storageNamespaceId: target.storageNamespaceId }));
    const marker = path.join(target.root, "namespace.json");
    await this.publish(marker, bytes);
    await this.checkMarker(target);
  }
  private async checkMarker(target: RecordingArchiveNamespace) {
    namespace(target.storageNamespaceId); await this.existingRoot(target.root);
    const marker = path.join(target.root, "namespace.json");
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid namespace marker");
    const value = JSON.parse(await fs.readFile(marker, "utf8"));
    if (value.schemaVersion !== 1 || value.storageNamespaceId !== target.storageNamespaceId) throw new Error("Archive namespace mismatch");
  }
  private async resolve(owner: string): Promise<RecordingArchiveNamespace> {
    identity(owner);
    const target = await this.options.resolveOwner(owner);
    await this.checkMarker(target); return target;
  }
  private async directory(target: RecordingArchiveNamespace, components: string[], create: boolean) {
    await this.checkMarker(target);
    let current = target.root;
    for (const component of components) {
      current = path.join(current, component);
      if (create) { try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe archive directory");
    }
    return current;
  }
  private async regular(file: string, max: number): Promise<Buffer> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("Invalid archive file");
    return fs.readFile(file);
  }
  /** Atomic no-replace publication, including between independent Store processes. */
  private async publish(file: string, body: Buffer): Promise<boolean> {
    return auditRecordingArchiveMutation("recording-archive-store", file, async () => {
      const temporary = file + "." + randomUUID() + ".partial";
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, file); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      } finally { await fs.rm(temporary, { force: true }); }
    });
  }
  async capabilities(owner: string) {
    const target = await this.resolve(owner);
    return { protocol: "record-archive-v1", storageNamespaceId: target.storageNamespaceId,
      workerId: identity(this.options.workerId()), maxObjectBytes: 1024 * 1024, maxManifestBytes: RECORDING_ARCHIVE_MAX_MANIFEST_BYTES };
  }
  async putObject(owner: string, objectHash: string, body: Buffer) {
    hash(objectHash);
    if (!body.length || body.length > 1024 * 1024 || sha(body) !== objectHash) throw new Error("Archive object checksum/size mismatch");
    const target = await this.resolve(owner);
    const directory = await this.directory(target, ["objects", sha(owner), objectHash.slice(0, 2)], true);
    const file = path.join(directory, objectHash);
    await this.publish(file, body);
    const retained = await this.readObject(owner, objectHash);
    if (!retained.equals(body)) throw new Error("Archive object conflict");
    return { sha256: objectHash, bytes: body.length, storageNamespaceId: target.storageNamespaceId };
  }
  async readObject(owner: string, objectHash: string): Promise<Buffer> {
    hash(objectHash); const target = await this.resolve(owner);
    const directory = await this.directory(target, ["objects", sha(owner), objectHash.slice(0, 2)], false);
    const bytes = await this.regular(path.join(directory, objectHash), 1024 * 1024);
    if (!bytes.length || sha(bytes) !== objectHash) throw new Error("Archive object integrity failure");
    return bytes;
  }
  private async assertTarget(owner: string, target: RecordingArchiveNamespace) {
    const current = await this.resolve(owner);
    if (path.resolve(current.root) !== path.resolve(target.root) || current.storageNamespaceId !== target.storageNamespaceId)
      throw new Error("Archive binding changed during operation");
  }
  private async verifyMedia(owner: string, manifest: RecordingManifest, target: RecordingArchiveNamespace) {
    let segmentIndex = 0, segmentOffset = 0;
    let digest = createHash("sha256");
    for (const object of manifest.objects) {
      await this.assertTarget(owner, target);
      const directory = await this.directory(target, ["objects", sha(owner), object.sha256.slice(0, 2)], false);
      const bytes = await this.regular(path.join(directory, object.sha256), 1024 * 1024);
      if (sha(bytes) !== object.sha256) throw new Error("Archive object integrity failure");
      if (bytes.length !== object.bytes) throw new Error("Archive object length mismatch");
      let offset = 0;
      while (offset < bytes.length) {
        const segment = manifest.segments[segmentIndex];
        if (!segment) throw new Error("Archive segment overflow");
        const count = Math.min(segment.bytes - segmentOffset, bytes.length - offset);
        digest.update(bytes.subarray(offset, offset + count)); offset += count; segmentOffset += count;
        if (segmentOffset === segment.bytes) {
          if (digest.digest("hex") !== segment.sha256) throw new Error("Archive segment integrity failure");
          segmentIndex++; segmentOffset = 0; digest = createHash("sha256");
        }
      }
    }
    if (segmentIndex !== manifest.segments.length || segmentOffset) throw new Error("Incomplete archive segments");
  }
  private async envelope(owner: string, recordId: string) {
    identity(recordId); const target = await this.resolve(owner);
    const directory = await this.directory(target, ["manifests", sha(owner)], false);
    const raw = JSON.parse((await this.regular(path.join(directory, sha(recordId) + ".json"), MAX_RECORD_ENVELOPE_BYTES)).toString("utf8"));
    if (raw.schemaVersion !== 1 || raw.ownerHash !== sha(owner)) throw new Error("Archive owner mismatch");
    const manifest = validateRecordingManifest(raw.manifest);
    if (manifest.deviceId !== owner) throw new Error("Archive device owner mismatch");
    if (manifest.recordId !== recordId) throw new Error("Archive record mismatch");
    const receipt = validateArchiveReceipt(raw.receipt, { workerId: this.options.workerId(), storageNamespaceId: target.storageNamespaceId, manifest });
    return { manifest, receipt };
  }
  async commitManifest(owner: string, recordId: string, manifestHash: string, input: unknown): Promise<ArchiveReceipt> {
    identity(owner); identity(recordId); hash(manifestHash);
    const manifest = validateRecordingManifest(input);
    if (manifest.recordId !== recordId || manifest.deviceId !== owner || recordingManifestHash(manifest) !== manifestHash) throw new Error("Archive manifest identity mismatch");
    return this.serial(owner, async () => {
      const target = await this.resolve(owner);
      await this.verifyMedia(owner, manifest, target);
      await this.assertTarget(owner, target);
      const directory = await this.directory(target, ["manifests", sha(owner)], true);
      const receipt = validateArchiveReceipt({ schemaVersion: 1, workerId: this.options.workerId(), storageNamespaceId: target.storageNamespaceId,
        recordId, manifestHash, totalBytes: manifest.totalBytes, segmentCount: manifest.segments.length,
        committedAt: Date.now(), durability: "archived", retention: "indefinite" },
      { workerId: this.options.workerId(), storageNamespaceId: target.storageNamespaceId, manifest });
      await this.publish(path.join(directory, sha(recordId) + ".json"), Buffer.from(JSON.stringify({ schemaVersion: 1, ownerHash: sha(owner), manifest, receipt })));
      await this.assertTarget(owner, target);
      const actual = await this.envelope(owner, recordId);
      if (actual.receipt.manifestHash !== manifestHash) throw new Error("Archive record conflict");
      // Notification is a hint: durable truth can be rediscovered after a callback failure/restart.
      try { await this.options.committed?.(owner, actual.manifest, actual.receipt); } catch { /* Cannot revoke a committed archive receipt. */ }
      return actual.receipt;
    });
  }
  async readReceipt(owner: string, recordId: string, manifestHash: string): Promise<ArchiveReceipt> {
    hash(manifestHash); const target = await this.resolve(owner);
    const result = await this.envelope(owner, recordId);
    if (result.receipt.manifestHash !== manifestHash) throw new Error("Archive receipt hash mismatch");
    await this.verifyMedia(owner, result.manifest, target);
    await this.assertTarget(owner, target);
    return result.receipt;
  }
  /** Committed catalog truth only: does not re-read PCM. Not a local-eviction authorization. */
  async getRecord(owner: string, recordId: string): Promise<{ manifest: RecordingManifest; receipt: ArchiveReceipt }> {
    return this.envelope(owner, recordId);
  }
  async getManifest(owner: string, recordId: string): Promise<RecordingManifest> { return (await this.envelope(owner, recordId)).manifest; }
}
