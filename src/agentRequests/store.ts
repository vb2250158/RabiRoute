import { getTimeoutMs, readTimeoutOverrides, validateTimeoutOverrides } from "../shared/timeoutSettings.js";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { AgentRequestState, resolveAgentRequestReplyDestination, type AgentRequestRecord, type AgentRequestParty, type PrepareAgentCommunicationInput,
  type AgentCommunicationPreparation, type EndpointDeliveryMetadata } from "./state.js";
import { JsonFileAgentRequestPersistence, type AgentRequestPersistence } from "./persistence.js";
import { AgentRequestPersistenceTransport } from "./persistenceTransport.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import type { EndpointDeliveryNoFrameProof } from "./deliveryFailure.js";
import { sameAgentParty, type AgentRequestEndpoint } from "./endpoint.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { AgentReplyStateError } from "./replyError.js";
import { AgentThreadContractError } from "./requestValidation.js";
import { currentOperationContext, recordDataMutationAudit, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

export { AGENT_REQUEST_SCHEMA_VERSION, AGENT_REQUEST_REMINDER_MS, agentDeliveryPromptHash } from "./state.js";
export type { AgentResponsePolicy, AgentRequestStatus, AgentRequestParty, AgentRequestResponse, AgentRequestRecord,
  AgentCommunicationPreparation, PrepareAgentCommunicationInput, EndpointDeliveryMetadata } from "./state.js";
export type { AgentRequestPersistence } from "./persistence.js";
export type EndpointDeliverySnapshot = Omit<PreparedEndpointDelivery, "prompt">;
type Model = { requests: AgentRequestRecord[]; deliveries: EndpointDeliverySnapshot[]; unavailableDeliveryIds: string[];
  evidence: { available: boolean; reason?: string } };
type Delta = { requests: AgentRequestRecord[]; removedRequests: string[]; deliveries: EndpointDeliverySnapshot[]; removedDeliveries: string[] };
type Reply = { ok: boolean; revision: number; value?: unknown; delta?: Delta; error?: any; audit?: RecordedDataMutationAudit[] };
type StoreOptions = { workerURL?: URL; timeoutMs?: number; maxQueue?: number };
type QueuedOperation = { run(): Promise<unknown>; resource: AsyncResource; resolve(value: unknown): void; reject(error: unknown): void };
const readCommands = new Set(["readEndpointDelivery", "readCallerEndpointDelivery", "listEndpointDeliveries", "readRequests", "close"]);

export class AgentRequestStoreUnavailableError extends Error {
  readonly code: string;
  readonly statusCode = 503;
  readonly retryable = false;
  constructor(message: string, readonly commitState: "not_started" | "unknown" = "not_started", options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRequestStoreUnavailableError";
    this.code = commitState === "unknown" ? "AGENT_REQUEST_COMMIT_UNKNOWN" : "AGENT_REQUEST_STORE_UNAVAILABLE";
  }
}
function revive(error: any): unknown {
  if (Object.hasOwn(error ?? {}, "thrown")) return error.thrown;
  const value = Object.assign(new Error(error?.message ?? "Agent request mutation failed."), error?.properties, { name: error?.name ?? "Error" });
  if (error?.name === "AgentReplyStateError") Object.setPrototypeOf(value, AgentReplyStateError.prototype);
  if (error?.name === "AgentThreadContractError") Object.setPrototypeOf(value, AgentThreadContractError.prototype);
  return value;
}
function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "temp", "tmp", "tmpdir", "lang", "lc_all", "lc_ctype"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toLowerCase()))),
    RABIROUTE_TIMEOUT_OVERRIDES: JSON.stringify(readTimeoutOverrides()) };
}

