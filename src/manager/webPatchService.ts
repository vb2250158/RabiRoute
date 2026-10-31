import { DeveloperCandidateProvenance } from "./developerCandidateProvenance.js";
import type { DeveloperCandidateAdmission } from "./developerCandidateAdmission.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { admitWebPatchCandidate, buildWebPatch, verifyWebPatch, WEB_PATCH_HASH, WEB_PATCH_PREFIX, webPatchHash, writeWebPatchJson, type WebPatchManifest } from "./webPatchCatalog.js";
import type { WebPluginModule } from "./webPluginModules.js";

export type WebPatchIdentity = { applicationGenerationId: string; managerInstanceId: string; pluginGenerationId: string };
export type WebPatchRequest = WebPatchIdentity & { operationId: string; candidate: string; expectedRevision: number };
type Receipt = { operationId: string; fingerprint: string; state: "committed"; revision: number; active: string; previous: string; codeRevision?: string };
type State = { schemaVersion: 1; backend: string; active: string; previous?: string; revision: number; operations: Receipt[]; codeRevision?: string };

function publicationFingerprint(operationId: string, candidate: string, expectedRevision: number, codeRevision?: string): string {
  return webPatchHash(JSON.stringify(codeRevision === undefined ? [operationId, candidate, expectedRevision] : [operationId, candidate, expectedRevision, codeRevision]));
}

function validateState(saved: State, backend: string): void {
  if (!saved || saved.schemaVersion !== 1 || saved.backend !== backend || !WEB_PATCH_HASH.test(saved.active)
    || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.operations)
    || saved.operations.length > 2048 || saved.operations.length !== saved.revision) throw new Error("Invalid persisted Web patch state; do not replay.");
  const operations = new Set<string>();
  let previous: Receipt | undefined;
  let codeRevision: string | undefined;
  for (const receipt of saved.operations) {
    if (!receipt || typeof receipt.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.operationId)
      || operations.has(receipt.operationId) || receipt.state !== "committed" || !WEB_PATCH_HASH.test(receipt.active)
      || !WEB_PATCH_HASH.test(receipt.previous) || receipt.revision !== operations.size + 1
      || (previous && receipt.previous !== previous.active)
      || (receipt.codeRevision !== undefined && !WEB_PATCH_HASH.test(receipt.codeRevision))
      || receipt.fingerprint !== publicationFingerprint(receipt.operationId, receipt.active, receipt.revision - 1, receipt.codeRevision)) {
      throw new Error("Invalid persisted Web patch receipt; do not replay.");
    }
    operations.add(receipt.operationId);
    previous = receipt;
    codeRevision = receipt.codeRevision ?? codeRevision;
  }
  if (previous && (saved.active !== previous.active || saved.previous !== previous.previous)) throw new Error("Web patch state and receipt disagree.");
  if (!previous && saved.previous !== undefined) throw new Error("Invalid initial Web patch state.");
  if (saved.codeRevision !== codeRevision) throw new Error("Code revision and publication receipt disagree.");
}

export class WebPatchService {
  readonly ready: Promise<void>;
  readonly candidates: string;
  private readonly developerOrigins: DeveloperCandidateProvenance;
  private baseline?: string;
  private state?: State;
  private fault?: string;
  private initializing = true;
  private readonly initializationAbort = new AbortController();
  private readonly admissionAbort = new AbortController();
  private closed = false;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private importTail: Promise<unknown> = Promise.resolve();
  private pending?: State;
  private readonly manifests = new Map<string, WebPatchManifest>();
  private prepareCode?: (revision: string) => Promise<() => void>;

  registerCodePublication(prepare: (revision: string) => Promise<() => void>): void {
    if (this.prepareCode || !this.initializing) throw new Error("Code publication owner must register once before Web initialization completes.");
    this.prepareCode = prepare;
  }

  private async codeCommit(revision?: string): Promise<(() => void) | undefined> {
    if (revision === undefined) return undefined;
    if (!WEB_PATCH_HASH.test(revision) || !this.prepareCode) throw new Error("The automatic code publication owner is unavailable.");
    return this.prepareCode(revision);
  }

