import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { GatewayListenerDescriptor, GatewayListenerAccess } from "@rabiroute/plugin-sdk";
import { StringDecoder } from "node:string_decoder";
import { currentPluginActivation, runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import { GATEWAY_LISTENER_PUBLICATION_PREFIX, gatewayListenerOperationId, type GatewayListenerIdentity, type GatewayListenerPublication } from "../runtime/gatewayListenerRuntime.js";
import type { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import type { ApiExternalListenerBinding, ApiExternalListenerPublication } from "./apiExternalListenerBinding.js";

const MAX_PUBLICATION_LINE_BYTES = 4 * 1024 * 1024;

/** Connects only the exact child already started by the existing Gateway supervisor. */
export function createGatewayListenerPublicationHost(registry: ManagerPluginRouteRegistry) {
  type Entry = { child: ChildProcess; identity: GatewayListenerIdentity; publication?: GatewayListenerPublication; invalid: boolean;
    listenersById: Map<string, ApiExternalListenerPublication>;
    current(): boolean; detach(): void };
  type Projection = { active: boolean; activation: NonNullable<ReturnType<typeof currentPluginActivation>>; sources: Map<Entry, () => void> };
  const attached = new Map<string, Entry>(), projections = new Set<Projection>();
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  // Derived only from the formal registry at the existing native/activation publication boundary.
  let publishedListenerCache = new Map<string, { binding: ApiExternalListenerBinding; signature: string }>();
  const listenerKey = (listenerId: string, leaseId: string) => JSON.stringify([listenerId, leaseId]);
  let stopped = false;
  const changed = () => {
    const snapshot = registry.refreshPublication();
    publishedListenerCache = new Map(snapshot.listeners.map(value => [listenerKey(value.binding.listenerId, value.binding.leaseId),
      { binding: value.binding, signature: JSON.stringify(value.binding) }]));
    changes.emit("changed");
  };
  function readListener(gatewayId: string, localName: string): GatewayListenerDescriptor | undefined {
    if (stopped) throw new Error("Gateway listener publication host is closed.");
    const entry = attached.get(gatewayId);
    if (!entry?.current() || entry.invalid) return undefined;
    const listenerId = gatewayListenerOperationId(gatewayId, localName);
    const original = entry.listenersById.get(listenerId);
    if (!original) return undefined;
    // The verified child cache alone is not a published Manager capability.
    const published = publishedListenerCache.get(listenerKey(listenerId, original.binding.leaseId));
    if (!published) return undefined;
    const binding = structuredClone(published.binding);
    const signature = JSON.stringify(binding);
    const assertCurrent = () => {
      const current = attached.get(gatewayId);
      const native = current?.listenersById.get(listenerId);
      const projected = publishedListenerCache.get(listenerKey(listenerId, binding.leaseId));
      if (stopped || current !== entry || !entry.current() || entry.invalid || !native || !projected
        || JSON.stringify(native.binding) !== signature || projected.signature !== signature) {
        throw new Error("The original Gateway listener is no longer current.");
      }
    };
    assertCurrent();
    return Object.freeze({ gatewayId, gatewayGenerationId: entry.identity.gatewayGenerationId, pid: entry.identity.pid,
      listenerId, leaseId: binding.leaseId, protocol: binding.protocol, address: Object.freeze({ ...binding.address }), assertCurrent });
  }
  const waitForListener: GatewayListenerAccess["waitForListener"] = (gatewayId, localName, options) => {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)
      return Promise.reject(new Error("Gateway listener wait requires a bounded timeout."));
    return new Promise((resolve, reject) => {
      let expected = attached.get(gatewayId), settled = false;
      const finish = (error?: unknown, value?: GatewayListenerDescriptor) => {
        if (settled) return; settled = true;
        clearTimeout(timer); changes.off("changed", check); options.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(options.signal.reason ?? new Error("Gateway listener wait was cancelled."));
      const check = () => {
        try {
          options.signal.throwIfAborted();
          const current = attached.get(gatewayId);
          if (expected && current !== expected) throw new Error("Gateway generation changed while waiting for its listener.");
          expected ??= current;
          const listener = readListener(gatewayId, localName);
          if (listener) finish(undefined, listener);
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error("The current Gateway listener did not become ready in time.")), options.timeoutMs);
      changes.on("changed", check); options.signal.addEventListener("abort", abort, { once: true }); check();
    });
  };
  const projectEntry = (projection: Projection, entry: Entry) => {
    const register = () => registry.registerExternalListenerSource(`gateway:${entry.identity.gatewayId}`, {
      isCurrent: () => projection.active && entry.current() && (entry.publication !== undefined || entry.invalid),
      read: () => {
        if (entry.invalid) throw new Error("Managed Gateway listener publication is invalid.");
        return entry.publication?.listeners ?? [];
      }
    });
    projection.sources.set(entry, runPluginActivation(projection.activation, register));
  };
  function attach(child: ChildProcess, identity: Omit<GatewayListenerIdentity, "pid">): () => void {
    if (stopped || !child.pid || !child.stdout || child.stdout.destroyed || child.stdout.readableEnded || child.exitCode !== null || child.signalCode !== null
      || !identity.gatewayId || !identity.gatewayGenerationId) throw new Error("Listener publication requires a live managed Gateway stdout pipe and generation.");
    const previous = attached.get(identity.gatewayId);
    if (previous?.child === child) {
      if (previous.identity.gatewayGenerationId !== identity.gatewayGenerationId || previous.identity.pid !== child.pid) {
        throw new Error("An attached Gateway process cannot change its captured identity.");
      }
      // Supervisor reconciliation may observe the same original child again; never reset its decoder/cache.
      return previous.detach;
    }
    if ([...attached.values()].some(entry => entry.child === child)) throw new Error("A managed Gateway process already has its captured owner.");
    attached.get(identity.gatewayId)?.detach();
    const expected = { ...identity, pid: child.pid };
    let active = true, revision = 0;
    const processCurrent = () => active && child.pid === expected.pid && child.exitCode === null && child.signalCode === null;
    const decoder = new StringDecoder("utf8"); let pending = "", pendingBytes = 0, discarding = false;
    const accept = (line: string) => {
      if (!processCurrent() || !line.startsWith(GATEWAY_LISTENER_PUBLICATION_PREFIX)) return;
      try {
        const value = JSON.parse(line.slice(GATEWAY_LISTENER_PUBLICATION_PREFIX.length)) as GatewayListenerPublication;
        // A line from another generation cannot retire or replace this child's current publication.
        if (value.gatewayId !== expected.gatewayId || value.gatewayGenerationId !== expected.gatewayGenerationId || value.pid !== expected.pid) return;
        if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.listeners)) throw new Error("Invalid native listener publication envelope.");
        if (value.revision <= revision) return;
        const indexed = new Map<string, ApiExternalListenerPublication>(), duplicates = new Set<string>();
        for (const listener of value.listeners) {
          const id = listener?.binding?.listenerId;
          if (listener?.active !== true || typeof id !== "string" || !Array.isArray(listener.operations) || !listener.operations.length) continue;
          if (indexed.has(id)) { indexed.delete(id); duplicates.add(id); }
          else if (!duplicates.has(id)) indexed.set(id, listener);
        }
        entry.publication = value; entry.listenersById = indexed; revision = value.revision; entry.invalid = false; changed();
      } catch { entry.publication = undefined; entry.listenersById.clear(); entry.invalid = true; changed(); }
    };
    const data = (bytes: Buffer) => {
      for (const character of decoder.write(bytes)) {
        if (character === "\n") {
          if (!discarding) accept(pending.replace(/\r$/, "")); pending = ""; pendingBytes = 0; discarding = false; continue;
        }
        if (discarding) continue;
        pending += character;
        const point = character.codePointAt(0)!; pendingBytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (pending.length <= GATEWAY_LISTENER_PUBLICATION_PREFIX.length && !GATEWAY_LISTENER_PUBLICATION_PREFIX.startsWith(pending)) { pending = ""; discarding = true; }
        if (pendingBytes > MAX_PUBLICATION_LINE_BYTES) { pending = ""; pendingBytes = 0; discarding = true; entry.publication = undefined; entry.listenersById.clear(); entry.invalid = true; changed(); }
      }
    };
    const pipeClosed = () => {
      if (!processCurrent()) return;
      // A live process with a lost supervisor pipe can no longer prove its listener state.
      entry.publication = undefined; entry.listenersById.clear(); entry.invalid = true; changed();
    };
    const detach = () => {
      if (!active) return; active = false;
      child.stdout?.off("data", data); child.stdout?.off("end", pipeClosed); child.stdout?.off("close", pipeClosed);
      child.off("exit", detach); child.off("error", detach);
      for (const projection of projections) { projection.sources.get(entry)?.(); projection.sources.delete(entry); }
      if (attached.get(identity.gatewayId) === entry) attached.delete(identity.gatewayId);
      changed();
    };
    const entry: Entry = { child, identity: expected, current: processCurrent, invalid: false, listenersById: new Map(), detach };
    attached.set(identity.gatewayId, entry);
    try { for (const projection of projections) projectEntry(projection, entry); }
    catch (error) { detach(); throw error; }
    child.stdout.on("data", data); child.stdout.once("end", pipeClosed); child.stdout.once("close", pipeClosed);
    child.once("exit", detach); child.once("error", detach);
    changed(); // Pending consumers capture this original child even before its first publication.
    return detach;
  }
  return Object.freeze({ attach, readListener, waitForListener, refresh: changed,
    /** Activation-owned projection over the one Manager-lifetime parser/cache. Never replays or restarts a child. */
    project() {
      if (stopped) throw new Error("Gateway publication host is closed.");
      const activation = currentPluginActivation();
      if (!activation) throw new Error("Gateway listener projection requires the actual plugin activation.");
      const projection: Projection = { active: true, activation, sources: new Map() };
      const dispose = () => {
        if (!projection.active) return; projection.active = false;
        for (const unregister of projection.sources.values()) unregister(); projection.sources.clear(); projections.delete(projection); changed();
      };
      try { for (const entry of attached.values()) projectEntry(projection, entry); projections.add(projection); }
      catch (error) { dispose(); throw error; }
      changed(); return Object.freeze({ dispose });
    },
    dispose() {
      if (stopped) return; stopped = true;
      publishedListenerCache.clear();
      changes.emit("changed");
      for (const entry of [...attached.values()]) entry.detach();
      for (const projection of projections) { projection.active = false; for (const unregister of projection.sources.values()) unregister(); }
      projections.clear(); changed();
    }
  });
}
