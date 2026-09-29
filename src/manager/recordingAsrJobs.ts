import { createHash } from "node:crypto";
import { recordingManifestHash, validateArchiveReceipt, validateRecordingManifest, type ArchiveReceipt, type RecordingManifest } from "./recordingArchiveContract.js";
import type { AsrSelectionResult, EffectiveAsrSelection } from "./recordingAsrSelection.js";

export type RecordingAsrRef = { owner: string; manifest: RecordingManifest; receipt: ArchiveReceipt; processingVersion: string };
export type RecordingAsrState = "queued" | "blocked" | "running" | "completed" | "failed" | "ambiguous";
export type RecordingAsrJob = { jobKey: string; ref: RecordingAsrRef; revision: string; state: RecordingAsrState;
  selection?: EffectiveAsrSelection; attempt: number; updatedAt: number; error?: string };
export type RecordingAsrLease = { jobKey: string; fence: string };
export type RecordingAsrResult = { text: string; segments?: unknown[] };
/** Only an explicit pre-dispatch rejection is safe to retry; arbitrary errors/timeouts are ambiguous. */
export class RecordingAsrSafeFailure extends Error {}
export type RecordingAsrStore = {
  /** Atomic put-if-absent; reject a conflicting immutable ref, never overwrite it. */
  create(job: Omit<RecordingAsrJob, "revision">): Promise<RecordingAsrJob>;
  get(jobKey: string): Promise<RecordingAsrJob | undefined>;
  /** Durable CAS; must refuse mutation of completed jobs and immutable ref/selection changes. */
  update(jobKey: string, revision: string, patch: Partial<Pick<RecordingAsrJob, "state" | "selection" | "updatedAt" | "error">>): Promise<RecordingAsrJob | undefined>;
  /** Atomically persist running + increment attempt and acquire an exclusive cross-process lease. */
  claim(jobKey: string, revision: string, now: number): Promise<RecordingAsrLease | undefined>;
  /** Validate fence atomically with terminal state change, invalidate the lease. */
  finish(lease: RecordingAsrLease, state: "failed" | "ambiguous", error: string, now: number): Promise<boolean>;
  /** Validate live fence BEFORE NAS result publication; atomic/idempotent result+completed commit.
   * Implementations must fence publication itself, not just check then write. */
  commitResult(lease: RecordingAsrLease, result: RecordingAsrResult, now: number): Promise<boolean>;
  /** Paginated durable intents / archived-manifest-minus-result projection, not an in-memory-only queue. */
  recoverable(cursor?: string): Promise<{ jobs: RecordingAsrJob[]; nextCursor?: string }>;
  /** CAS ONLY orphaned/expired running leases; never steal another healthy worker's lease. */
  recoverAmbiguous(jobKey: string, revision: string, now: number): Promise<boolean>;
};
export type RecordingAsrDependencies = {
  store: RecordingAsrStore;
  resolveSelection(): Promise<AsrSelectionResult>;
  /** Pure local computation: no random speech-library publication, remote peer selection or Agent dispatch. */
  transcribeLocal(ref: RecordingAsrRef, selection: EffectiveAsrSelection, jobKey: string, signal: AbortSignal): Promise<RecordingAsrResult>;
  clock(): number;
  changed(jobKey: string): void;
};
export function recordingAsrJobKey(ref: RecordingAsrRef): string {
  return createHash("sha256").update(JSON.stringify([ref.owner, ref.manifest.recordId, recordingManifestHash(ref.manifest), ref.processingVersion])).digest("hex");
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function normalize(ref: RecordingAsrRef): RecordingAsrRef {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref.owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.processingVersion)) throw new Error("Invalid ASR identity");
  const manifest = validateRecordingManifest(ref.manifest);
  if (manifest.deviceId !== ref.owner) throw new Error("Archive owner mismatch");
  const receipt = validateArchiveReceipt(ref.receipt, { workerId: ref.receipt.workerId, storageNamespaceId: ref.receipt.storageNamespaceId, manifest });
  // The archive owner supplies an already authenticated receipt; this is structural validation, not proof of origin.
  return copy({ ...ref, manifest, receipt });
}

