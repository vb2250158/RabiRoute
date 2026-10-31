import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PluginIdentity } from "../plugin-kernel/types.js";

export type AsyncMethodEffect = "read" | "owned-resource" | "mutation" | "unknown";
export type OutcomeObservation = Readonly<{ identity: PluginIdentity; requestId: string; firstFailure?: unknown; receipt: Readonly<Record<string, unknown>> }>;
export type ArchivedOutcome = Readonly<{
  schemaVersion: 1; identity: PluginIdentity; requestId: string; firstFailure: unknown;
  firstObservation: Readonly<Record<string, unknown>>; current: Readonly<Record<string, unknown>>;
}>;
type FileOwner = {
  file: FileHandle; temporary: string; target: string; version: number; record: ArchivedOutcome;
  actualClose: Promise<void>; closeObserved: boolean; payloadReady: boolean; renamed: boolean;
  writeFailure?: unknown;
};
type Entry = { record: ArchivedOutcome; semantic: string; version: number; writtenVersion: number; loaded: boolean; loading?: Promise<void>; fileOwner?: FileOwner; confirmed: Promise<void>; confirm(): void; work?: Promise<void>; failure?: unknown };
/** A current observation is available, but no original-first fact was confirmed. */
export class OutcomeFirstUnavailableError extends Error {
  readonly code = "OUTCOME_FIRST_UNAVAILABLE";
  constructor(readonly identity: PluginIdentity, readonly requestId: string, readonly current: Readonly<Record<string, unknown>>, cause: unknown) {
    super("Original first outcome is unavailable; current observation must not substitute for it.", { cause });
    this.name = "OutcomeFirstUnavailableError";
  }
}
type ArchiveOptions = Readonly<{
  hotLimit?: number; pendingLimitPerPlugin?: number; readLimitPerPlugin?: number;
  /** Trusted owned-I/O seams for resource-fault fixtures; production uses native fs. */
  openFile?: (filename: string) => Promise<FileHandle>;
  readCold?: (filename: string) => Promise<string>;
}>;
const identityFields = ["applicationGenerationId", "managerInstanceId", "activationId", "instanceId", "pluginId", "version", "revision", "host"] as const;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const outcomeScopeKey = (identity: PluginIdentity): string => JSON.stringify(identityFields.map(field => identity[field]));
export const outcomeKey = (identity: PluginIdentity, requestId: string): string => hash(JSON.stringify([...identityFields.map(field => identity[field]), requestId]));
const pluginKey = (identity: PluginIdentity): string => JSON.stringify([identity.host, identity.pluginId, identity.instanceId]);
function data(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function scalarFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (!data(value)) return output;
  for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor && "value" in descriptor && ["string", "number", "boolean"].includes(typeof descriptor.value)) output[field] = descriptor.value; }
  return output;
}
const nativeFields = ["status", "code", "field", "operationId", "receiptId", "deliveryId", "mutationOutcome", "uncertain"];
function metadata(receipt: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  // The bridge supplies a sanitized DTO. Persist no args, response body, error
  // details or opaque error message; native formal receipts remain authoritative.
  return Object.freeze({ ...scalarFields(receipt, ["requestId", "sequence", "capability", "method", "status", "startedAt", "completedAt", "dispatchStarted", "settled", "executionOutcome", "effectOutcome", "responseDelivery", "retryAllowed", "uncertaintyObserved", "methodEffect"]), nativeOutcome: scalarFields(receipt.nativeOutcome, nativeFields), error: scalarFields(receipt.error, [...nativeFields, "effectOutcome", "dispatchStarted", "retryAllowed"]) });
}
function semantic(receipt: Readonly<Record<string, unknown>>): string {
  // Queued->received ACK is not a second native outcome requiring another fsync.
  return JSON.stringify({ status: receipt.status, dispatchStarted: receipt.dispatchStarted, settled: receipt.settled, executionOutcome: receipt.executionOutcome, effectOutcome: receipt.effectOutcome, responseUnavailable: receipt.responseDelivery === "unavailable", nativeOutcome: receipt.nativeOutcome, error: receipt.error });
}

