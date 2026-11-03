import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import {
  GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX, GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX,
  GatewayRouteSnapshotApplyRejected,
  gatewayRouteSnapshotIdentityMatches, gatewayRouteSnapshotRevision, immutableGatewayRouteSnapshot,
  parseGatewayRouteSnapshotCommand, validGatewayRouteRevision,
  type GatewayRouteSnapshotAck, type GatewayRouteSnapshotCommand, type GatewayRouteSnapshotIdentity,
  type GatewayRouteSnapshotOperation
} from "../shared/gatewayRouteSnapshot.js";
import type { RabiCordisHost } from "./cordisHost.js";

type Options = Readonly<{
  identity: GatewayRouteSnapshotIdentity;
  initialRevision: string;
  /** Resolves only after the native generation and predecessor retirement have completed. */
  applySnapshot(definition: Readonly<GatewayDefinition>, revision: string): Promise<void>;
  publish(ack: GatewayRouteSnapshotAck): void;
  unavailableInstances?(): readonly string[];
}>;

/** One resident Gateway remembers only its current revision and original last operation, never a second candidate configuration. */
export function createGatewayRouteSnapshotReceiver(options: Options) {
  if (!validGatewayRouteRevision(options.initialRevision)) throw new Error("Gateway Route snapshot requires its boot revision.");
  let revision = options.initialRevision;
  let last: GatewayRouteSnapshotAck | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  const identity = Object.freeze({ ...options.identity });
  const metadata = (command: GatewayRouteSnapshotOperation): GatewayRouteSnapshotOperation => ({
    ...identity, schemaVersion: 1, operationId: command.operationId, sequence: command.sequence,
    baseRevision: command.baseRevision, revision: command.revision
  });
  function publish(ack: GatewayRouteSnapshotAck) {
    if (disposed) return;
    try { options.publish(ack); }
    catch { /* A lost response cannot roll back or erase an accepted native operation. */ }
  }
  function reply(command: GatewayRouteSnapshotOperation, state: GatewayRouteSnapshotAck["state"], code?: GatewayRouteSnapshotAck["code"], remember = false) {
    const unavailableInstances = options.unavailableInstances?.() ?? [];
    const ack: GatewayRouteSnapshotAck = Object.freeze({ ...metadata(command), kind: "ack", state, appliedRevision: revision, ...(code ? { code } : {}),
      ...(unavailableInstances.length ? { unavailableInstances: Object.freeze([...new Set(unavailableInstances)]) } : {}) });
    if (remember) last = ack;
    publish(ack);
    return ack;
  }
  function receive(command: GatewayRouteSnapshotCommand): void {
    if (disposed || !gatewayRouteSnapshotIdentityMatches(command, identity)) return;
    if (last?.operationId === command.operationId) {
      if (last.sequence !== command.sequence || last.revision !== command.revision || last.baseRevision !== command.baseRevision) {
        reply(command, "rejected", "snapshot_invalid"); return;
      }
      publish(last);
      return;
    }
    if (command.kind === "status") { reply(command, "unknown", "operation_unknown"); return; }
    if (last?.state === "pending" || last?.state === "uncertain") { reply(command, "rejected", "operation_busy"); return; }
    if (last && command.sequence <= last.sequence) { reply(command, "rejected", "sequence_stale"); return; }
    if (command.baseRevision !== revision) { reply(command, "rejected", "revision_mismatch", true); return; }
    const snapshot = immutableGatewayRouteSnapshot(command.definition);
    if (snapshot.id !== identity.gatewayId || gatewayRouteSnapshotRevision(snapshot) !== command.revision) {
      reply(command, "rejected", "snapshot_invalid", true); return;
    }
    // Admission precedes the callback. A thrown callback is an uncertain accepted operation,
    // not evidence that nothing was published or that retrying it would be safe.
    last = Object.freeze({ ...metadata(command), kind: "ack", state: "pending", appliedRevision: revision });
    pending = Promise.resolve().then(() => options.applySnapshot(snapshot, command.revision)).then(() => {
      revision = command.revision;
      reply(command, "applied", undefined, true);
    }, error => {
      if (error instanceof GatewayRouteSnapshotApplyRejected) reply(command, "rejected", "apply_rejected", true);
      else reply(command, "uncertain", "apply_failed", true);
    });
  }
  return Object.freeze({ receive,
    current: () => ({ revision, operation: last }),
    async dispose() { disposed = true; await pending; }
  });
}

export function bindGatewayRouteSnapshotReceiver(options: Omit<Options, "publish"> & Readonly<{ input: Readable; output: Writable }>) {
  const receiver = createGatewayRouteSnapshotReceiver({ ...options, publish: ack => {
    if (!options.output.destroyed) options.output.write(GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX + JSON.stringify(ack) + "\n");
  } });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const data = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
      if (!line.startsWith(GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX)) continue;
      const command = parseGatewayRouteSnapshotCommand(line);
      if (command) receiver.receive(command);
    }
  };
  options.input.on("data", data);
  return Object.freeze({ current: receiver.current,
    async dispose() { options.input.off("data", data); await receiver.dispose(); }
  });
}

/** Mounted after native endpoints: disposal closes command admission and joins an accepted transition before the root releases native owners. */
export async function mountGatewayRouteSnapshotRuntime(host: RabiCordisHost, options: Omit<Options, "publish"> & Readonly<{ input: Readable; output: Writable }>) {
  const fiber = await host.mount({ name: "rabi:gateway-route-snapshot", apply(context) {
    context.effect(() => { const receiver = bindGatewayRouteSnapshotReceiver(options); return () => receiver.dispose(); }, "receive Manager Route snapshots");
  } });
  return { unmount: () => fiber.dispose() };
}