/** Single computation per instance. All cross-PC exclusion/durability belongs to the injected CAS store. */
export class RecordingAsrJobs {
  private pending = new Set<string>();
  private pump?: Promise<void>;
  private stopped = false;
  private active?: { lease: RecordingAsrLease; abort: AbortController };
  private backgroundError?: unknown;
  constructor(private readonly deps: RecordingAsrDependencies) {}
  async enqueue(input: RecordingAsrRef): Promise<string | undefined> {
    const ref = normalize(input);
    if (ref.manifest.processingPolicy !== "transcribe") return undefined;
    if (this.stopped) throw new Error("ASR jobs stopped");
    const jobKey = recordingAsrJobKey(ref);
    const job = await this.deps.store.create({ jobKey, ref, state: "queued", attempt: 0, updatedAt: this.deps.clock() });
    if (job.state === "queued") this.schedule(jobKey);
    return jobKey;
  }
  private notify(key: string) { try { this.deps.changed(key); } catch { /* Observers do not own durable outcomes. */ } }
  private schedule(key: string) {
    if (this.stopped) return;
    this.pending.add(key);
    if (!this.pump) {
      this.pump = this.drain().catch(error => { this.backgroundError = error; }).finally(() => { this.pump = undefined; });
    }
  }
  async idle(): Promise<void> {
    while (this.pump) await this.pump;
    if (this.backgroundError) { const error = this.backgroundError; this.backgroundError = undefined; throw error; }
  }
  private async drain() {
    while (!this.stopped && this.pending.size) {
      const key = this.pending.values().next().value!; this.pending.delete(key);
      await this.run(key);
    }
  }
  private async run(key: string) {
    let job = await this.deps.store.get(key);
    if (!job || job.state !== "queued" || job.ref.manifest.processingPolicy !== "transcribe") return;
    if (!job.selection) {
      let selected: AsrSelectionResult;
      try { selected = await this.deps.resolveSelection(); }
      catch { selected = { ok: false, code: "blocked_model_configuration", reason: "read_failed" }; }
      if (this.stopped) return;
      if (!selected.ok) {
        await this.deps.store.update(key, job.revision, { state: "blocked", error: selected.code, updatedAt: this.deps.clock() });
        this.notify(key); return;
      }
      const { ok: _ok, ...selection } = selected;
      job = await this.deps.store.update(key, job.revision, { selection: copy(selection), updatedAt: this.deps.clock() });
      if (!job) return;
    }
    if (this.stopped) return;
    const lease = await this.deps.store.claim(key, job.revision, this.deps.clock());
    if (!lease) return;
    const abort = new AbortController(); this.active = { lease, abort };
    try {
      if (this.stopped) {
        await this.deps.store.finish(lease, "failed", "stopped_before_dispatch", this.deps.clock()); return;
      }
      const result = await this.deps.transcribeLocal(copy(job.ref), copy(job.selection!), key, abort.signal);
      if (abort.signal.aborted || this.stopped) {
        await this.deps.store.finish(lease, "ambiguous", "aborted_after_dispatch", this.deps.clock());
      } else if (!result || typeof result.text !== "string" || (result.segments !== undefined && !Array.isArray(result.segments))) {
        await this.deps.store.finish(lease, "ambiguous", "invalid_response", this.deps.clock());
      } else {
        await this.deps.store.commitResult(lease, copy(result), this.deps.clock());
      }
    } catch (error) {
      await this.deps.store.finish(lease, error instanceof RecordingAsrSafeFailure && !abort.signal.aborted ? "failed" : "ambiguous",
        error instanceof RecordingAsrSafeFailure ? "rejected_before_dispatch" : "computation_outcome_unknown", this.deps.clock());
    } finally { if (this.active?.lease === lease) this.active = undefined; this.notify(key); }
  }
  async retry(key: string): Promise<boolean> {
    if (this.stopped) return false;
    const job = await this.deps.store.get(key);
    if (!job || !["failed", "blocked"].includes(job.state)) return false;
    const updated = await this.deps.store.update(key, job.revision, { state: "queued", error: "", updatedAt: this.deps.clock() });
    if (!updated) return false;
    this.schedule(key); return true;
  }
  /** Explicit recomputation creates a NEW version; old ambiguous outcome remains evidence. */
  async recompute(key: string, processingVersion: string): Promise<string | undefined> {
    const job = await this.deps.store.get(key);
    if (!job || job.ref.processingVersion === processingVersion) throw new Error("Recompute requires a new processing version");
    return this.enqueue({ ...job.ref, processingVersion });
  }
  async restore(): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (this.stopped) return;
      const page = await this.deps.store.recoverable(cursor);
      for (const job of page.jobs) {
        if (job.state === "running") { if (await this.deps.store.recoverAmbiguous(job.jobKey, job.revision, this.deps.clock())) this.notify(job.jobKey); }
        else if (job.state === "queued") this.schedule(job.jobKey);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Repeated ASR recovery cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  /** Does not await an uncooperative compute endpoint. Fence revocation prevents late publication. */
  async shutdown(): Promise<void> {
    this.stopped = true; this.pending.clear();
    const active = this.active;
    if (active) { active.abort.abort(); await this.deps.store.finish(active.lease, "ambiguous", "shutdown_after_dispatch", this.deps.clock()); }
  }
}