/** Owns real uncertainty metadata only. Success/probe/startup calls do no disk I/O. */
export class AsyncPluginOutcomeArchive {
  readonly #hot = new Map<string, ArchivedOutcome>();
  readonly #pending = new Map<string, Entry>();
  readonly #reservations = new Map<string, Set<string>>();
  readonly #readReservations = new Map<string, Set<string>>();
  readonly #readTickets = new Set<string>();
  readonly #readUncertainty = new Map<string, Set<string>>();
  readonly #contradictoryReads = new Map<string, Map<string, Set<string>>>();
  readonly #contradictionOwners = new Map<string, Readonly<{ owner: string; method: string }>>();
  readonly #ticketOwners = new Map<string, string>();
  readonly #ticketCompletion = new Map<string, Readonly<{ promise: Promise<void>; complete(): void }>>();
  readonly #unreservedPending = new Map<string, Set<string>>();
  readonly #hotLimit: number;
  readonly #pendingLimit: number;
  readonly #readLimit: number;
  #closing = false;
  #writes = 0;
  constructor(readonly root: string, private readonly options: ArchiveOptions = {}) {
    this.#hotLimit = options.hotLimit ?? 64; this.#pendingLimit = options.pendingLimitPerPlugin ?? 64; this.#readLimit = options.readLimitPerPlugin ?? 64;
    if (!Number.isSafeInteger(this.#hotLimit) || this.#hotLimit < 1 || !Number.isSafeInteger(this.#pendingLimit) || this.#pendingLimit < 1 || !Number.isSafeInteger(this.#readLimit) || this.#readLimit < 1) throw new Error("Invalid async outcome archive capacity.");
  }
  reserve(identity: PluginIdentity, requestId: string, effect: AsyncMethodEffect): () => void {
    if (this.#closing) throw Object.assign(new Error("Outcome archive is closing; original call was not dispatched."), { code: "RPC_OUTCOME_ADMISSION_STOPPED", mutationOutcome: "not_started" });
    const read = effect === "read", pool = read ? this.#readReservations : this.#reservations;
    const owner = pluginKey(identity), key = outcomeKey(identity, requestId), tickets = pool.get(owner) ?? new Set<string>();
    const retained = read ? 0 : (this.#unreservedPending.get(owner)?.size ?? 0) + (this.#readUncertainty.get(owner)?.size ?? 0);
    if (this.#ticketOwners.has(key) || tickets.size + retained >= (read ? this.#readLimit : this.#pendingLimit)) throw Object.assign(new Error(read ? "This plugin has no free read outcome slot; original call was not dispatched." : "This plugin cannot preserve another unknown result; original call was not dispatched."), { code: read ? "RPC_READ_CAPACITY" : "RPC_OUTCOME_CAPACITY", mutationOutcome: "not_started" });
    tickets.add(key); pool.set(owner, tickets); if (read) this.#readTickets.add(key); this.#ticketOwners.set(key, owner);
    let complete!: () => void; const promise = new Promise<void>(resolve => { complete = resolve; }); this.#ticketCompletion.set(key, { promise, complete });
    return () => this.#release(key);
  }
  #release(key: string): void {
    const owner = this.#ticketOwners.get(key); if (owner === undefined) return;
    const pool = this.#readTickets.has(key) ? this.#readReservations : this.#reservations;
    const tickets = pool.get(owner); tickets?.delete(key); if (!tickets?.size) pool.delete(owner);
    this.#readTickets.delete(key); this.#ticketOwners.delete(key); this.#forgetReadFact(key, owner);
    this.#ticketCompletion.get(key)?.complete(); this.#ticketCompletion.delete(key);
  }
  /** Derived only from retained original uncertainty, shared across activations. */
  methodEffect(identity: PluginIdentity, capability: string, method: string, declared: AsyncMethodEffect): AsyncMethodEffect {
    return declared === "read" && this.#contradictoryReads.get(pluginKey(identity))?.has(JSON.stringify([capability, method])) ? "unknown" : declared;
  }
  #rememberReadFact(key: string, observation: OutcomeObservation): void {
    const owner = pluginKey(observation.identity), receipt = observation.receipt;
    if (this.#readTickets.has(key)) { const retained = this.#readUncertainty.get(owner) ?? new Set<string>(); retained.add(key); this.#readUncertainty.set(owner, retained); }
    if (receipt.methodEffect !== "read" || (receipt.nativeOutcome as Record<string, unknown> | undefined)?.mutationOutcome !== "unknown" || typeof receipt.capability !== "string" || typeof receipt.method !== "string" || this.#contradictionOwners.has(key)) return;
    const method = JSON.stringify([receipt.capability, receipt.method]), methods = this.#contradictoryReads.get(owner) ?? new Map<string, Set<string>>(), originals = methods.get(method) ?? new Set<string>();
    originals.add(key); methods.set(method, originals); this.#contradictoryReads.set(owner, methods); this.#contradictionOwners.set(key, { owner, method });
  }
  #forgetReadFact(key: string, originalOwner?: string): void {
    const contradiction = this.#contradictionOwners.get(key);
    if (contradiction) { const methods = this.#contradictoryReads.get(contradiction.owner), originals = methods?.get(contradiction.method); originals?.delete(key); if (!originals?.size) methods?.delete(contradiction.method); if (!methods?.size) this.#contradictoryReads.delete(contradiction.owner); this.#contradictionOwners.delete(key); }
    // Every ticket has one logical owner; also handle direct observations that
    // lack a ticket without scanning unrelated plugin histories.
    const owner = contradiction?.owner ?? originalOwner;
    if (owner) { const retained = this.#readUncertainty.get(owner); retained?.delete(key); if (!retained?.size) this.#readUncertainty.delete(owner); }
  }
  observe(observation: OutcomeObservation): Promise<void> {
    if (observation.receipt.uncertaintyObserved !== true) return Promise.resolve();
    const key = outcomeKey(observation.identity, observation.requestId), current = metadata(observation.receipt), signature = semantic(current);
    let entry = this.#pending.get(key);
    const confirmed = this.#hot.get(key);
    if (!entry && confirmed && semantic(confirmed.current) === signature) return Promise.resolve();
    this.#rememberReadFact(key, observation);
    if (!entry) {
      const record: ArchivedOutcome = Object.freeze({ schemaVersion: 1, identity: Object.freeze({ ...observation.identity }), requestId: observation.requestId, firstFailure: confirmed?.firstFailure ?? scalarFields(observation.firstFailure, nativeFields), firstObservation: confirmed?.firstObservation ?? current, current });
      let confirm!: () => void; const complete = new Promise<void>(resolve => { confirm = resolve; });
      entry = { record, semantic: signature, version: 1, writtenVersion: 0, loaded: Boolean(confirmed), confirmed: complete, confirm }; this.#pending.set(key, entry);
      if (!this.#ticketOwners.has(key)) { const owner = pluginKey(observation.identity), records = this.#unreservedPending.get(owner) ?? new Set<string>(); records.add(key); this.#unreservedPending.set(owner, records); }
    } else if (entry.semantic !== signature) {
      entry.record = Object.freeze({ ...entry.record, current }); entry.semantic = signature; entry.version++;
    }
    // A failed archive attempt is not a failed actual resource join. Preserve
    // the same pending completion for an explicit later flush/readback repair.
    void this.#write(key, entry).catch(() => {});
    return entry.confirmed;
  }
  #write(key: string, entry: Entry): Promise<void> {
    if (entry.work) return entry.work;
    const work = Promise.resolve().then(async () => {
      try {
        await this.#loadFirst(key, entry);
        while (entry.writtenVersion < entry.version) {
          let owner = entry.fileOwner;
          if (!owner) {
            const directory = path.join(this.root, key.slice(0, 2));
            await fs.mkdir(directory, { recursive: true });
            const target = path.join(directory, key + ".json"), temporary = target + "." + randomUUID() + ".tmp";
            const file = await (this.options.openFile?.(temporary) ?? fs.open(temporary, "wx", 0o600));
            let closed!: () => void;
            const actualClose = new Promise<void>(resolve => { closed = resolve; });
            owner = { file, temporary, target, version: entry.version, record: entry.record, actualClose, closeObserved: false, payloadReady: false, renamed: false };
            const original = owner;
            // FileHandle is a real EventEmitter; the pinned older Node types omit its emitter methods.
            Reflect.apply(EventEmitter.prototype.once, file, ["close", () => { original.closeObserved = true; closed(); }]);
            // Retain the original handle before the first write or close can fail.
            entry.fileOwner = owner;
            try { await file.writeFile(JSON.stringify(owner.record) + "\n", "utf8"); await file.sync(); owner.payloadReady = true; }
            catch (error) { owner.writeFailure = error; }
          }
          // A failed close keeps this exact handle and slot. A later metadata-only
          // flush retries it; it cannot open a replacement and confirm this owner.
          if (!owner.closeObserved) await owner.file.close();
          await owner.actualClose;
          if (!owner.payloadReady) {
            await fs.unlink(owner.temporary);
            entry.fileOwner = undefined;
            throw owner.writeFailure ?? new Error("Original archive payload did not complete.");
          }
          if (!owner.renamed) { await fs.rename(owner.temporary, owner.target); owner.renamed = true; }
          const readback = JSON.parse(await fs.readFile(owner.target, "utf8")) as ArchivedOutcome;
          if (outcomeKey(readback.identity, readback.requestId) !== key || JSON.stringify(readback) !== JSON.stringify(owner.record)) throw new Error("Original outcome archive readback mismatch.");
          this.#writes++; entry.writtenVersion = owner.version; entry.fileOwner = undefined;
        }
        entry.failure = undefined;
        this.#hot.delete(key); this.#hot.set(key, entry.record);
        while (this.#hot.size > this.#hotLimit) this.#hot.delete(this.#hot.keys().next().value!);
        this.#pending.delete(key);
        const owner = pluginKey(entry.record.identity), unreserved = this.#unreservedPending.get(owner); unreserved?.delete(key); if (!unreserved?.size) this.#unreservedPending.delete(owner);
        if (!this.#ticketOwners.has(key)) this.#forgetReadFact(key);
        entry.confirm();
      } catch (error) { entry.failure = error; throw error; }
      finally { entry.work = undefined; }
    });
    entry.work = work; return work;
  }
  #loadFirst(key: string, entry: Entry): Promise<void> {
    if (entry.loaded) return Promise.resolve();
    if (entry.loading) return entry.loading;
    const loading = Promise.resolve().then(async () => {
      try {
        const filename = path.join(this.root, key.slice(0, 2), key + ".json");
        const previous = JSON.parse(await (this.options.readCold?.(filename) ?? fs.readFile(filename, "utf8"))) as ArchivedOutcome;
        if (outcomeKey(previous.identity, previous.requestId) !== key || outcomeScopeKey(previous.identity) !== outcomeScopeKey(entry.record.identity)) throw new Error("Existing cold outcome owner mismatch.");
        entry.record = Object.freeze({ ...entry.record, firstFailure: previous.firstFailure, firstObservation: previous.firstObservation });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      entry.loaded = true;
    }).finally(() => { entry.loading = undefined; });
    entry.loading = loading; return loading;
  }
  async read(identity: PluginIdentity, requestId: string): Promise<Readonly<{ archive: "confirmed" | "unconfirmed"; record: ArchivedOutcome }> | undefined> {
    const key = outcomeKey(identity, requestId), pending = this.#pending.get(key);
    if (pending) {
      try { await this.#loadFirst(key, pending); }
      catch (error) { throw new OutcomeFirstUnavailableError(Object.freeze({ ...identity }), requestId, structuredClone(pending.record.current), error); }
      return Object.freeze({ archive: this.#pending.has(key) ? "unconfirmed" : "confirmed", record: structuredClone(pending.record) });
    }
    const hot = this.#hot.get(key);
    if (hot) { this.#hot.delete(key); this.#hot.set(key, hot); return Object.freeze({ archive: "confirmed", record: structuredClone(hot) }); }
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.root, key.slice(0, 2), key + ".json"), "utf8")) as ArchivedOutcome;
      if (outcomeScopeKey(record.identity) !== outcomeScopeKey(identity) || record.requestId !== requestId || outcomeKey(record.identity, record.requestId) !== key) throw new Error("Cold outcome does not belong to the original owner.");
      this.#hot.set(key, record); while (this.#hot.size > this.#hotLimit) this.#hot.delete(this.#hot.keys().next().value!);
      return Object.freeze({ archive: "confirmed", record: structuredClone(record) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async flushScope(identity: PluginIdentity): Promise<void> {
    const scope = outcomeScopeKey(identity), entries = [...this.#pending.entries()].filter(([, entry]) => outcomeScopeKey(entry.record.identity) === scope);
    const settled = await Promise.allSettled(entries.map(([key, entry]) => this.#write(key, entry)));
    const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Original unknown outcome archive remains unconfirmed.");
  }
  async joinScope(identity: PluginIdentity): Promise<void> {
    const scope = outcomeScopeKey(identity);
    await Promise.all([...this.#pending.values()].filter(entry => outcomeScopeKey(entry.record.identity) === scope).map(entry => entry.confirmed));
  }
  snapshot() { return Object.freeze({ hot: this.#hot.size, pending: this.#pending.size, failedAttempts: [...this.#pending.values()].filter(entry => entry.failure !== undefined).length, reservations: this.#ticketOwners.size, readReservations: this.#readTickets.size, readUnknown: [...this.#readUncertainty.values()].reduce((count, keys) => count + keys.size, 0), contradictoryMethods: this.#contradictionOwners.size, writes: this.#writes, closing: this.#closing }); }
  async dispose(): Promise<void> {
    this.#closing = true;
    const admitted = [...this.#ticketCompletion.values()].map(ticket => ticket.promise);
    const result = await Promise.allSettled([...this.#pending.entries()].map(([key, entry]) => this.#write(key, entry)));
    const failures = result.flatMap(item => item.status === "rejected" ? [item.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Some original outcome archives did not close.");
    await Promise.all(admitted);
  }
}