  constructor(private readonly options: {
    packageRoot: string; stateRoot: string; identity(): WebPatchIdentity;
    developerSourceRoot?: string; developerAdmission?: DeveloperCandidateAdmission; developerDiagnostic?: (message: string) => void;
    serialize<T>(generation: string, action: () => Promise<T>): Promise<T>;
    audit?(event: string, fields: Record<string, unknown>): void;
  }) {
    this.candidates = path.join(options.stateRoot, "candidates");
    this.developerOrigins = new DeveloperCandidateProvenance({ stateRoot: options.stateRoot, sourceRoot: options.developerSourceRoot });
    this.ready = this.initialize().catch(error => {
      const signal = this.initializationAbort.signal;
      const cancelled = signal.aborted && (error === signal.reason || error instanceof Error && error.name === "AbortError");
      if (!cancelled) this.fault = String(error);
    }).finally(() => { this.initializing = false; });
  }

  private get statePath(): string { return path.join(this.options.stateRoot, "states", `${this.state!.backend}.json`); }

  private async initialize(): Promise<void> {
    const signal = this.initializationAbort.signal;
    this.baseline = await buildWebPatch(this.options.packageRoot, this.candidates, signal);
    signal.throwIfAborted();
    const manifest = await this.manifest(this.baseline, signal);
    signal.throwIfAborted();
    this.state = { schemaVersion: 1, backend: manifest.backend, active: this.baseline, revision: 0, operations: [] };
    const raw = await fs.readFile(this.statePath, { encoding: "utf8", signal }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw !== undefined) {
      if (raw.length > 2 * 1024 * 1024) throw new Error("Web patch state is too large.");
      const saved = JSON.parse(raw) as State;
      validateState(saved, manifest.backend);
      await this.compatible(saved.active, signal);
      signal.throwIfAborted();
      const commit = await this.codeCommit(saved.codeRevision);
      commit?.();
      this.state = saved;
    }
  }

  status() {
    return { state: this.fault ? "blocked" : this.initializing ? "starting" : "ready", baseline: this.baseline,
      backend: this.state?.backend, active: this.state?.active, previous: this.state?.previous,
      revision: this.state?.revision, codeRevision: this.state?.codeRevision, queued: this.queued, activeReads: 0, error: this.fault,
      identity: this.options.identity(), limits: { candidateBytes: 128 * 1024 * 1024, operations: 2048, candidates: 64 } };
  }

  operation(id: string): Receipt | undefined {
    const receipt = this.state?.operations.find(record => record.operationId === id);
    return receipt ? structuredClone(receipt) : undefined;
  }

  private async manifest(revision: string, signal?: AbortSignal): Promise<WebPatchManifest> {
    signal?.throwIfAborted();
    if (!WEB_PATCH_HASH.test(revision)) throw new Error("Invalid Web release revision.");
    const cached = this.manifests.get(revision);
    if (cached) return cached;
    const result = await verifyWebPatch(path.join(this.candidates, revision), revision, signal);
    if (this.manifests.size >= 8) this.manifests.delete(this.manifests.keys().next().value!);
    this.manifests.set(revision, result);
    return result;
  }

  private async compatible(revision: string, signal?: AbortSignal): Promise<WebPatchManifest> {
    const manifest = await this.manifest(revision, signal);
    if (this.state && manifest.backend !== this.state.backend) throw new Error("Web patch backend changed; a coordinated full release is required.");
    return manifest;
  }

  /** A detached read-only view for the existing native static owner; validates the active backend contract. */
  async staticManifest(revision: string): Promise<Readonly<WebPatchManifest>> {
    await this.ready;
    if (this.closed || this.fault || !this.state) throw new Error("Web patch static manifest is unavailable.");
    return structuredClone(await this.compatible(revision));
  }

  async importLocalCandidate(source: string, revision: string, actualSourceRoot: string): Promise<void> {
    const result = this.importTail.then(() => this.copyCandidate(source, revision, actualSourceRoot));
    this.importTail = result.catch(() => undefined);
    return result;
  }

  async importCandidate(source: string, revision: string): Promise<void> {
    const result = this.importTail.then(() => this.copyCandidate(source, revision));
    this.importTail = result.catch(() => undefined);
    return result;
  }

