import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import {
  GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX, gatewayRouteSnapshotIdentityMatches, gatewayRouteSnapshotRevision,
  immutableGatewayRouteSnapshot, parseGatewayRouteSnapshotAck, validGatewayRouteRevision,
  type GatewayRouteSnapshotAck, type GatewayRouteSnapshotCommand, type GatewayRouteSnapshotIdentity,
  type GatewayRouteSnapshotOperation
} from "../shared/gatewayRouteSnapshot.js";

export class GatewayRouteSnapshotUncertain extends Error {
  readonly code = "gateway_route_snapshot_uncertain";
  constructor(readonly operation: GatewayRouteSnapshotOperation) {
    super(`Gateway Route update ${operation.operationId} is unconfirmed; inspect the original operation before another update.`);
  }
}

/** Uses only the original supervised child's existing pipes. A write callback is never an application acknowledgement. */
export function createGatewayRouteSnapshotSupervisor(options: Readonly<{
  child: ChildProcess;
  identity: GatewayRouteSnapshotIdentity;
  initialRevision: string;
  initialDefinition?: Readonly<GatewayDefinition>;
  timeoutMs: number | (() => number);
}>) {
  const { child } = options;
  const identity = Object.freeze({ ...options.identity });
  if (!child.stdin || !child.stdout || child.pid !== identity.pid || !validGatewayRouteRevision(options.initialRevision)) throw new Error("Route snapshot control requires the exact live Gateway child and boot revision.");
  if (options.initialDefinition && gatewayRouteSnapshotRevision(options.initialDefinition) !== options.initialRevision) throw new Error("Gateway boot definition does not match its original revision.");
  let appliedRevision = options.initialRevision;
  let appliedDefinition = options.initialDefinition ? immutableGatewayRouteSnapshot(options.initialDefinition) : undefined;
  let submittedDefinition: Readonly<GatewayDefinition> | undefined;
  let sequence = 0;
  let closed = false;
  let operation: GatewayRouteSnapshotOperation | undefined;
  let acknowledgement: GatewayRouteSnapshotAck | undefined;
  let waiting: { resolve(ack: GatewayRouteSnapshotAck): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  const uncertain = () => new GatewayRouteSnapshotUncertain(operation!);
  const clear = () => { if (waiting) clearTimeout(waiting.timer); const previous = waiting; waiting = undefined; return previous; };
  const fail = () => { const pending = clear(); if (pending && operation) pending.reject(uncertain()); };
  const currentChild = () => !closed && child.pid === identity.pid && child.exitCode === null && child.signalCode === null;
  function accept(line: string) {
    const ack = parseGatewayRouteSnapshotAck(line);
    if (!ack || !currentChild() || !operation || !gatewayRouteSnapshotIdentityMatches(ack, identity)
      || ack.operationId !== operation.operationId || ack.sequence !== operation.sequence
      || ack.baseRevision !== operation.baseRevision || ack.revision !== operation.revision) return;
    acknowledgement = ack;
    if (ack.state === "applied") {
      appliedRevision = ack.appliedRevision;
      if (submittedDefinition) appliedDefinition = submittedDefinition;
      submittedDefinition = undefined;
    } else if (ack.state === "rejected") submittedDefinition = undefined;
    clear()?.resolve(ack);
  }
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const data = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) { accept(buffer.slice(0, newline).replace(/\r$/, "")); buffer = buffer.slice(newline + 1); }
  };
  function send(command: GatewayRouteSnapshotCommand): Promise<GatewayRouteSnapshotAck> {
    if (!currentChild()) return Promise.reject(uncertain());
    if (waiting) return Promise.reject(new Error("The original Gateway Route request is still awaiting acknowledgement."));
    return new Promise((resolve, reject) => {
      const timeoutMs = typeof options.timeoutMs === "function" ? options.timeoutMs() : options.timeoutMs;
      const timer = setTimeout(fail, timeoutMs);
      waiting = { resolve, reject, timer };
      try { child.stdin!.write(GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX + JSON.stringify(command) + "\n", error => { if (error) fail(); }); }
      catch { fail(); }
    });
  }
  const detached = () => { if (closed) return; closed = true; fail(); child.stdout?.off("data", data); child.stdout?.off("end", detached); child.stdout?.off("close", detached); child.stdin?.off("error", fail); child.off("exit", detached); child.off("error", detached); };
  child.stdout.on("data", data); child.stdout.once("end", detached); child.stdout.once("close", detached);
  child.stdin.on("error", fail); child.once("exit", detached); child.once("error", detached);
  return Object.freeze({
    apply(definition: Readonly<GatewayDefinition>, operationId: string = randomUUID()): Promise<GatewayRouteSnapshotAck> {
      if (operation && (!acknowledgement || !["applied", "rejected"].includes(acknowledgement.state))) return Promise.reject(uncertain());
      const snapshot = immutableGatewayRouteSnapshot(definition);
      if (snapshot.id !== identity.gatewayId) return Promise.reject(new Error("Gateway Route snapshot belongs to another Route."));
      operation = Object.freeze({ ...identity, schemaVersion: 1, operationId, sequence: ++sequence, baseRevision: appliedRevision, revision: gatewayRouteSnapshotRevision(snapshot) });
      submittedDefinition = snapshot;
      acknowledgement = undefined;
      return send({ ...operation, kind: "apply", definition: snapshot });
    },
    inspect(): Promise<GatewayRouteSnapshotAck> {
      if (!operation) return Promise.reject(new Error("No Gateway Route update has been submitted."));
      if (acknowledgement && ["applied", "rejected"].includes(acknowledgement.state)) return Promise.resolve(acknowledgement);
      return send({ ...operation, kind: "status" });
    },
    current: () => ({ appliedRevision, appliedDefinition, operation, acknowledgement,
      state: acknowledgement?.state ?? (operation ? waiting ? "pending" : "uncertain" : "idle") }),
    dispose: detached
  });
}