/** One durable owner; this process publishes only committed request/metadata projections. */
export class AgentRequestStore {
  private readonly requests = new Map<string, AgentRequestRecord>();
  private readonly deliveries = new Map<string, EndpointDeliverySnapshot>();
  private readonly unavailableDeliveryIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private evidence: Model["evidence"] = { available: false, reason: "Agent request evidence is still loading." };
  private loaded = false;
  private revision = 0;
  private readonly waiting: QueuedOperation[] = [];
  private active?: Promise<void>;
  private queued = 0;
  private failure?: AgentRequestStoreUnavailableError;
  private closing = false;
  private closure?: Promise<void>;
  private child?: ChildProcess;
  private wire?: AgentRequestPersistenceTransport;
  private local?: AgentRequestState;
  private childClosed: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, { method: string; resolve(value: Reply): void; reject(error: unknown): void; timer: NodeJS.Timeout }>();
  private initialized!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private startupTimer?: NodeJS.Timeout;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private launch?: () => void;

  constructor(persistence: AgentRequestPersistence | string, private readonly now: () => Date = () => new Date(), options: StoreOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? getTimeoutMs("backend.agentRequests.store.owner.timeoutMs", 60_000);
    this.maxQueue = options.maxQueue ?? 128;
    validateTimeoutOverrides({ "backend.agentRequests.store.owner.timeoutMs": this.timeoutMs });
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue < 1 || this.maxQueue > 4096) throw new Error("Invalid Agent request persistence budget.");
    this.initialized = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.initialized.catch(() => {});
    const statePath = typeof persistence === "string" ? persistence : persistence instanceof JsonFileAgentRequestPersistence ? persistence.statePath : undefined;
    if (statePath === undefined) {
      this.local = new AgentRequestState(persistence as AgentRequestPersistence, this.now);
      this.publishInitial(this.local.readModel());
      return;
    }
    const source = import.meta.url.endsWith(".ts");
    const worker = options.workerURL ? new URL(options.workerURL.href) : new URL(source ? "./persistenceWorker.ts" : "./persistenceWorker.js", import.meta.url);
    const resolvedStatePath = path.resolve(statePath);
    this.launch = () => { try {
      const launchOptions: ForkOptions & { windowsHide: boolean } = { execArgv: source ? ["--import", "tsx"] : [],
        serialization: "advanced", env: workerEnvironment(), windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] };
      const child = this.child = fork(fileURLToPath(worker), [resolvedStatePath], launchOptions);
      this.childClosed = new Promise<void>(resolve => child.once("close", (code, signal) => {
        if (!this.closing || this.pending.size || code !== 0 || signal !== null) this.fail(new AgentRequestStoreUnavailableError(
          "Agent request persistence owner exited before its confirmed close.", this.hasUnconfirmedMutation() ? "unknown" : "not_started"));
        resolve();
      }));
      const port = { postMessage(value: unknown) { child.send(value as object); },
        on(_event: "message", listener: (value: any) => void) { child.on("message", listener); },
        off(_event: "message", listener: (value: any) => void) { child.off("message", listener); } };
      this.wire = new AgentRequestPersistenceTransport(port, (id, value) => this.receive(id, value), error => this.fail(
        new AgentRequestStoreUnavailableError("Agent request persistence transport failed.", this.hasUnconfirmedMutation() ? "unknown" : "not_started", { cause: error })));
      child.once("error", error => this.fail(new AgentRequestStoreUnavailableError("Agent request persistence owner could not start.", "not_started", { cause: error })));
      this.startupTimer = setTimeout(() => this.fail(new AgentRequestStoreUnavailableError("Agent request evidence loading timed out.")), this.timeoutMs);
      this.startupTimer.unref();
    } catch (error) { this.fail(new AgentRequestStoreUnavailableError("Agent request persistence owner could not start.", "not_started", { cause: error })); } };
  }
  ready(): Promise<void> {
    const launch = this.launch;
    this.launch = undefined;
    if (this.closing) return Promise.reject(new AgentRequestStoreUnavailableError("Agent request persistence owner is closing."));
    launch?.();
    return this.initialized;
  }
  private publishInitial(model: Model): void {
    for (const record of model.requests) this.requests.set(record.id, record);
    for (const delivery of model.deliveries) this.deliveries.set(delivery.deliveryId, delivery);
    for (const id of model.unavailableDeliveryIds) this.unavailableDeliveryIds.add(id);
    this.evidence = model.evidence;
    this.loaded = true;
    if (model.evidence.available) this.resolveReady();
    else this.rejectReady(new AgentRequestStoreUnavailableError(model.evidence.reason ?? "Original Agent request evidence is unavailable."));
  }
  private receive(id: string, value: unknown): void {
    if (this.failure) return;
    if (id === "ready") {
      clearTimeout(this.startupTimer);
      const result = value as { revision: number; model?: Model; error?: unknown };
      if (!result.model) { this.fail(new AgentRequestStoreUnavailableError("Agent request evidence loading failed.")); return; }
      this.revision = result.revision; this.publishInitial(result.model); return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(value as Reply);
  }
  private fail(error: AgentRequestStoreUnavailableError): void {
    this.failure ??= error;
    this.evidence = { available: false, reason: this.failure.message };
    clearTimeout(this.startupTimer); this.rejectReady(this.failure);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear(); this.wire?.stop(this.failure);
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
  private hasUnconfirmedMutation(): boolean { return [...this.pending.values()].some(value => !readCommands.has(value.method)); }
  private assertLoaded(): void {
    if (this.failure) throw this.failure;
    if (!this.loaded) throw new AgentRequestStoreUnavailableError("Agent request evidence is still loading.");
  }
  private assertComplete(): void {
    this.assertLoaded();
    if (!this.evidence.available) throw new AgentRequestStoreUnavailableError(this.evidence.reason ?? "Original Agent request evidence is unavailable.");
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AgentRequestStoreUnavailableError("Agent request persistence owner is closing."));
    if (this.queued >= this.maxQueue) return Promise.reject(new AgentRequestStoreUnavailableError("Agent request mutation queue is full."));
    this.queued++;
    const resource = new AsyncResource("AgentRequestStoreOperation");
    const work = new Promise<T>((resolve, reject) => this.waiting.push({ resource,
      run: () => resource.runInAsyncScope(operation), resolve: value => resolve(value as T), reject }));
    this.drain();
    return work;
  }
  private drain(): void {
    if (this.active || this.closing) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.active = (async () => {
      try { next.resolve(await next.run()); }
      catch (error) { next.reject(error); }
      finally { next.resource.emitDestroy(); this.queued--; this.active = undefined; this.drain(); }
    })();
  }
  private async rpc(method: string, args: unknown[]): Promise<Reply> {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    const result = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AgentRequestStoreUnavailableError("Agent request persistence operation timed out.",
        readCommands.has(method) ? "not_started" : "unknown")), this.timeoutMs);
      timer.unref(); this.pending.set(id, { method, resolve, reject, timer });
    });
    void this.wire!.send(id, { method, args, revision: this.revision, timestamp: this.now().getTime(), context: currentOperationContext() })
      .catch(error => this.fail(new AgentRequestStoreUnavailableError("Agent request persistence dispatch failed.", readCommands.has(method) ? "not_started" : "unknown", { cause: error })));
    return result;
  }
  private apply(delta: Delta): void {
    for (const id of delta.removedRequests) this.requests.delete(id);
    for (const record of delta.requests) this.requests.set(record.id, record);
    for (const id of delta.removedDeliveries) this.deliveries.delete(id);
    for (const delivery of delta.deliveries) this.deliveries.set(delivery.deliveryId, delivery);
    if (delta.requests.length || delta.removedRequests.length || delta.deliveries.length || delta.removedDeliveries.length) {
      const observerFailed = () => { console.error(JSON.stringify({ event: "endpoint_delivery_listener_failed", result: "observer_failed" })); };
      for (const listener of this.listeners) {
        try { void Promise.resolve(listener()).catch(observerFailed); }
        catch { observerFailed(); }
      }
    }
  }
  private mutationFailed(error: unknown): never {
    if ((error as { commitState?: string })?.commitState === "unknown") {
      const unknown = new AgentRequestStoreUnavailableError("Original Agent request commit requires reconciliation.", "unknown", { cause: error });
      this.fail(unknown);
      throw unknown;
    }
    throw error;
  }
  private async mutate<T>(method: string, args: unknown[] | (() => unknown[])): Promise<T> {
    if (this.failure) throw this.failure;
    const captured = typeof args === "function" ? args : structuredClone(args);
    return this.enqueue(async () => {
      await this.ready(); this.assertComplete();
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request mutation was not dispatched before owner close.");
      const values = typeof captured === "function" ? structuredClone(captured()) : captured;
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request mutation was not dispatched before owner close.");
      if (this.local) {
        if (method === "recordTargetTurnEnded" && values[3] !== undefined) values[3] = new Date(values[3] as string);
        if (method === "noteEndpointDeliveryFailure" && (values[1] as any)?.__error) {
          const error = values[1] as any; values[1] = Object.assign(new Error(error.message), error.properties);
        }
        try {
          const committed = this.local.transaction(() => method === "reconcileOpenParties"
            ? this.local!.reconcileOpenParties((_party, record, role) => new Map<string, any>(values[0] as any).get(record.id)?.[role])
            : Reflect.apply(Reflect.get(this.local!, method), this.local, values));
          this.revision++; this.apply(committed.delta); return structuredClone(committed.value) as T;
        } catch (error) { return this.mutationFailed(error); }
      }
      const reply = await this.rpc(method, values);
      for (const audit of reply.audit ?? []) recordDataMutationAudit(audit);
      if (!reply.ok) {
        return this.mutationFailed(revive(reply.error));
      }
      if (reply.revision !== this.revision + 1 || !reply.delta) {
        const error = new AgentRequestStoreUnavailableError("Agent request persistence acknowledgement revision mismatch.", "unknown"); this.fail(error); throw error;
      }
      this.revision = reply.revision; this.apply(reply.delta); return reply.value as T;
    });
  }
  close(): Promise<void> {
    if (this.closure) return this.closure;
    this.closing = true;
    if (this.launch) {
      this.launch = undefined;
      this.rejectReady(new AgentRequestStoreUnavailableError("Agent request owner closed before loading began."));
    } else if (!this.loaded && this.child && !this.failure) {
      // Loading cannot have admitted a mutation; cancel this read-only child and
      // still join its real OS close instead of waiting on an unrelated read.
      this.fail(new AgentRequestStoreUnavailableError("Agent request owner closed while loading evidence."));
    }
    for (const queued of this.waiting.splice(0)) {
      this.queued--;
      queued.reject(new AgentRequestStoreUnavailableError("Agent request operation was not dispatched before owner close."));
      queued.resource.emitDestroy();
    }
    return this.closure = (async () => {
      await this.active; await this.initialized.catch(() => {});
      if (this.child && !this.failure) {
        const reply = await this.rpc("close", []);
        if (!reply.ok) this.fail(new AgentRequestStoreUnavailableError("Agent request persistence owner did not acknowledge close."));
      }
      await this.childClosed;
      // Failed initialization admitted no mutation. Its business error is not a
      // cleanup failure once the real child is closed; unknown commits stay fenced.
      if (this.failure && (this.loaded || this.failure.commitState === "unknown")) throw this.failure;
    })();
  }
  getEndpointDeliveryEvidenceStatus(): Model["evidence"] { return { ...this.evidence }; }
  getEndpointDelivery(id: string): EndpointDeliverySnapshot | undefined {
    this.assertLoaded(); const value = this.deliveries.get(id);
    if (!value) this.assertComplete(); return value ? structuredClone(value) : undefined;
  }
  readEndpointDelivery(id: string): Promise<PreparedEndpointDelivery | undefined> {
    return this.enqueue(async () => {
      await this.ready(); this.assertComplete();
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request read was not dispatched before owner close.");
      if (this.local) return this.local.getEndpointDelivery(id);
      const reply = await this.rpc("readEndpointDelivery", [id]);
      if (!reply.ok) throw revive(reply.error);
      if (reply.revision !== this.revision) throw new AgentRequestStoreUnavailableError("Agent request read revision mismatch.");
      return reply.value as PreparedEndpointDelivery | undefined;
    });
  }
  readCallerEndpointDelivery(source: AgentRequestEndpoint, callerDeliveryId: string): Promise<PreparedEndpointDelivery | undefined> {
    const captured = structuredClone(source);
    return this.enqueue(async () => {
      await this.ready(); this.assertComplete();
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request read was not dispatched before owner close.");
      if (this.local) return this.local.readCallerEndpointDelivery(captured, callerDeliveryId);
      const reply = await this.rpc("readCallerEndpointDelivery", [captured, callerDeliveryId]);
      if (!reply.ok) throw revive(reply.error);
      if (reply.revision !== this.revision) throw new AgentRequestStoreUnavailableError("Agent request read revision mismatch.");
      return reply.value as PreparedEndpointDelivery | undefined;
    });
  }
  listEndpointDeliveries(): Promise<PreparedEndpointDelivery[]> {
    return this.enqueue(async () => {
      await this.ready(); this.assertComplete();
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request read was not dispatched before owner close.");
      if (this.local) return this.local.listEndpointDeliveries();
      const reply = await this.rpc("listEndpointDeliveries", []);
      if (!reply.ok) throw revive(reply.error);
      if (reply.revision !== this.revision) throw new AgentRequestStoreUnavailableError("Agent request read revision mismatch.");
      return reply.value as PreparedEndpointDelivery[];
    });
  }
  listEndpointDeliveryMetadata(): EndpointDeliveryMetadata[] {
    this.assertComplete();
    return [...this.deliveries.values()].map(value => structuredClone({
      deliveryId: value.deliveryId, callerDeliveryId: value.callerDeliveryId, state: value.state,
      source: value.source, target: value.target, receipt: value.receipt, createdAt: value.createdAt, updatedAt: value.updatedAt,
      lastAttemptAt: value.lastAttemptAt, nextAttemptAt: value.nextAttemptAt, attemptCount: value.attemptCount,
      lastError: value.lastError, blockedReason: value.blockedReason
    }));
  }
  listUnavailableEndpointDeliveryIds(): string[] { this.assertLoaded(); return [...this.unavailableDeliveryIds]; }
  get(id: string): AgentRequestRecord | undefined {
    this.assertLoaded(); const value = this.requests.get(id.trim().slice(0, 100));
    if (!value) this.assertComplete(); return value ? structuredClone(value) : undefined;
  }
  list(): AgentRequestRecord[] { this.assertComplete(); return [...this.requests.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(value => structuredClone(value)); }
  readRequests(): Promise<AgentRequestRecord[]> {
    return this.enqueue(async () => {
      await this.ready(); this.assertComplete();
      if (this.closing) throw new AgentRequestStoreUnavailableError("Agent request read was not dispatched before owner close.");
      if (this.local) return this.local.list();
      const reply = await this.rpc("readRequests", []);
      if (!reply.ok) throw revive(reply.error);
      if (reply.revision !== this.revision) throw new AgentRequestStoreUnavailableError("Agent request read revision mismatch.");
      return reply.value as AgentRequestRecord[];
    });
  }
  dueReminders(at = this.now()): AgentRequestRecord[] {
    this.assertComplete();
    return [...this.requests.values()].filter(value => value.status === "awaiting_response" && Boolean(value.nextReminderAt)
      && (Date.parse(value.nextReminderAt!) || Infinity) <= at.getTime()).sort((a, b) => Date.parse(a.nextReminderAt!) - Date.parse(b.nextReminderAt!))
      .map(value => structuredClone(value));
  }
  hasManagedSession(threadId: string, workspace?: string): boolean {
    this.assertComplete();
    const id = threadId.trim().slice(0, 4096);
    for (const value of this.requests.values()) if ([value.source, value.target].some(party => party.threadId === id
      && (!party.workspace || !workspace || sameCodexWorkspace(party.workspace, workspace)))) return true;
    return false;
  }
  hasEndpointDeliveryReservation(id: string): boolean {
    this.assertLoaded(); if (this.deliveries.has(id) || this.unavailableDeliveryIds.has(id)
      || [...this.requests.values()].some(value => value.deliveryId === id || value.pendingResponseDeliveryId === id || value.response?.deliveryId === id)) return true;
    this.assertComplete(); return false;
  }
  assertEndpointDeliveryActive(id: string): void {
    this.assertComplete(); const delivery = this.deliveries.get(id);
    if (!delivery || delivery.state === "cancelled") throw new Error("Endpoint delivery is missing or cancelled.");
    const preparation = delivery.preparation, request = preparation.requestId ? this.requests.get(preparation.requestId) : undefined,
      original = preparation.inReplyToRequestId ? this.requests.get(preparation.inReplyToRequestId) : undefined;
    if ((preparation.requestId && (!request || request.status === "cancelled" || request.deliveryId !== id || !sameAgentParty(request.source, preparation.source) || !sameAgentParty(request.target, preparation.target)))
      || (preparation.inReplyToRequestId && (!original || original.status === "cancelled" || !sameAgentParty(original.target, preparation.source) || !sameAgentParty(original.source, preparation.target)
        || (original.pendingResponseDeliveryId !== id && original.response?.deliveryId !== id)))) throw new Error("Endpoint request was cancelled or its exact reservation changed; execution and reconciliation are forbidden.");
  }
  resolveReplyDestination(requestId: string, responding: AgentRequestParty, requested: AgentRequestParty): AgentRequestParty | undefined {
    return resolveAgentRequestReplyDestination(this.get(requestId), responding, requested);
  }
  onEndpointDeliveryChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  bindEndpointDelivery(value: PreparedEndpointDelivery): Promise<void> { return this.mutate("bindEndpointDelivery", [value]); }
  markEndpointDispatching(id: string): Promise<string> { return this.mutate("markEndpointDispatching", [id]); }
  noteEndpointDeliveryFailure(id: string, error: unknown, options: { blocked?: boolean } = {}): Promise<void> {
    return this.mutate("noteEndpointDeliveryFailure", [id, error instanceof Error ? { __error: true, message: error.message, properties: { code: (error as any).code } } : error, options]);
  }
  markEndpointNotSent(id: string, proof?: EndpointDeliveryNoFrameProof): Promise<void> { return this.mutate("markEndpointNotSent", [id, proof]); }
  commitEndpointReceipt(id: string, receipt: EndpointDeliveryReceipt): Promise<void> { return this.mutate("commitEndpointReceipt", [id, receipt]); }
  reconcileOpenParties(resolve: Parameters<AgentRequestState["reconcileOpenParties"]>[0]): Promise<ReturnType<AgentRequestState["reconcileOpenParties"]>> {
    return this.mutate("reconcileOpenParties", () => [[...this.requests.values()].filter(record =>
      (record.status === "pending_delivery" || record.status === "awaiting_response") && !record.source.endpoint && !record.target.endpoint).map(record => [record.id, {
      source: resolve(structuredClone(record.source), structuredClone(record), "source"),
      target: resolve(structuredClone(record.target), structuredClone(record), "target")
    }])]);
  }
  prepare(value: PrepareAgentCommunicationInput): Promise<AgentCommunicationPreparation> { return this.mutate("prepare", [value]); }
  bindResponseEvidence(preparation: AgentCommunicationPreparation, prompt: string): Promise<void> { return this.mutate("bindResponseEvidence", [preparation, prompt]); }
  commit(preparation: AgentCommunicationPreparation, receipt: { action?: string; transport?: string } = {}): Promise<ReturnType<AgentRequestState["commit"]>> { return this.mutate("commit", [preparation, receipt]); }
  abort(preparation: AgentCommunicationPreparation): Promise<void> { return this.mutate("abort", [preparation]); }
  recordTargetTurnEnded(threadId: string, workspace: string | undefined, turnId: string, endedAt = this.now()): Promise<AgentRequestRecord[]> { return this.mutate("recordTargetTurnEnded", [threadId, workspace, turnId, endedAt.toISOString()]); }
  recordPendingResponseCheck(id: string, deliveryId: string, status: string): Promise<void> { return this.mutate("recordPendingResponseCheck", [id, deliveryId, status]); }
  recordReminderResult(id: string, delivered: boolean, error?: unknown): Promise<AgentRequestRecord> { return this.mutate("recordReminderResult", [id, delivered, error instanceof Error ? error.message : error]); }
  cancel(id: string, reason?: string): Promise<AgentRequestRecord> { return this.mutate("cancel", [id, reason]); }
}
