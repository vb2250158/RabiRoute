import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFileLockSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit, type DataMutationAuditRecord } from "../observability/dataMutationAudit.js";

export type AgentUploadOwner = { nodeId: string; agentId: string };
export type AgentUploadDto = { id: string; fileName: string; size: number; sha256: string; expiresAt: string };
export type AgentUploadFile = AgentUploadDto & { path: string };
export type AgentUploadInput = { owner: AgentUploadOwner; uploadId: string; fileName: string; content: Buffer; sha256: string };
export type AgentUploadStreamInput = Omit<AgentUploadInput, "content"> & { content: AsyncIterable<Uint8Array>; size?: number; beforeCommit?: () => void | Promise<void> };
export type AgentUploadStoreOptions = {
  rootDir: string; maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; ttlMs?: number; now?: () => number;
};
export type AgentUploadErrorCode = "invalid_input" | "not_found" | "conflict" | "capacity" | "integrity" | "unsafe_storage" | "storage_failure";
export class AgentUploadStoreError extends Error {
  constructor(readonly code: AgentUploadErrorCode) { super(`Agent upload ${code}`); this.name = "AgentUploadStoreError"; }
}
type RecordData = AgentUploadDto & { schemaVersion: 1; owner: AgentUploadOwner };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const METADATA_BYTES = 8192;
function fail(code: AgentUploadErrorCode): never { throw new AgentUploadStoreError(code); }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}
function validOwner(value: unknown): value is AgentUploadOwner {
  return object(value) && keys(value, ["nodeId", "agentId"]) && [value.nodeId, value.agentId].every(part =>
    typeof part === "string" && part.length > 0 && part.length <= 256 && part.trim() === part && !/[\x00-\x1f\x7f-\x9f]/u.test(part));
}
function validName(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= 255 && value.length > 0
    && value !== "." && value !== ".." && value === value.trim() && !/[. ]$/u.test(value)
    && !/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/u.test(value)
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\.|$)/iu.test(value)
    && path.win32.basename(value) === value && path.posix.basename(value) === value;
}
function dto(record: RecordData): AgentUploadDto {
  return { id: record.id, fileName: record.fileName, size: record.size, sha256: record.sha256, expiresAt: record.expiresAt };
}
function maybeStat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function regular(file: string, maxBytes: number): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unsafe_storage");
  if (stat.size > maxBytes) fail("integrity");
  return stat;
}
function directory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_storage");
}
function readBytes(file: string, maxBytes: number): Buffer {
  const before = regular(file, maxBytes);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) fail("unsafe_storage");
    // Bounded allocation even if a hostile local writer grows the file after fstat.
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("integrity");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1) fail("integrity");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeNew(file: string, content: string | Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(dir: string): void {
  // Windows does not support fs.open/fsync on directories; rename is still atomic.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Manager-owned private local store. rootDir must be dedicated and ACL-restricted by the
 * host on Windows (Node mode bits cannot enforce Windows ACLs). Never expose resolve's path
 * remotely. Use withFile for asynchronous sends; callbacks must not retain the path afterwards.
 * Directory rename commits bytes and receipt together; no separate mutable index exists.
 */
export class AgentUploadStore {
  readonly limits: Readonly<{ maxFileBytes: number; maxTotalBytes: number; maxFiles: number; ttlMs: number }>;
  private readonly root: string;
  private readonly now: () => number;

  constructor(options: AgentUploadStoreOptions) {
    this.limits = Object.freeze({ maxFileBytes: options.maxFileBytes ?? 2 * 1024 ** 3,
      maxTotalBytes: options.maxTotalBytes ?? 4 * 1024 ** 3, maxFiles: options.maxFiles ?? 100, ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000 });
    if (this.limits.maxFileBytes > 2 * 1024 ** 3 || Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)
      || typeof options.rootDir !== "string" || !path.isAbsolute(options.rootDir)
      || /^(\\\\|\/\/)/u.test(options.rootDir)) fail("invalid_input");
    this.root = path.resolve(options.rootDir);
    if (this.root === path.parse(this.root).root) fail("invalid_input");
    this.now = options.now ?? Date.now;
    this.safe(() => this.ensureRoot(true));
  }

  get maxFileBytes(): number { return this.limits.maxFileBytes; }

  upload(input: AgentUploadInput): AgentUploadDto {
    return this.operation("upload", () => {
      if (!input || !validOwner(input.owner) || !UUID.test(input.uploadId) || !validName(input.fileName)
        || !Buffer.isBuffer(input.content) || !SHA256.test(input.sha256)) fail("invalid_input");
      if (input.content.length > this.limits.maxFileBytes || input.content.length > this.limits.maxTotalBytes) fail("capacity");
      if (hash(input.content) !== input.sha256) fail("integrity");
      return this.locked(() => {
        const now = this.timestamp();
        const records = this.inventory();
        this.cleanup(records, now);
        const existing = records.find(item => item.id === input.uploadId);
        if (existing) {
          if (existing.owner.nodeId !== input.owner.nodeId || existing.owner.agentId !== input.owner.agentId) fail("not_found");
          if (Date.parse(existing.expiresAt) <= now) fail("not_found");
          if (existing.fileName !== input.fileName || existing.size !== input.content.length || existing.sha256 !== input.sha256) fail("conflict");
          this.verifyContent(existing);
          this.audit("upload", "replayed", existing.id);
          return dto(existing);
        }
        const reservations = this.streamReservations();
        const total = records.reduce((sum, record) => sum + record.size, 0) + reservations.bytes;
        if (records.length + reservations.count >= this.limits.maxFiles || total > this.limits.maxTotalBytes - input.content.length) fail("capacity");
        const expires = now + this.limits.ttlMs;
        if (!Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime())) fail("invalid_input");
        const record: RecordData = { schemaVersion: 1, owner: { ...input.owner }, id: input.uploadId,
          fileName: input.fileName, size: input.content.length, sha256: input.sha256, expiresAt: new Date(expires).toISOString() };
        const staging = path.join(this.root, `.tmp-${randomUUID()}`);
        fs.mkdirSync(staging, { mode: 0o700 });
        // All staging work is under the same root lock; only the next lock holder can
        // remove a crashed operation's staging directory. Failed commits leave no DTO.
        writeNew(path.join(staging, "data.bin"), input.content);
        writeNew(path.join(staging, "record.json"), JSON.stringify(record));
        syncDirectory(staging);
        fs.renameSync(staging, path.join(this.root, record.id));
        syncDirectory(this.root);
        this.audit("upload", "committed", record.id);
        return dto(record);
      });
    });
  }

  async uploadStream(input: AgentUploadStreamInput): Promise<AgentUploadDto> {
    if (!validOwner(input.owner) || !UUID.test(input.uploadId) || !validName(input.fileName) || !SHA256.test(input.sha256)
      || (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 0))) fail("invalid_input");
    const reserved = input.size ?? this.limits.maxFileBytes;
    if (reserved > this.limits.maxFileBytes) fail("capacity");
    const previous = this.operation("stream-replay", () => this.locked(() => {
      const records = this.inventory(); this.cleanup(records, this.timestamp());
      if (!maybeStat(path.join(this.root, input.uploadId))) return undefined;
      const record = this.authorized(input.owner, input.uploadId);
      if (record.fileName !== input.fileName || record.sha256 !== input.sha256 || (input.size !== undefined && record.size !== input.size)) fail("conflict");
      return dto(record);
    }));
    if (previous) {
      const digest = createHash("sha256"); let size = 0;
      for await (const chunk of input.content) { size += chunk.byteLength; if (size > previous.size) fail("conflict"); digest.update(chunk); }
      if (size !== previous.size || digest.digest("hex") !== previous.sha256) fail("integrity");
      await input.beforeCommit?.();
      return this.withFile(input.owner, input.uploadId, file => {
        if (file.sha256 !== previous.sha256 || file.fileName !== previous.fileName || file.expiresAt !== previous.expiresAt) fail("conflict");
        return { id: file.id, fileName: file.fileName, size: file.size, sha256: file.sha256, expiresAt: file.expiresAt };
      });
    }
    const stage = path.join(this.root, `.stream-${randomUUID()}`);
    this.operation("stream-start", () => this.locked(() => {
      const records = this.inventory(); this.cleanup(records, this.timestamp());
      const reservations = this.streamReservations(input.uploadId);
      if (records.length + reservations.count >= this.limits.maxFiles
        || records.reduce((n, r) => n + r.size, 0) + reservations.bytes + reserved > this.limits.maxTotalBytes) fail("capacity");
      const preparing = path.join(this.root, `.tmp-${randomUUID()}`);
      fs.mkdirSync(preparing, { mode: 0o700 });
      writeNew(path.join(preparing, "reservation.json"), JSON.stringify({ id: input.uploadId, size: reserved, host: os.hostname(), pid: process.pid }));
      fs.renameSync(preparing, stage);
    }));
    let fd: fs.promises.FileHandle | undefined;
    try {
      fd = await fs.promises.open(path.join(stage, "data.bin"), "wx", 0o600);
      const digest = createHash("sha256"); let size = 0;
      for await (const chunk of input.content) {
        if (!(chunk instanceof Uint8Array)) fail("invalid_input");
        size += chunk.byteLength;
        if (size > reserved) fail("capacity");
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) { const written = await fd.write(chunk, offset, chunk.byteLength - offset); if (!written.bytesWritten) fail("storage_failure"); offset += written.bytesWritten; }
      }
      if ((input.size !== undefined && size !== input.size) || digest.digest("hex") !== input.sha256) fail("integrity");
      await fd.sync(); await fd.close(); fd = undefined;
      await input.beforeCommit?.();
      return this.operation("stream-commit", () => this.locked(() => {
        const records = this.inventory(); const now = this.timestamp(); this.cleanup(records, now);
        const existing = records.find(record => record.id === input.uploadId);
        if (existing) {
          if (existing.owner.nodeId !== input.owner.nodeId || existing.owner.agentId !== input.owner.agentId || Date.parse(existing.expiresAt) <= now) fail("not_found");
          if (existing.fileName !== input.fileName || existing.size !== size || existing.sha256 !== input.sha256) fail("conflict");
          this.verifyContent(existing); return dto(existing);
        }
        const record: RecordData = { schemaVersion: 1, owner: { ...input.owner }, id: input.uploadId, fileName: input.fileName, size, sha256: input.sha256, expiresAt: new Date(now + this.limits.ttlMs).toISOString() };
        writeNew(path.join(stage, "record.json"), JSON.stringify(record));
        // Retire the reservation namespace under the same lock before the atomic publish.
        const committedStage = path.join(this.root, `.tmp-${randomUUID()}`);
        fs.renameSync(stage, committedStage);
        fs.unlinkSync(path.join(committedStage, "reservation.json"));
        syncDirectory(committedStage); fs.renameSync(committedStage, path.join(this.root, record.id)); syncDirectory(this.root);
        this.audit("upload", "committed", record.id); return dto(record);
      }));
    } finally {
      await fd?.close().catch(() => undefined);
      this.operation("stream-release", () => this.locked(() => { if (maybeStat(stage)) this.removeStream(stage); }));
    }
  }

  private streamReservations(uploadId?: string): { count: number; bytes: number } {
    let count = 0; let bytes = 0;
    for (const name of fs.readdirSync(this.root)) {
      if (!name.startsWith(".stream-")) continue;
      if (!UUID.test(name.slice(8))) fail("unsafe_storage");
      const dir = path.join(this.root, name); directory(dir);
      const data: unknown = JSON.parse(readBytes(path.join(dir, "reservation.json"), METADATA_BYTES).toString("utf8"));
      if (!object(data) || !keys(data, ["id", "size", "host", "pid"]) || typeof data.id !== "string" || !UUID.test(data.id) || !Number.isSafeInteger(data.size) || Number(data.size) < 0 || Number(data.size) > 2 * 1024 ** 3 || typeof data.host !== "string" || !Number.isSafeInteger(data.pid) || Number(data.pid) <= 0) fail("integrity");
      let alive = true;
      if (data.host === os.hostname()) { try { process.kill(Number(data.pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; } }
      if (!alive) { this.removeStream(dir); continue; }
      if (data.id === uploadId) fail("conflict");
      count++; bytes += Number(data.size);
    }
    return { count, bytes };
  }
  private removeStream(dir: string): void {
    directory(dir);
    const names = fs.readdirSync(dir);
    for (const name of names) { if (!["data.bin", "record.json", "reservation.json"].includes(name)) fail("unsafe_storage"); regular(path.join(dir, name), name === "data.bin" ? 2 * 1024 ** 3 : METADATA_BYTES); }
    const retired = path.join(this.root, `.tmp-${randomUUID()}`);
    fs.renameSync(dir, retired);
    for (const name of names) fs.unlinkSync(path.join(retired, name));
    fs.rmdirSync(retired);
  }

  get(owner: AgentUploadOwner, id: string): AgentUploadDto {
    return this.operation("get", () => this.locked(() => {
      const record = this.authorized(owner, id);
      this.audit("get", "no_change", id);
      return dto(record);
    }));
  }

  resolve(owner: AgentUploadOwner, id: string): AgentUploadFile {
    return this.operation("resolve", () => this.locked(() => this.resolveLocked(owner, id)));
  }

  async withFile<T>(owner: AgentUploadOwner, id: string, callback: (file: AgentUploadFile) => T | Promise<T>): Promise<T> {
    const leaseId = `.lease-${randomUUID()}.json`;
    const file = this.operation("lease", () => this.locked(() => {
      const record = this.authorized(owner, id);
      const resolved = { ...dto(record), path: path.join(this.root, id, "data.bin") };
      writeNew(path.join(this.root, id, leaseId), JSON.stringify({ schemaVersion: 1, host: os.hostname(), pid: process.pid }));
      this.audit("lease", "committed", id);
      return resolved;
    }));
    try {
      const before = regular(file.path, 2 * 1024 ** 3);
      const handle = await fs.promises.open(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1 || opened.size !== file.size) fail("unsafe_storage");
        const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(256 * 1024); let offset = 0;
        while (offset < file.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset); if (!bytesRead) fail("integrity"); digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1 || digest.digest("hex") !== file.sha256) fail("integrity");
      } finally { await handle.close(); }
      return await callback(file);
    }
    finally {
      try {
        this.operation("release", () => this.locked(() => {
          directory(path.join(this.root, id));
          const lease = path.join(this.root, id, leaseId);
          regular(lease, METADATA_BYTES);
          fs.unlinkSync(lease);
          this.audit("release", "committed", id);
        }));
      } catch {
        // A completed external send must not become a reported failure (and duplicate
        // retry) because lease release failed. The audited, retained lease fails closed:
        // cleanup protects the file until this process exits and its lease is stale.
      }
    }
  }

  private safe<T>(action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof AgentUploadStoreError) throw error;
      // fs errors contain private absolute paths; do not propagate them to HTTP/logs.
      throw new AgentUploadStoreError("storage_failure");
    }
  }
  private operation<T>(action: string, callback: () => T): T {
    this.audit(action, "started");
    try { return this.safe(callback); } catch (error) {
      this.audit(action, "rejected", "store", (error as AgentUploadStoreError).code);
      throw error;
    }
  }
  private audit(action: string, outcome: DataMutationAuditRecord["outcome"], id = "store", result?: string): void {
    recordDataMutationAudit({ group: "storage", event: `agent_upload_${action}`, owner: "agent-upload-store", action,
      target: { type: "agent-upload", id }, dataSource: { kind: "file", id: "agent-uploads" }, outcome, result,
      diagnostic: { callsite: `AgentUploadStore.${action}` } });
  }
  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_input");
    return value;
  }
  private ensureRoot(create = false): void {
    const base = path.parse(this.root).root;
    directory(base);
    let current = base;
    for (const segment of path.relative(base, this.root).split(path.sep)) {
      current = path.join(current, segment);
      if (create && !maybeStat(current)) fs.mkdirSync(current, { mode: 0o700 });
      directory(current);
    }
    const stat = fs.lstatSync(this.root);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) fail("unsafe_storage");
  }
  private locked<T>(action: () => T): T {
    this.ensureRoot();
    const lock = path.join(this.root, ".store.lock");
    if (maybeStat(lock)) regular(lock, METADATA_BYTES);
    return withFileLockSync(lock, () => { this.ensureRoot(); return action(); });
  }
  private readRecord(id: string): RecordData {
    const dir = path.join(this.root, id);
    directory(dir);
    let raw: unknown;
    try { raw = JSON.parse(readBytes(path.join(dir, "record.json"), METADATA_BYTES).toString("utf8")); }
    catch (error) { if (error instanceof AgentUploadStoreError) throw error; return fail("integrity"); }
    if (!object(raw) || !keys(raw, ["schemaVersion", "owner", "id", "fileName", "size", "sha256", "expiresAt"])
      || raw.schemaVersion !== 1 || raw.id !== id || !validOwner(raw.owner) || !validName(raw.fileName)
      || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) || !Number.isSafeInteger(raw.size)
      || Number(raw.size) < 0 || Number(raw.size) > 2 * 1024 ** 3 || typeof raw.expiresAt !== "string"
      || !Number.isFinite(Date.parse(raw.expiresAt)) || new Date(raw.expiresAt).toISOString() !== raw.expiresAt) fail("integrity");
    const stat = regular(path.join(dir, "data.bin"), 2 * 1024 ** 3);
    if (stat.size !== raw.size) fail("integrity");
    this.leases(dir); // Validate the complete managed namespace before using/deleting it.
    return raw as RecordData;
  }
  private leases(dir: string): string[] {
    const leases: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (name === "data.bin" || name === "record.json") continue;
      if (!name.startsWith(".lease-") || !name.endsWith(".json") || !UUID.test(name.slice(7, -5))) fail("unsafe_storage");
      regular(path.join(dir, name), METADATA_BYTES);
      leases.push(name);
    }
    return leases;
  }
  private inventory(): RecordData[] {
    const records: RecordData[] = [];
    for (const name of fs.readdirSync(this.root)) {
      if (name === ".store.lock") continue;
      if (name.startsWith(".stream-") && UUID.test(name.slice(8))) continue;
      if (name.startsWith(".tmp-") && UUID.test(name.slice(5))) {
        this.removeStaging(path.join(this.root, name));
        continue;
      }
      if (!UUID.test(name)) fail("unsafe_storage");
      records.push(this.readRecord(name));
    }
    return records;
  }
  private removeStaging(dir: string): void {
    directory(dir);
    const files = fs.readdirSync(dir);
    for (const name of files) {
      if (name !== "data.bin" && name !== "record.json" && name !== "reservation.json") fail("unsafe_storage");
      regular(path.join(dir, name), name === "data.bin" ? 2 * 1024 ** 3 : METADATA_BYTES);
    }
    for (const name of files) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
    this.audit("cleanup-staging", "committed");
  }
  private hasLiveLease(dir: string): boolean {
    let live = false;
    for (const name of this.leases(dir)) {
      const file = path.join(dir, name);
      let lease: unknown;
      try { lease = JSON.parse(readBytes(file, METADATA_BYTES).toString("utf8")); } catch { return fail("integrity"); }
      if (!object(lease) || !keys(lease, ["schemaVersion", "host", "pid"]) || lease.schemaVersion !== 1
        || typeof lease.host !== "string" || !Number.isSafeInteger(lease.pid) || Number(lease.pid) <= 0) fail("integrity");
      if (lease.host !== os.hostname()) { live = true; continue; }
      try { process.kill(Number(lease.pid), 0); live = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") { live = true; continue; }
        fs.unlinkSync(file);
      }
    }
    return live;
  }
  private cleanup(records: RecordData[], now: number): void {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (Date.parse(record.expiresAt) > now) continue;
      const dir = path.join(this.root, record.id);
      if (this.hasLiveLease(dir)) continue;
      // Rename to the staging namespace first: interruption cannot leave a half record.
      const retired = path.join(this.root, `.tmp-${randomUUID()}`);
      fs.renameSync(dir, retired);
      this.removeStaging(retired);
      records.splice(index, 1);
      this.audit("expire", "committed", record.id);
    }
  }
  private authorized(owner: AgentUploadOwner, id: string): RecordData {
    if (!validOwner(owner) || typeof id !== "string" || !UUID.test(id)) fail("invalid_input");
    if (!maybeStat(path.join(this.root, id))) fail("not_found");
    const record = this.readRecord(id);
    if (record.owner.nodeId !== owner.nodeId || record.owner.agentId !== owner.agentId || Date.parse(record.expiresAt) <= this.timestamp()) fail("not_found");
    return record;
  }
  private verifyContent(record: RecordData): void {
    const file = path.join(this.root, record.id, "data.bin");
    const before = regular(file, 2 * 1024 ** 3);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== record.size) fail("unsafe_storage");
      const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(256 * 1024); let offset = 0;
      while (offset < opened.size) { const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset); if (!count) fail("integrity"); digest.update(buffer.subarray(0, count)); offset += count; }
      const after = fs.fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1 || digest.digest("hex") !== record.sha256) fail("integrity");
    } finally { fs.closeSync(fd); }
  }
  private resolveLocked(owner: AgentUploadOwner, id: string): AgentUploadFile {
    const record = this.authorized(owner, id);
    this.verifyContent(record);
    this.audit("resolve", "no_change", id);
    return { ...dto(record), path: path.join(this.root, id, "data.bin") };
  }
}
