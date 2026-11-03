import { createHash } from "node:crypto";
import type { GatewayDefinition } from "./gatewayConfigModel.js";
import type { GatewayListenerIdentity } from "../runtime/gatewayListenerRuntime.js";

export const GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX = "RABIROUTE_ROUTE_SNAPSHOT ";
export const GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX = "RABIROUTE_ROUTE_SNAPSHOT_ACK ";

export type GatewayRouteSnapshotIdentity = GatewayListenerIdentity;
export type GatewayRouteSnapshotOperation = GatewayRouteSnapshotIdentity & Readonly<{
  schemaVersion: 1;
  operationId: string;
  sequence: number;
  baseRevision: string;
  revision: string;
}>;
export type GatewayRouteSnapshotCommand = GatewayRouteSnapshotOperation & (
  Readonly<{ kind: "apply"; definition: Readonly<GatewayDefinition> }>
  | Readonly<{ kind: "status" }>
);
export type GatewayRouteSnapshotAck = GatewayRouteSnapshotOperation & Readonly<{
  kind: "ack";
  state: "pending" | "applied" | "rejected" | "uncertain" | "unknown";
  appliedRevision: string;
  unavailableInstances?: readonly string[];
  code?: "snapshot_invalid" | "revision_mismatch" | "operation_busy" | "sequence_stale" | "apply_failed" | "apply_rejected" | "operation_unknown";
}>;

/** Native owners may use this only when they can prove the original owner and its effects were unchanged. */
export class GatewayRouteSnapshotApplyRejected extends Error {
  readonly code = "gateway_route_snapshot_rejected";
  readonly outcome = "not_started";
}

const states = new Set(["pending", "applied", "rejected", "uncertain", "unknown"]);
const codes = new Set(["snapshot_invalid", "revision_mismatch", "operation_busy", "sequence_stale", "apply_failed", "apply_rejected", "operation_unknown"]);
export const validGatewayRouteRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value); }
function operation(value: unknown): value is GatewayRouteSnapshotOperation {
  return record(value) && value.schemaVersion === 1 && text(value.gatewayId) && text(value.gatewayGenerationId)
    && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && text(value.operationId)
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && validGatewayRouteRevision(value.baseRevision) && validGatewayRouteRevision(value.revision);
}
function metadata(value: GatewayRouteSnapshotOperation): GatewayRouteSnapshotOperation {
  return { schemaVersion: 1, gatewayId: value.gatewayId, gatewayGenerationId: value.gatewayGenerationId, pid: value.pid,
    operationId: value.operationId, sequence: value.sequence, baseRevision: value.baseRevision, revision: value.revision };
}
function parse(line: string, prefix: string): unknown {
  if (!line.startsWith(prefix)) return undefined;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return undefined; }
}
export function parseGatewayRouteSnapshotCommand(line: string): GatewayRouteSnapshotCommand | undefined {
  const value = parse(line, GATEWAY_ROUTE_SNAPSHOT_REQUEST_PREFIX);
  if (!operation(value)) return undefined;
  const command = value as unknown as Record<string, unknown>;
  if (command.kind === "status") return Object.freeze({ ...metadata(value), kind: "status" });
  return command.kind === "apply" && record(command.definition)
    ? Object.freeze({ ...metadata(value), kind: "apply", definition: command.definition as GatewayDefinition }) : undefined;
}
export function parseGatewayRouteSnapshotAck(line: string): GatewayRouteSnapshotAck | undefined {
  const value = parse(line, GATEWAY_ROUTE_SNAPSHOT_ACK_PREFIX);
  if (!operation(value)) return undefined;
  const ack = value as unknown as Record<string, unknown>;
  if (ack.kind !== "ack" || !states.has(String(ack.state)) || !validGatewayRouteRevision(ack.appliedRevision)
    || (ack.unavailableInstances !== undefined && (!Array.isArray(ack.unavailableInstances) || !ack.unavailableInstances.every(text)))
    || (ack.code !== undefined && !codes.has(String(ack.code)))) return undefined;
  if (ack.state === "applied" && ack.appliedRevision !== value.revision) return undefined;
  return Object.freeze({ ...metadata(value), kind: "ack", state: ack.state as GatewayRouteSnapshotAck["state"],
    appliedRevision: ack.appliedRevision, ...(ack.code ? { code: ack.code as GatewayRouteSnapshotAck["code"] } : {}),
    ...(ack.unavailableInstances ? { unavailableInstances: Object.freeze([...(ack.unavailableInstances as string[])]) } : {}) });
}
export function gatewayRouteSnapshotIdentityMatches(left: GatewayRouteSnapshotIdentity, right: GatewayRouteSnapshotIdentity): boolean {
  return left.gatewayId === right.gatewayId && left.gatewayGenerationId === right.gatewayGenerationId && left.pid === right.pid;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function gatewayRouteSnapshotRevision(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}
/** The wire owns a JSON snapshot; neither a caller's draft nor a native owner's configuration can mutate it. */
export function immutableGatewayRouteSnapshot(definition: Readonly<GatewayDefinition>): Readonly<GatewayDefinition> {
  const snapshot = JSON.parse(JSON.stringify(definition)) as GatewayDefinition;
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  };
  freeze(snapshot);
  return snapshot;
}