  private async copyCandidate(source: string, revision: string, actualSourceRoot?: string): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error("Web patch service is closed.");
    const manifest = await verifyWebPatch(source, revision);
    if (!this.state || this.fault || manifest.backend !== this.state.backend) throw new Error("Web patch backend is incompatible or unavailable.");
    // Persist the local origin before exposing a newly imported candidate to publication.
    if (actualSourceRoot) await this.developerOrigins.record("web-patch", revision, actualSourceRoot);
    const destination = path.join(this.candidates, revision);
    if (await fs.stat(destination).catch(() => undefined)) { await verifyWebPatch(destination, revision); return; }
    await admitWebPatchCandidate(this.candidates, manifest.backend, revision);
    const temporary = path.join(this.candidates, `.import-${randomUUID()}`);
    try {
      await fs.mkdir(temporary, { recursive: true });
      for (const file of manifest.files) {
        const target = path.join(temporary, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(source, file.path), target);
      }
      await fs.copyFile(path.join(source, "manifest.json"), path.join(temporary, "manifest.json"));
      await verifyWebPatch(temporary, revision);
      try { await fs.rename(temporary, destination); }
      catch (error) { if (!await fs.stat(destination).catch(() => undefined)) throw error; await verifyWebPatch(destination, revision); }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  async publish(input: WebPatchRequest, codeRevision?: string): Promise<Receipt> {
    if (!input || typeof input.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.operationId) || !WEB_PATCH_HASH.test(input.candidate)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid Web patch publication.");
    if (this.closed || this.queued >= 8) throw new Error("Web patch publication is unavailable or busy.");
    const request = structuredClone(input);
    if (codeRevision !== undefined && !WEB_PATCH_HASH.test(codeRevision)) throw new Error("Invalid automatic code publication revision.");
    const fingerprint = publicationFingerprint(request.operationId, request.candidate, request.expectedRevision, codeRevision);
    this.queued++;
    try {
      const result = this.tail.then(async () => {
        await this.ready;
        if (!this.state || this.fault) throw new Error("Web patch state is unavailable; query the original operation.");
        const identity = this.options.identity();
        if (Object.keys(identity).some(key => request[key as keyof WebPatchIdentity] !== identity[key as keyof WebPatchIdentity])) throw new Error("Web patch runtime identity changed.");
        const original = this.operation(request.operationId);
        if (original) { if (original.fingerprint !== fingerprint) throw new Error("Web patch operation payload conflict."); return original; }
        await this.compatible(request.candidate);
        const admission = request.candidate === this.state.previous ? undefined : await this.options.developerAdmission?.prepareManagedCandidate({ kind: "web-patch", sha256: request.candidate,
          candidateRoot: path.join(this.candidates, request.candidate), originSourceRoot: await this.developerOrigins.source("web-patch", request.candidate) }, this.admissionAbort.signal);
        if (admission?.diagnostic) this.options.developerDiagnostic?.(admission.diagnostic);
        return this.options.serialize(request.pluginGenerationId, async () => {
          if (this.closed || request.expectedRevision !== this.state!.revision) throw new Error("Web patch baseline changed.");
          if (this.state!.operations.length >= 2048) throw new Error("Web patch receipt limit reached; no history is silently discarded.");
          const commitCode = await this.codeCommit(codeRevision);
          admission?.assertCurrent();
          const receipt: Receipt = { operationId: request.operationId, fingerprint, state: "committed", revision: this.state!.revision + 1,
            active: request.candidate, previous: this.state!.active, ...(codeRevision === undefined ? {} : { codeRevision }) };
          const next: State = { ...this.state!, active: receipt.active, previous: receipt.previous, revision: receipt.revision,
            operations: [...this.state!.operations, receipt], ...(codeRevision === undefined ? {} : { codeRevision }) };
          this.pending = next;
          try { await writeWebPatchJson(this.statePath, next); }
          catch (error) {
            const saved = await fs.readFile(this.statePath, "utf8").catch(() => undefined);
            if (saved !== JSON.stringify(next)) { this.fault = "Publication persistence is unconfirmed; do not replay."; throw error; }
          }
          try { commitCode?.(); }
          catch (error) { this.fault = "The saved code publication requires recovery; do not replay."; throw error; }
          this.state = next;
          this.pending = undefined;
          try { this.options.audit?.("web_patch_committed", { operationId: receipt.operationId, revision: receipt.revision, active: receipt.active, previous: receipt.previous }); }
          catch (error) { process.emitWarning(`Web publication committed but diagnostic logging failed: ${String(error)}`); }
          return structuredClone(receipt);
        });
      });
      this.tail = result.catch(() => undefined);
      return await result;
    } finally { this.queued--; }
  }

  async reconcile(operationId: string): Promise<{ state: "committed" | "not_started" | "unknown"; receipt?: Receipt }> {
    if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) throw new Error("Invalid Web patch operation identity.");
    await this.tail;
    const existing = this.operation(operationId);
    if (existing) return { state: "committed", receipt: existing };
    if (!this.state || !this.pending || this.pending.operations.at(-1)?.operationId !== operationId) return { state: this.fault ? "unknown" : "not_started" };
    const raw = await fs.readFile(this.statePath, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === JSON.stringify(this.pending)) {
      await this.compatible(this.pending.active);
      const commitCode = await this.codeCommit(this.pending.codeRevision);
      commitCode?.();
      this.state = this.pending;
      this.pending = undefined;
      this.fault = undefined;
      return { state: "committed", receipt: this.operation(operationId) };
    }
    if (raw === JSON.stringify(this.state) || (raw === undefined && this.state.revision === 0)) {
      this.pending = undefined;
      this.fault = undefined;
      return { state: "not_started" };
    }
    return { state: "unknown" };
  }

