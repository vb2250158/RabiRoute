import { createHash } from "node:crypto";
import { requestLocalSpeech, requestLocalSpeechJson, normalizeLocalSpeechServiceUrl } from "../speech/localSpeechClient.js";
import type { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { RECORDING_ARCHIVE_MAX_BYTES, type RecordingManifest, type ArchiveReceipt } from "./recordingArchiveContract.js";
import { RecordingAsrJobStore } from "./recordingAsrJobStore.js";
import { RecordingAsrJobs, RecordingAsrSafeFailure, recordingAsrJobKey, type RecordingAsrRef, type RecordingAsrResult } from "./recordingAsrJobs.js";
import { resolveEffectiveAsrSelection, type EffectiveAsrSelection } from "./recordingAsrSelection.js";

export interface RecordingArchiveAsrRuntimeOptions {
  archive: Pick<RecordingArchiveRuntime, "bindings" | "store" | "catalog">;
  localSpeechUrl(): string;
  workerId(): string;
  instanceId: string;
  clock?: () => number;
  changed?(owner: string, jobKey: string): void;
  /** Test seam only. Production always uses the fixed loopback client, never GUI peer selection. */
  fetchImpl?: typeof fetch;
}
/** Global drain serializes owners BEFORE any lease is claimed. No queue wait consumes a lease.
 * PCM <=128 MiB; WAV is one allocation, multipart Blob may copy it: budget ~260 MiB + transport overhead.
 * Recovery is explicit and paginated. NAS errors do not block Manager readiness: call restore in background.
 */
export class RecordingArchiveAsrRuntime {
  private owners = new Map<string, { store: RecordingAsrJobStore; jobs: RecordingAsrJobs }>();
  private pending = new Set<string>();
  private pump?: Promise<void>;
  private stopped = false;
  private errors: unknown[] = [];
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private async armLeaseRecovery(owner: string) {
    const entry = this.owner(owner); let cursor: string | undefined, earliest = Infinity;
    do {
      const page = await entry.store.recoverable(cursor);
      for (const job of page.jobs) if (job.state === "running") earliest = Math.min(earliest, job.updatedAt + entry.store.leaseMs + 1);
      cursor = page.nextCursor;
    } while (cursor && !this.stopped);
    const previous = this.recoveryTimers.get(owner); if (previous) clearTimeout(previous);
    this.recoveryTimers.delete(owner);
    if (!this.stopped && Number.isFinite(earliest) && earliest > this.clock()) {
      const timer = setTimeout(() => { this.recoveryTimers.delete(owner); this.schedule(owner); }, Math.min(2_147_483_647, earliest - this.clock()));
      timer.unref(); this.recoveryTimers.set(owner, timer);
    }
  }
  private readonly clock: () => number;
  constructor(private readonly options: RecordingArchiveAsrRuntimeOptions) { this.clock = options.clock ?? Date.now; }
  private owner(owner: string) {
    let entry = this.owners.get(owner);
    if (!entry) {
      const store = new RecordingAsrJobStore({ owner, resolveOwner: o => this.options.archive.bindings.resolveOwner(o), workerId: this.options.workerId, instanceId: this.options.instanceId, clock: this.clock, leaseMs: 600_000 });
      const jobs = new RecordingAsrJobs({ store, clock: this.clock, changed: key => this.options.changed?.(owner, key),
        resolveSelection: () => resolveEffectiveAsrSelection({ readJson: async path => {
          const response = await requestLocalSpeechJson(this.options.localSpeechUrl(), path, {}, { timeoutMs: 15_000, fetchImpl: this.options.fetchImpl });
          if (response.status !== 200) throw new Error("local_model_status_failed"); return response.data;
        } }), transcribeLocal: (ref, selected, key, signal) => this.compute(ref, selected, key, signal) });
      entry = { store, jobs }; this.owners.set(owner, entry);
    }
    return entry;
  }
  async onCommitted(owner: string, manifest: RecordingManifest, receipt: ArchiveReceipt, processingVersion = "initial"): Promise<string | undefined> {
    if (this.stopped) throw new Error("archive_asr_runtime_closed");
    if (manifest.processingPolicy !== "transcribe") return undefined;
    const ref = { owner, manifest, receipt, processingVersion };
    const key = recordingAsrJobKey(ref);
    await this.owner(owner).store.create({ jobKey: key, ref, state: "queued", attempt: 0, updatedAt: this.clock() });
    this.schedule(owner); return key;
  }
  private schedule(owner: string) {
    if (this.stopped) return;
    this.pending.add(owner);
    if (!this.pump) this.pump = this.drain().catch(e => { this.errors.push(e); }).finally(() => { this.pump = undefined; if (this.pending.size && !this.stopped) this.schedule(this.pending.values().next().value!); });
  }
  private async drain() {
    while (!this.stopped && this.pending.size) {
      const owner = this.pending.values().next().value!; this.pending.delete(owner);
      try { const entry = this.owner(owner); await entry.jobs.restore(); await entry.jobs.idle(); await this.armLeaseRecovery(owner); }
      catch (e) { this.errors.push(e); }
    }
  }
  async idle() { while (this.pump) await this.pump; if (this.errors.length) throw this.errors.shift(); }
  async restore(): Promise<{ owner: string; ready: boolean }[]> {
    const bindings = await this.options.archive.bindings.listBindings();
    const outcomes: { owner: string; ready: boolean }[] = [];
    for (const [owner, binding] of Object.entries(bindings.ownerRoleBindings)) {
      if (this.stopped) break;
      if (!binding.enabled) continue;
      try {
        let cursor: string | undefined;
        do {
          const page = await this.options.archive.catalog.list(owner, { limit: 100, cursor });
          if (page.offline) throw new Error("archive_offline");
          for (const row of page.items) {
            if (this.stopped) break;
            const record = await this.options.archive.store.getRecord(owner, row.recordId);
            if (record.manifest.processingPolicy !== "transcribe") continue;
            const ref = { owner, ...record, processingVersion: "initial" };
            await this.owner(owner).store.create({ jobKey: recordingAsrJobKey(ref), ref, state: "queued", attempt: 0, updatedAt: this.clock() });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !this.stopped);
        this.schedule(owner); outcomes.push({ owner, ready: true });
      } catch { outcomes.push({ owner, ready: false }); }
    }
    return outcomes;
  }
  async readResult(ref: RecordingAsrRef) {
    const store = this.owner(ref.owner).store, key = recordingAsrJobKey(ref);
    const job = await store.get(key);
    return { jobKey: key, state: job?.state ?? "not_requested", result: await store.readResult(key) };
  }
  private async compute(ref: RecordingAsrRef, selection: EffectiveAsrSelection, key: string, signal: AbortSignal): Promise<RecordingAsrResult> {
    const started = Date.now();
    let url: string, wav: Buffer;
    try {
      url = normalizeLocalSpeechServiceUrl(this.options.localSpeechUrl());
      const m = ref.manifest;
      if (m.totalBytes > RECORDING_ARCHIVE_MAX_BYTES || signal.aborted) throw new Error("pre_dispatch_rejected");
      wav = Buffer.alloc(44 + m.totalBytes);
      wav.write("RIFF", 0); wav.writeUInt32LE(36 + m.totalBytes, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(m.totalBytes, 40);
      let offset = 0;
      for (const object of m.objects) {
        if (signal.aborted) throw new Error("aborted");
        const bytes = await this.options.archive.store.readObject(ref.owner, object.sha256);
        if (object.offset !== offset || bytes.length !== object.bytes || createHash("sha256").update(bytes).digest("hex") !== object.sha256) throw new Error("invalid_archive_object");
        bytes.copy(wav, 44 + offset); offset += bytes.length;
      }
      if (offset !== m.totalBytes || signal.aborted) throw new Error("invalid_archive_length");
    } catch { throw new RecordingAsrSafeFailure("archive_pre_dispatch_validation_failed"); }
    const form = new FormData();
    form.set("job_key", key); form.set("model", selection.model); form.set("provider", selection.provider);
    form.set("language", selection.language ?? ""); form.set("prompt", selection.prompt ?? "");
    form.set("response_format", "verbose_json"); form.set("file", new Blob([new Uint8Array(wav)]), "recording.wav");
    // Leave ample lease margin even when a NAS read was slow; never dispatch after waiting out the lease.
    if (signal.aborted || Date.now() - started > 300_000) throw new RecordingAsrSafeFailure("stopped_before_dispatch");
    const transport = this.options.fetchImpl ?? fetch;
    const response = await requestLocalSpeech(url, "/v1/archive/transcriptions", { method: "POST", body: form }, {
      timeoutMs: 190_000, fetchImpl: ((input, init) => transport(input, { ...init, signal: AbortSignal.any([signal, init!.signal!]) })) as typeof fetch
    });
    if (response.status !== 200) throw new Error("archive_computation_outcome_unknown");
    const result = JSON.parse(response.body.toString("utf8"));
    if (typeof result.text !== "string" || !Array.isArray(result.segments)) throw new Error("invalid_archive_computation_result");
    return { text: result.text, segments: result.segments };
  }
  async dispose(): Promise<void> {
    this.stopped = true; this.pending.clear();
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([...this.owners.values()].map(e => e.jobs.shutdown())), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
