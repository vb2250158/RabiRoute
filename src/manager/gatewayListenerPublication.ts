import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { currentPluginActivation, runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import { GATEWAY_LISTENER_PUBLICATION_PREFIX, type GatewayListenerIdentity, type GatewayListenerPublication } from "../runtime/gatewayListenerRuntime.js";
import type { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

const MAX_PUBLICATION_LINE_BYTES = 4 * 1024 * 1024;

/** Connects only the exact child already started by the existing Gateway supervisor. */
export function createGatewayListenerPublicationHost(registry: ManagerPluginRouteRegistry) {
  type Entry = { child: ChildProcess; identity: GatewayListenerIdentity; publication?: GatewayListenerPublication; invalid: boolean;
    current(): boolean; detach(): void };
  type Projection = { active: boolean; activation: NonNullable<ReturnType<typeof currentPluginActivation>>; sources: Map<Entry, () => void> };
  const attached = new Map<string, Entry>(), projections = new Set<Projection>();
  let stopped = false;
  const changed = () => registry.refreshPublication();
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
        entry.publication = value; revision = value.revision; entry.invalid = false; changed();
      } catch { entry.publication = undefined; entry.invalid = true; changed(); }
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
        if (pendingBytes > MAX_PUBLICATION_LINE_BYTES) { pending = ""; pendingBytes = 0; discarding = true; entry.publication = undefined; entry.invalid = true; changed(); }
      }
    };
    const pipeClosed = () => {
      if (!processCurrent()) return;
      // A live process with a lost supervisor pipe can no longer prove its listener state.
      entry.publication = undefined; entry.invalid = true; changed();
    };
    const detach = () => {
      if (!active) return; active = false;
      child.stdout?.off("data", data); child.stdout?.off("end", pipeClosed); child.stdout?.off("close", pipeClosed);
      child.off("exit", detach); child.off("error", detach);
      for (const projection of projections) { projection.sources.get(entry)?.(); projection.sources.delete(entry); }
      if (attached.get(identity.gatewayId) === entry) attached.delete(identity.gatewayId);
      changed();
    };
    const entry: Entry = { child, identity: expected, current: processCurrent, invalid: false, detach };
    attached.set(identity.gatewayId, entry);
    try { for (const projection of projections) projectEntry(projection, entry); }
    catch (error) { detach(); throw error; }
    child.stdout.on("data", data); child.stdout.once("end", pipeClosed); child.stdout.once("close", pipeClosed);
    child.once("exit", detach); child.once("error", detach);
    return detach;
  }
  return Object.freeze({ attach,
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
      for (const entry of [...attached.values()]) entry.detach();
      for (const projection of projections) { projection.active = false; for (const unregister of projection.sources.values()) unregister(); }
      projections.clear(); changed();
    }
  });
}
