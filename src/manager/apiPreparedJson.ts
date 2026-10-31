import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runPluginSynchronousWork } from "../plugin-kernel/synchronousExecution.js";

// Only this module can bind an encoding to its exact, immutable data object.
// The registry still validates that original object before disclosing its bytes.
const encodedBodies = new WeakMap<object, string>();
const immutableData = new WeakSet<object>();

type JsonCopy = { source: object; copy: object; parents: Set<JsonCopy>; deeplyFrozen: boolean };

async function processSnapshotBatches(hasWork: () => boolean, step: () => void, label: string, signal?: AbortSignal) {
  while (hasWork()) {
    await yieldToEventLoop(undefined, { signal });
    runPluginSynchronousWork(() => {
      const started = performance.now();
      for (let count = 0; count < 1024 && hasWork(); count++) {
        signal?.throwIfAborted();
        step();
        if (performance.now() - started >= 8) break;
      }
    }, label);
  }
}

async function snapshotJsonData(root: object, signal?: AbortSignal) {
  const copies = new Map<object, JsonCopy>();
  const pending: JsonCopy[] = [];
  const capture = (value: unknown, parent?: JsonCopy): unknown => {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new TypeError("Prepared API JSON requires plain JSON data.");
    if (immutableData.has(value)) return value;
    let record = copies.get(value);
    if (!record) {
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Prepared API JSON requires plain JSON records.");
      record = { source: value, copy: Array.isArray(value) ? new Array(value.length) : Object.create(prototype), parents: new Set(), deeplyFrozen: Object.isFrozen(value) };
      copies.set(value, record); pending.push(record);
    }
    if (parent) record.parents.add(parent);
    return record.copy;
  };
  const result = runPluginSynchronousWork(() => capture(root) as object, "capture API JSON root");
  await processSnapshotBatches(() => pending.length > 0, () => {
    const record = pending.pop()!;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record.source))) {
      if (!Object.hasOwn(descriptor, "value") || key === "toJSON" && typeof descriptor.value === "function") throw new TypeError("Prepared API JSON cannot contain accessors or custom serialization.");
      if (descriptor.enumerable) Object.defineProperty(record.copy, key, { value: capture(descriptor.value, record), enumerable: true, configurable: true, writable: true });
    }
  }, "capture API JSON data batch", signal);
  const records = runPluginSynchronousWork(() => [...copies.values()], "snapshot API JSON node list");
  const mutable = runPluginSynchronousWork(() => records.filter(record => !record.deeplyFrozen), "find mutable API JSON data");
  // A frozen outer object is not enough: propagate every mutable descendant to
  // its parents before allowing an upstream reference to be reused later.
  await processSnapshotBatches(() => mutable.length > 0, () => {
    for (const parent of mutable.pop()!.parents) {
      if (parent.deeplyFrozen) { parent.deeplyFrozen = false; mutable.push(parent); }
    }
  }, "classify immutable API JSON data", signal);
  let offset = 0;
  await processSnapshotBatches(() => offset < records.length, () => {
    Object.freeze(records[offset++]!.copy);
  }, "freeze owned API JSON data", signal);
  // Only owned copies are frozen. Mutable external owner data is never changed.
  offset = 0;
  await processSnapshotBatches(() => offset < records.length, () => {
    const record = records[offset++]!;
    immutableData.add(record.copy); if (record.deeplyFrozen) immutableData.add(record.source);
  }, "remember immutable API JSON data", signal);
  return { body: result, container: (value: object) => copies.get(value)?.copy ?? value };
}

/** Prepare a large generated JSON document without repeating one monolithic stringify.
 * The selected container is an array of operations or an object of OpenAPI paths.
 * Batches of at most 256 items retain the ordinary 100ms synchronous guard.
 * Each batch also yields after eight milliseconds of cooperative work.
 * No public response schema, transport, permission or deadline is changed. */
export async function prepareApiJsonBody<T extends object>(body: T, container: readonly unknown[] | Readonly<Record<string, unknown>>, signal?: AbortSignal,
  additionalContainers: readonly (readonly unknown[] | Readonly<Record<string, unknown>>)[] = []): Promise<T> {
  const snapshot = await snapshotJsonData(body, signal);
  body = snapshot.body as T;
  const documents = new Map<object, { marker: string; encoded: string; references: number }>();
  for (const original of [container, ...additionalContainers]) {
    const current = snapshot.container(original) as typeof container;
    if (documents.has(current)) continue;
    signal?.throwIfAborted();
    const array = Array.isArray(current);
    const keys = array ? undefined : runPluginSynchronousWork(() => Object.keys(current), "read API JSON keys");
    const length = array ? (current as readonly unknown[]).length : keys!.length;
    const fragments: string[] = [];
    let index = 0;
    while (index < length) {
      await yieldToEventLoop(undefined, { signal });
      runPluginSynchronousWork(() => {
        const started = performance.now();
        for (let count = 0; count < 256 && index < length; count++) {
          signal?.throwIfAborted();
          const key = array ? index : keys![index]!;
          index++;
          const value = JSON.stringify((current as Record<string | number, unknown>)[key]);
          if (array) fragments.push(value ?? "null");
          else if (value !== undefined) fragments.push(`${JSON.stringify(key)}:${value}`);
          if (performance.now() - started >= 8) break;
        }
      }, "serialize API JSON item batch");
    }
    const encoded = runPluginSynchronousWork(() => `${array ? "[" : "{"}${fragments.join(",")}${array ? "]" : "}"}`, "assemble API JSON items");
    documents.set(current, { marker: `rabi-json-${randomUUID()}`, encoded, references: 0 });
  }
  await yieldToEventLoop(undefined, { signal });
  let encoded = runPluginSynchronousWork(() => JSON.stringify(body, (_key, value) => {
    const document = documents.get(value);
    if (document) { document.references++; return document.marker; }
    return value;
  }), "serialize API JSON envelope");
  for (const document of documents.values()) {
    await yieldToEventLoop(undefined, { signal });
    encoded = runPluginSynchronousWork(() => {
      const pieces = encoded.split(JSON.stringify(document.marker));
      if (!document.references || pieces.length !== document.references + 1) throw new TypeError("Prepared API JSON container must belong to its response.");
      return pieces.join(document.encoded);
    }, "assemble API JSON response");
  }
  signal?.throwIfAborted();
  encodedBodies.set(body, encoded);
  return body;
}

/** A cache miss always uses the registry's original guarded serializer. */
export function preparedApiJson(body: unknown): string | undefined {
  return body !== null && typeof body === "object" ? encodedBodies.get(body) : undefined;
}
