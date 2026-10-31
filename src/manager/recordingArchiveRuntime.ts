import type http from "node:http";
import { RecordingArchiveBindings } from "./recordingArchiveBindings.js";
import { RecordingArchiveStore } from "./recordingArchiveStore.js";
import { RecordingArchiveCatalog, RecordingArchiveCatalogError, type RecordingArchiveCatalogQuery } from "./recordingArchiveCatalog.js";
import { runRecordingArchiveOperation } from "./recordingArchiveRoutes.js";
import { recordingManifestHash, type RecordingManifest, type ArchiveReceipt } from "./recordingArchiveContract.js";
import type { ApiOperationResult } from "./apiOperationContract.js";
import { archiveCatalogQuerySchema, RECORDING_ARCHIVE_PROCESSING_STATES } from "./recordingArchiveSchemas.js";
import { resourceRequestGuard, type ResourceApiInput } from "./resourceApiRequest.js";

export interface RecordingArchiveProcessing {
  state: typeof RECORDING_ARCHIVE_PROCESSING_STATES[number];
  text?: string;
  jobKey?: string;
  processingVersion?: string;
}

export interface RecordingArchiveRuntimeOptions {
  stateDir: string;
  roleDirectory(roleId: string): string;
  workerId(): string;
  /** Resolve an existing target owner through public connection admission or the authenticated device resources transport. */
  authorizeResources(request: http.IncomingMessage): string | null | Promise<string | null>;
  localAdmin(request: http.IncomingMessage): boolean;
  readOnly(): boolean;
  onCommitted?(owner: string, manifest: RecordingManifest, receipt: ArchiveReceipt): void | Promise<void>;
  /** Read durable job/result truth for this exact owner + record + manifest. Never select a model here. */
  readProcessing?(owner: string, recordId: string, manifestHash: string): Promise<RecordingArchiveProcessing | null>;
}
/** Assembly only: no listener, polling, implicit provisioning or legacy-cache migration. */
export class RecordingArchiveRuntime {
  readonly bindings: RecordingArchiveBindings;
  readonly store: RecordingArchiveStore;
  readonly catalog: RecordingArchiveCatalog;
  private closed = false;
  private restoring = new Map<string, Promise<void>>();
  constructor(private readonly options: RecordingArchiveRuntimeOptions) {
    this.bindings = new RecordingArchiveBindings(options.stateDir, options.roleDirectory);
    this.store = new RecordingArchiveStore({ resolveOwner: owner => this.bindings.resolveOwner(owner), workerId: options.workerId,
      committed: async (owner, manifest, receipt) => {
        if (this.closed) return;
        // restoreOwner is explicit; onCommitted refuses to invent a partial directory.
        try { await this.catalog.onCommitted(owner, manifest, receipt); }
        finally { await options.onCommitted?.(owner, manifest, receipt); }
      } });
    this.catalog = new RecordingArchiveCatalog({ stateDir: options.stateDir, resolveOwner: owner => this.bindings.describeOwner(owner), store: this.store, workerId: options.workerId });
  }
  async restoreOwner(owner: string): Promise<void> {
    if (this.closed) throw new Error("archive_runtime_closed");
    const existing = this.restoring.get(owner); if (existing) return existing;
    const operation = (async () => {
      const binding = await this.bindings.describeOwner(owner);
      try { await this.catalog.restoreCache(owner, binding.storageNamespaceId); } catch { /* No valid cache: list remains unavailable until full restore. */ }
      if (!this.closed) await this.catalog.restore(owner);
    })();
    this.restoring.set(owner, operation);
    try { await operation; } finally { this.restoring.delete(owner); }
  }
  async restore(): Promise<{ owner: string; ready: boolean }[]> {
    const snapshot = await this.bindings.listBindings();
    const outcomes: { owner: string; ready: boolean }[] = [];
    for (const [owner, binding] of Object.entries(snapshot.ownerRoleBindings)) {
      if (this.closed) break;
      if (!binding.enabled) continue;
      try { await this.restoreOwner(owner); outcomes.push({ owner, ready: true }); }
      catch { outcomes.push({ owner, ready: false }); }
    }
    return outcomes;
  }
  /** Internal administrative API only. HTTP mutation requires the Manager's full write contract. */
  async configure(request: http.IncomingMessage, input: { owner: string; roleId: string; storageNamespaceId: string; expectedRevision: number; enabled?: boolean; provision?: boolean }) {
    if (this.closed || this.options.readOnly() || !this.options.localAdmin(request) || request.headers["x-rabilink-tunnel-local"] !== undefined) throw new Error("archive_admin_denied");
    if (input.provision) await this.bindings.provisionNamespace(input.roleId, input.storageNamespaceId);
    const result = await this.bindings.configure(input.owner, input.roleId, input.storageNamespaceId, input.expectedRevision, input.enabled ?? true);
    if (result.enabled) await this.restoreOwner(input.owner);
    return result;
  }
  private async processing(owner: string, recordId: string, manifestHash: string): Promise<RecordingArchiveProcessing> {
    try {
      const value = await this.options.readProcessing?.(owner, recordId, manifestHash);
      if (!value || !RECORDING_ARCHIVE_PROCESSING_STATES.includes(value.state)) return { state: "unavailable" };
      const result: RecordingArchiveProcessing = { state: value.state };
      // Only successful, matching durable results may add text; failed reads never replace cached text.
      if (value.state === "completed" && typeof value.text === "string") result.text = value.text;
      if (typeof value.jobKey === "string") result.jobKey = value.jobKey;
      if (typeof value.processingVersion === "string") result.processingVersion = value.processingVersion;
      return result;
    } catch { return { state: "unavailable" }; }
  }
  /** Await BEFORE the legacy resource-cache handler. false is returned only for unrelated routes or unbound legacy object owners. */
  async operation(input: ResourceApiInput): Promise<ApiOperationResult | undefined> {
    const { request, url } = input;
    const object = input.route.family === "object";
    if (!object && input.route.family !== "archive") return;
    let guard = () => {};
    const json = (status: number, body: unknown): ApiOperationResult => ({ status, body });
    try {
      guard = resourceRequestGuard(request);
      if (this.closed) return json(503, { code: "archive_runtime_closed" });
      const owner = await this.options.authorizeResources(request);
      guard();
      if (!owner) return json(403, { code: "archive_access_denied" });
      const binding = await this.bindings.lookupOwner(owner);
      guard();
      if (!binding) {
        if (object) return;
        return json(403, { code: "archive_owner_unbound" });
      }
      if (!binding.enabled) return json(403, { code: "archive_owner_disabled" });
      if (input.route.key === "archive.capabilities") {
        if (request.method !== "GET") return json(405, { code: "method_not_allowed" });
        const target = await this.bindings.describeOwner(owner);
        const capabilities = await this.store.capabilities(owner);
        const current = await this.bindings.describeOwner(owner);
        if (binding.bindingRevision !== target.bindingRevision || current.bindingRevision !== target.bindingRevision
            || current.root !== target.root || current.storageNamespaceId !== target.storageNamespaceId
            || capabilities.storageNamespaceId !== target.storageNamespaceId
            || !Number.isSafeInteger(current.bindingRevision) || current.bindingRevision < 1) {
          return json(503, { code: "archive_binding_changed" });
        }
        guard(); return json(200, { ...capabilities, bindingRevision: current.bindingRevision, uploadAllowed: true });
      }
      if (input.route.key === "archive.recordings.list") {
        if (request.method !== "GET") return json(405, { code: "method_not_allowed" });
        const query: RecordingArchiveCatalogQuery = {};
        for (const key of url.searchParams.keys()) if (!Object.hasOwn(archiveCatalogQuerySchema.properties, key) || url.searchParams.getAll(key).length !== 1) throw new RecordingArchiveCatalogError("invalid_query", 400);
        for (const key of ["limit", "from", "to"] as const) {
          const value = url.searchParams.get(key);
          if (value !== null) { if (!/^\d+$/.test(value)) throw new RecordingArchiveCatalogError("invalid_query", 400); query[key] = Number(value); }
        }
        if (url.searchParams.has("cursor")) query.cursor = url.searchParams.get("cursor")!;
        if (url.searchParams.has("source")) query.source = url.searchParams.get("source") as RecordingManifest["source"];
        const page = await this.catalog.list(owner, query);
        const items = page.items.map(row => ({ ...row, asrState: "unavailable" as RecordingArchiveProcessing["state"] }));
        let next = 0;
        // Only this media page is enriched, at most four NAS reads in flight. No result changes ordering/cursors.
        if (!page.offline) await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
          while (next < items.length) {
            const index = next++, row = items[index];
            const processing = await this.processing(owner, row.recordId, row.manifestHash);
            items[index] = Object.assign(row, { asrState: processing.state }, processing.text !== undefined ? { text: processing.text } : {}, processing.jobKey !== undefined ? { jobKey: processing.jobKey } : {}, processing.processingVersion !== undefined ? { processingVersion: processing.processingVersion } : {});
          }
        }));
        guard(); return json(200, { ...page, items });
      }
      if (input.route.key === "archive.processing.read") {
        if (request.method !== "GET") return json(405, { code: "method_not_allowed" });
        if (url.searchParams.size) return json(400, { code: "invalid_query" });
        const recordId = input.path.recordId!;
        let manifest: RecordingManifest;
        try { manifest = await this.store.getManifest(owner, recordId); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(404, { code: "archive_not_found" }); throw error; }
        const manifestHash = recordingManifestHash(manifest);
        const processing = await this.processing(owner, recordId, manifestHash); guard(); return json(200, { recordId, manifestHash, ...processing });
      }
      // Preserve the exact authenticated identity; never reselect a worker or trust body owner fields.
      const result = await runRecordingArchiveOperation({ store: this.store, authorize: () => owner, readOnly: this.options.readOnly }, input);
      guard(); return result;
    } catch (error) {
      try { guard(); } catch (revoked) { error = revoked; }
      if ((error as { status?: number })?.status === 403) return json(403, { code: "archive_access_denied" });
      return json(error instanceof RecordingArchiveCatalogError ? error.statusCode : 503, { code: error instanceof RecordingArchiveCatalogError ? error.code : "archive_unavailable" });
    }
  }
  /** Stops new work and joins already-started filesystem recovery; no abandoned background writes. */
  async dispose(): Promise<void> { this.closed = true; await Promise.allSettled([...this.restoring.values()]); }
}
