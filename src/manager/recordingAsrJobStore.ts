import { auditRecordingArchiveMutation } from "./recordingArchiveAudit.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordingAsrJobKey, type RecordingAsrStore, type RecordingAsrJob, type RecordingAsrLease, type RecordingAsrResult } from "./recordingAsrJobs.js";
import { validateRecordingManifest, validateArchiveReceipt } from "./recordingArchiveContract.js";
import type { RecordingArchiveNamespace } from "./recordingArchiveStore.js";

export interface RecordingAsrJobStoreOptions {
  owner: string; resolveOwner(owner: string): Promise<RecordingArchiveNamespace>; workerId(): string;
  instanceId: string; clock(): number;
  /** Runtime computation timeout must be shorter than this non-renewable lease. */
  leaseMs?: number;
}
type Envelope = { schemaVersion: 1; owner: string; workerId: string; namespace: string; job: RecordingAsrJob;
  lease?: { fence: string; instanceId: string; expiresAt: number }; result?: RecordingAsrResult; completedBy?: { fence: string; instanceId: string } };
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const id = (v: string) => { if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error("Invalid job identity"); return v; };
const key = (v: string) => { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw new Error("Invalid job key"); return v; };
const number = (v: number) => { if (!Number.isSafeInteger(v) || v < 0) throw new Error("Invalid job number"); return v; };
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fields(v: object, allowed: string[], required: string[] = allowed) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) throw new Error("Invalid job schema");
}
function canonical(v: any): string { return Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => JSON.stringify(k)+":"+canonical(v[k])).join(",")}}` : JSON.stringify(v); }
const MAX_JSON = 4 * 1024 * 1024;
/** Immutable numbered revision slots. Hard-link publication is the CAS, not an in-memory lock.
 * Unsupported NAS hard links fail closed. Partial files never count as revisions. */
export class RecordingAsrJobStore implements RecordingAsrStore {
  private target?: string;
  readonly leaseMs: number;
  constructor(private readonly options: RecordingAsrJobStoreOptions) {
    id(options.owner); id(options.instanceId);
    this.leaseMs = options.leaseMs ?? 600_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 || this.leaseMs > 3_600_000) throw new Error("Invalid lease duration");
  }
  private async directory(p: string) { const s = await fs.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe job directory"); }
  private async json(file: string): Promise<any> {
    const s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_JSON) throw new Error("Unsafe job file");
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  private async context() {
    const target = await this.options.resolveOwner(this.options.owner);
    if (!path.isAbsolute(target.root)) throw new Error("Invalid archive root");
    await this.directory(target.root);
    const marker = await this.json(path.join(target.root, "namespace.json"));
    if (marker.schemaVersion !== 1 || marker.storageNamespaceId !== target.storageNamespaceId) throw new Error("Job namespace mismatch");
    const workerId = id(this.options.workerId());
    const identity = JSON.stringify([path.resolve(target.root), target.storageNamespaceId, workerId]);
    if (this.target && this.target !== identity) throw new Error("Job binding changed");
    this.target = identity;
    return { ...target, workerId };
  }
  private async location(jobKey: string, create = false) {
    key(jobKey); const ctx = await this.context(); let dir = ctx.root;
    for (const part of ["jobs", digest(this.options.owner), jobKey]) {
      dir = path.join(dir, part);
      if (create) { try { await fs.mkdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
      try { await this.directory(dir); } catch(e) { if (!create && (e as NodeJS.ErrnoException).code === "ENOENT") return { ctx, dir, missing: true }; throw e; }
    }
    return { ctx, dir, missing: false };
  }
  private validate(e: Envelope, jobKey: string, revision: number, ctx: { workerId: string; storageNamespaceId: string }): Envelope {
    fields(e, ["schemaVersion", "owner", "workerId", "namespace", "job", "lease", "result", "completedBy"], ["schemaVersion", "owner", "workerId", "namespace", "job"]);
    if (e.schemaVersion !== 1 || e.owner !== this.options.owner || e.workerId !== ctx.workerId || e.namespace !== ctx.storageNamespaceId) throw new Error("Job identity mismatch");
    const j = e.job;
    fields(j, ["jobKey", "ref", "revision", "state", "selection", "attempt", "updatedAt", "error"], ["jobKey", "ref", "revision", "state", "attempt", "updatedAt"]);
    fields(j.ref, ["owner", "manifest", "receipt", "processingVersion"]);
    const manifest = validateRecordingManifest(j.ref.manifest);
    if (j.ref.owner !== e.owner || manifest.deviceId !== e.owner || manifest.processingPolicy !== "transcribe") throw new Error("Job owner/policy mismatch");
    id(j.ref.processingVersion);
    validateArchiveReceipt(j.ref.receipt, { manifest, workerId: ctx.workerId, storageNamespaceId: ctx.storageNamespaceId });
    if (j.jobKey !== jobKey || recordingAsrJobKey(j.ref) !== jobKey || j.revision !== String(revision)) throw new Error("Job reference mismatch");
    number(j.attempt); number(j.updatedAt);
    if (!["queued", "blocked", "running", "completed", "failed", "ambiguous"].includes(j.state) || (j.error !== undefined && (typeof j.error !== "string" || j.error.length > 4096))) throw new Error("Invalid job state");
    if (j.selection) {
      fields(j.selection, ["provider", "model", "language", "prompt", "selectionSource", "configFingerprint"]);
      const s = j.selection;
      if (typeof s.provider !== "string" || !/^[\w-]{1,128}$/.test(s.provider) || typeof s.model !== "string" || !s.model.startsWith(s.provider + "/") || s.model.length > 512 || s.selectionSource !== "pc-microphone-config" || !/^[a-f0-9]{64}$/.test(s.configFingerprint) || ![s.language,s.prompt].every(x => x === null || typeof x === "string" && x.length <= 16384)) throw new Error("Invalid frozen selection");
    }
    if ((j.state === "running") !== !!e.lease || (j.state === "completed") !== (e.result !== undefined)) throw new Error("Invalid job outcome envelope");
    if ((j.state === "completed") !== !!e.completedBy) throw new Error("Invalid completed fence");
    if (e.completedBy) { fields(e.completedBy, ["fence", "instanceId"]); id(e.completedBy.fence); id(e.completedBy.instanceId); }
    if (e.lease) { fields(e.lease, ["fence", "instanceId", "expiresAt"]); id(e.lease.instanceId); id(e.lease.fence); number(e.lease.expiresAt); if (!j.selection || e.lease.expiresAt <= j.updatedAt) throw new Error("Invalid lease"); }
    if (e.result) { fields(e.result, ["text", "segments"], ["text"]); if (typeof e.result.text !== "string" || e.result.text.length > 1_000_000 || e.result.segments !== undefined && !Array.isArray(e.result.segments)) throw new Error("Invalid ASR result"); }
    if (Buffer.byteLength(JSON.stringify(e)) > MAX_JSON) throw new Error("Job envelope too large");
    return e;
  }
  private filename(dir: string, rev: number) { return path.join(dir, `${String(rev).padStart(12, "0")}.json`); }
  private async latest(jobKey: string): Promise<Envelope | undefined> {
    const { ctx, dir, missing } = await this.location(jobKey); if (missing) return;
    const exists = async (rev: number) => { try { const s = await fs.lstat(this.filename(dir,rev)); if (!s.isFile() || s.isSymbolicLink()) throw new Error("Unsafe revision"); return true; } catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
    if (!await exists(1)) return;
    let low = 1, high = 2;
    while (await exists(high)) { low = high; high *= 2; if (high > 1_000_000_000) throw new Error("Revision limit exceeded"); }
    while (low + 1 < high) { const mid = Math.floor((low+high)/2); if (await exists(mid)) low = mid; else high = mid; }
    return this.validate(await this.json(this.filename(dir, low)), jobKey, low, ctx);
  }
  private async publish(e: Envelope, liveUntil?: number): Promise<boolean> {
    return auditRecordingArchiveMutation("recording-asr-job-store", e.job.jobKey + ":" + e.job.revision, async () => {
      const { ctx, dir } = await this.location(e.job.jobKey, true);
      this.validate(e, e.job.jobKey, Number(e.job.revision), ctx);
      const file = this.filename(dir, Number(e.job.revision)), temp = file + "." + randomUUID() + ".partial";
      try {
        const h = await fs.open(temp, "wx"); try { await h.writeFile(JSON.stringify(e)); await h.sync(); } finally { await h.close(); }
        await this.context();
        if (liveUntil !== undefined && number(this.options.clock()) >= liveUntil) return false;
        try { await fs.link(temp, file); return true; } catch(err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
      } finally { await fs.rm(temp, { force: true }); }
    });
  }
  private next(e: Envelope): Envelope { const n = copy(e); n.job.revision = String(number(Number(n.job.revision) + 1)); return n; }
  async get(jobKey: string) { return (await this.latest(jobKey))?.job; }
  async create(input: Omit<RecordingAsrJob, "revision">): Promise<RecordingAsrJob> {
    const ctx = await this.context(); const job = { ...copy(input), revision: "1" };
    const e: Envelope = { schemaVersion: 1, owner: this.options.owner, workerId: ctx.workerId, namespace: ctx.storageNamespaceId, job };
    this.validate(e, job.jobKey, 1, ctx);
    if (job.state !== "queued" || job.attempt !== 0 || job.selection || job.error) throw new Error("Invalid initial job");
    // A structurally valid client receipt alone is not proof: require the authoritative committed archive.
    const manifestDir = path.join(ctx.root, "manifests"); await this.directory(manifestDir);
    const ownerDir = path.join(manifestDir, digest(this.options.owner)); await this.directory(ownerDir);
    const archived = await this.json(path.join(ownerDir, digest(job.ref.manifest.recordId) + ".json"));
    if (archived.schemaVersion !== 1 || archived.ownerHash !== digest(this.options.owner) || canonical(archived.manifest) !== canonical(job.ref.manifest) || canonical(archived.receipt) !== canonical(job.ref.receipt)) throw new Error("Missing authoritative archive receipt");
    await this.publish(e);
    const actual = (await this.latest(job.jobKey))!;
    if (canonical(actual.job.ref) !== canonical(job.ref)) throw new Error("Immutable job conflict");
    return actual.job;
  }
  async update(jobKey: string, revision: string, patch: Parameters<RecordingAsrStore["update"]>[2]) {
    fields(patch, ["state", "selection", "updatedAt", "error"], []);
    const e = await this.latest(jobKey); if (!e || e.job.revision !== revision || ["completed", "running", "ambiguous"].includes(e.job.state)) return;
    if (patch.state !== undefined && !(patch.state === e.job.state || e.job.state === "queued" && patch.state === "blocked" || ["failed","blocked"].includes(e.job.state) && patch.state === "queued")) throw new Error("Invalid job transition");
    if (e.job.selection && patch.selection && canonical(e.job.selection) !== canonical(patch.selection)) throw new Error("Frozen selection conflict");
    const n = this.next(e); Object.assign(n.job, copy(patch)); if (e.job.selection && !n.job.selection) throw new Error("Frozen selection conflict");
    return await this.publish(n) ? n.job : undefined;
  }
  async claim(jobKey: string, revision: string, now: number) {
    number(now); const e = await this.latest(jobKey); if (!e || e.job.revision !== revision || e.job.state !== "queued" || !e.job.selection) return;
    const n = this.next(e); n.job.state = "running"; n.job.attempt++; n.job.updatedAt = now;
    n.lease = { fence: randomUUID(), instanceId: this.options.instanceId, expiresAt: number(now + this.leaseMs) };
    return await this.publish(n) ? { jobKey, fence: n.lease.fence } : undefined;
  }
  private live(e: Envelope | undefined, lease: RecordingAsrLease, now: number): e is Envelope {
    return !!e && e.job.state === "running" && e.lease?.fence === lease.fence && e.lease.instanceId === this.options.instanceId && e.lease.expiresAt > Math.max(number(now), number(this.options.clock()));
  }
  async finish(lease: RecordingAsrLease, state: "failed" | "ambiguous", error: string, now: number) {
    if (!["failed","ambiguous"].includes(state)) throw new Error("Invalid finish state");
    const e = await this.latest(lease.jobKey); if (!this.live(e, lease, now)) return false;
    const n = this.next(e); delete n.lease; n.job.state = state; n.job.error = error; n.job.updatedAt = now;
    return this.publish(n, e.lease!.expiresAt);
  }
  async commitResult(lease: RecordingAsrLease, result: RecordingAsrResult, now: number) {
    const e = await this.latest(lease.jobKey);
    if (e?.job.state === "completed") return e.completedBy?.fence === lease.fence && e.completedBy.instanceId === this.options.instanceId && canonical(e.result) === canonical(result);
    if (!this.live(e, lease, now)) return false;
    const n = this.next(e); n.completedBy = { fence: lease.fence, instanceId: this.options.instanceId }; delete n.lease; n.job.state = "completed"; n.job.updatedAt = now; n.result = copy(result);
    return this.publish(n, e.lease!.expiresAt); // Result and completed state occupy the SAME winning CAS slot.
  }
  async readResult(jobKey: string): Promise<RecordingAsrResult | undefined> { return (await this.latest(jobKey))?.result; }
  async recoverAmbiguous(jobKey: string, revision: string, now: number) {
    number(now); const e = await this.latest(jobKey);
    if (!e || e.job.revision !== revision || e.job.state !== "running" || !e.lease || e.lease.expiresAt > Math.min(now, number(this.options.clock()))) return false;
    const n = this.next(e); delete n.lease; n.job.state = "ambiguous"; n.job.updatedAt = now; n.job.error = "expired_computation_outcome_unknown";
    return this.publish(n);
  }
  /** Explicit recovery only: no directory walk in get/update/claim/result publication. */
  async recoverable(cursor?: string): Promise<{ jobs: RecordingAsrJob[]; nextCursor?: string }> {
    const ctx = await this.context(); const scope = digest(JSON.stringify([this.options.owner,ctx.storageNamespaceId,ctx.workerId]));
    let after = "";
    if (cursor) { const c = JSON.parse(Buffer.from(cursor,"base64url").toString()); if (c.scope !== scope || typeof c.after !== "string") throw new Error("Invalid recovery cursor"); after = key(c.after); }
    const parent = path.join(ctx.root,"jobs"), dir = path.join(parent,digest(this.options.owner));
    try { await this.directory(parent); await this.directory(dir); } catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {jobs:[]}; throw e; }
    // Bounded page memory, even when recovery spans many jobs. Not invoked by the ordinary pump.
    const candidates: string[] = [];
    for await (const item of await fs.opendir(dir)) {
      if (!/^[a-f0-9]{64}$/.test(item.name) || item.name <= after) continue;
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("Unsafe job entry");
      candidates.push(item.name); candidates.sort(); if (candidates.length > 101) candidates.pop();
    }
    const page = candidates.slice(0,100), jobs: RecordingAsrJob[] = [];
    for (const k of page) { const j = await this.get(k); if (j && j.state !== "completed") jobs.push(j); }
    return { jobs, ...(candidates.length > 100 ? {nextCursor:Buffer.from(JSON.stringify({scope,after:page.at(-1)})).toString("base64url")} : {}) };
  }
}