  async automatic(sourceRoot: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const pointerPath = path.join(sourceRoot, "dist/web-patches/latest.json");
    const raw = await fs.readFile(pointerPath, { encoding: "utf8", signal });
    if (raw.length > 4096) throw new Error("Web patch build marker is too large.");
    const pointer = JSON.parse(raw) as { revision: string; operationId: string };
    if (!WEB_PATCH_HASH.test(pointer.revision) || !/^[A-Za-z0-9_-]{1,128}$/.test(pointer.operationId)) throw new Error("Invalid Web patch build marker.");
    // Cancelling a watcher releases only its wait. Initialization remains owned
    // by ready and is cancelled and joined separately by service.stop().
    await this.waitForInitialization(signal);
    signal?.throwIfAborted();
    if (!this.state || this.fault || this.operation(pointer.operationId) || pointer.revision === this.state.active) return;
    await this.importLocalCandidate(path.join(sourceRoot, "dist/web-patches", pointer.revision), pointer.revision, sourceRoot);
    signal?.throwIfAborted();
    if (await fs.readFile(pointerPath, "utf8") !== raw) return;
    await this.publish({ ...this.options.identity(), operationId: pointer.operationId, candidate: pointer.revision, expectedRevision: this.state.revision });
  }

  async modules(modules: readonly WebPluginModule[], revision?: string | null): Promise<readonly WebPluginModule[]> {
    if (!revision) return modules;
    const manifest = await this.compatible(revision);
    return modules.map(module => {
      if (!manifest.modules.some(entry => entry.pluginId === module.pluginId && entry.version === module.version)) throw new Error("Web release has no compatible module entry.");
      return { ...module, rev: revision, entryPath: "web/client.mjs" };
    });
  }

  async module(modules: readonly WebPluginModule[], id: string, revision: string, filename: string) {
    if (filename !== "web/client.mjs") return undefined;
    const module = modules.find(entry => entry.id === id);
    if (!module) return undefined;
    let manifest: WebPatchManifest;
    try { manifest = await this.compatible(revision); }
    catch { return undefined; }
    const entry = manifest.modules.find(item => item.pluginId === module.pluginId && item.version === module.version);
    if (!entry) return undefined;
    return { module: { ...module, rev: revision, entryPath: filename }, path: filename,
      source: Buffer.from(`export { activate } from "${WEB_PATCH_PREFIX}${revision}/${entry.entry}";\n`) };
  }

  private waitForInitialization(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.ready;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
      signal.addEventListener("abort", aborted, { once: true });
      void this.ready.then(() => { signal.removeEventListener("abort", aborted); resolve(); });
    });
  }

  async stop(): Promise<void> {
    this.admissionAbort.abort();
    this.closed = true;
    if (this.initializing) this.initializationAbort.abort(new Error("Web patch initialization stopped."));
    await Promise.all([this.ready, this.tail, this.importTail]);
  }
}
