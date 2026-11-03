import type { ChildProcess } from "node:child_process";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { gatewayRouteSnapshotRevision, type GatewayRouteSnapshotIdentity } from "../shared/gatewayRouteSnapshot.js";
import { classifyRouteChange, type EndpointRouteConfigDeclaration } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
import { createGatewayRouteSnapshotSupervisor } from "./gatewayRouteSnapshotSupervisor.js";

type Supervisor = ReturnType<typeof createGatewayRouteSnapshotSupervisor>;
export type RouteActivationState = "applied" | "requested" | "rejected" | "uncertain";
export type GatewayRouteActivationReceipt = Readonly<{
  gatewayId: string;
  revision: string;
  state: RouteActivationState;
  operationId: string;
  gatewayGenerationId?: string;
  pid?: number;
  code?: string;
  blockedByOperationId?: string;
  unavailableInstances?: readonly string[];
}>;
export type RouteCatalogActivationReceipt = Readonly<{
  operationId: string;
  state: RouteActivationState;
  gateways: readonly GatewayRouteActivationReceipt[];
}>;
export type GatewayRouteActivationRuntime = {
  definition: GatewayDefinition;
  process: ChildProcess | null;
  needsRestart: boolean;
  readiness: string;
};

/** Application receipts only. Native candidate configuration remains exclusively in the endpoint package owner. */
export function createGatewayRouteActivationOwner(options: Readonly<{
  declarations(): Promise<readonly EndpointRouteConfigDeclaration[]>;
  timeoutMs: number | (() => number);
}>) {
  const children = new WeakMap<ChildProcess, Supervisor>();
  const receipts = new Map<string, Map<string, GatewayRouteActivationReceipt>>();
  function record(operationId: string, receipt: GatewayRouteActivationReceipt) {
    let items = receipts.get(operationId);
    if (!items) receipts.set(operationId, items = new Map());
    items.set(receipt.gatewayId, Object.freeze(receipt));
  }
  function summarize(operationId: string, items: Iterable<GatewayRouteActivationReceipt>): RouteCatalogActivationReceipt {
    const gateways = Object.freeze([...items]);
    const state = (["uncertain", "rejected", "requested", "applied"] as const).find(state => gateways.some(item => item.state === state)) ?? "applied";
    return Object.freeze({ operationId, state, gateways });
  }
  function receipt(operationId: string): RouteCatalogActivationReceipt | undefined {
    const items = receipts.get(operationId);
    return items ? summarize(operationId, items.values()) : undefined;
  }
  function appliedFromAck(operationId: string, definition: Readonly<GatewayDefinition>, supervisor: Supervisor, originalRevision?: string) {
    const status = supervisor.current();
    const ack = status.acknowledgement;
    const targetRevision = originalRevision ?? gatewayRouteSnapshotRevision(definition);
    const state: RouteActivationState = ack?.state === "applied" ? ack.revision === targetRevision ? "applied" : "requested" : ack?.state === "rejected" ? "rejected" : "uncertain";
    return Object.freeze({ gatewayId: definition.id, revision: targetRevision, state, operationId,
      gatewayGenerationId: status.operation?.gatewayGenerationId, pid: status.operation?.pid, ...(ack?.code ? { code: ack.code } : {}),
      ...(ack?.unavailableInstances?.length ? { unavailableInstances: ack.unavailableInstances } : {}) });
  }
  return Object.freeze({
    attach(child: ChildProcess, identity: GatewayRouteSnapshotIdentity, initialDefinition: Readonly<GatewayDefinition>, initialRevision: string, unavailableInstances: readonly string[] = []) {
      children.get(child)?.dispose();
      children.set(child, createGatewayRouteSnapshotSupervisor({ child, identity, initialDefinition, initialRevision, timeoutMs: options.timeoutMs }));
      // READY is evidence only for exactly this boot revision, never for a newer desired draft.
      for (const [operationId, routes] of receipts) {
        const previous = routes.get(identity.gatewayId);
        if (previous?.state === "requested" && previous.revision === initialRevision) record(operationId, { ...previous, state: "applied", ...identity,
          ...(unavailableInstances.length ? { unavailableInstances: Object.freeze([...unavailableInstances]) } : {}) });
      }
    },
    detach(child: ChildProcess) { children.get(child)?.dispose(); children.delete(child); },
    receipt,
    /** Called inside the existing serialized catalog application, after definitions load and before normal lifecycle reconciliation. */
    async prepare(runtimes: Iterable<GatewayRouteActivationRuntime>, operationId: string, inspectOnly = false, allowRejectedRetry = true): Promise<RouteCatalogActivationReceipt> {
      const declarations = await options.declarations();
      const outcomes = new Map<string, GatewayRouteActivationReceipt>();
      const remember = (item: GatewayRouteActivationReceipt) => {
        outcomes.set(item.gatewayId, item);
        // Background captures have no user mutation receipt. Keep their result only for this invocation;
        // an admitted unconfirmed operation remains owned by the exact child's supervisor.
        if (allowRejectedRetry || inspectOnly) record(operationId, item);
      };
      for (const runtime of runtimes) {
        const definition = runtime.definition;
        const revision = gatewayRouteSnapshotRevision(definition);
        const previous = receipts.get(operationId)?.get(definition.id);
        const supervisor = runtime.process ? children.get(runtime.process) : undefined;
        // Resolving an original mutation may inspect it, but must never submit the latest desired document under that old identity.
        if (inspectOnly && !previous) continue;
        if (!supervisor || runtime.readiness !== "ready") {
          if (!inspectOnly) remember({ gatewayId: definition.id, revision, operationId, state: "requested" });
          continue;
        }
        let status = supervisor.current();
        if (inspectOnly) {
          // Installing the captured catalog must not turn an endpoint-only readback into the service's legacy restart action.
          if (status.appliedDefinition && classifyRouteChange(status.appliedDefinition, definition, declarations).kind !== "shared") runtime.needsRestart = false;
          if (status.operation?.operationId !== operationId) continue;
          try { await supervisor.inspect(); } catch { /* Original identity remains available for another explicit query. */ }
          remember(appliedFromAck(operationId, definition, supervisor, previous!.revision));
          continue;
        }
        const baseline = status.appliedDefinition;
        if (!baseline) continue;
        const change = classifyRouteChange(baseline, definition, declarations);
        // Shared and unknown fields retain the original full Gateway restart dependency closure.
        if (change.kind === "shared") {
          if (!inspectOnly) { runtime.needsRestart = true; remember({ gatewayId: definition.id, revision, operationId, state: "requested" }); }
          continue;
        }
        if (!inspectOnly) runtime.needsRestart = false;
        if (status.operation && !["applied", "rejected"].includes(status.state)) {
          try { await supervisor.inspect(); } catch { /* Preserve the original admitted operation; no replay. */ }
          status = supervisor.current();
          if (!["applied", "rejected"].includes(status.state)) {
            if (status.operation?.operationId === operationId) remember(appliedFromAck(operationId, definition, supervisor));
            else remember({ gatewayId: definition.id, revision, operationId, state: "rejected", code: "previous_operation_unconfirmed", blockedByOperationId: status.operation?.operationId });
            continue;
          }
        }
        if (status.operation?.operationId === operationId) { remember(appliedFromAck(operationId, definition, supervisor)); continue; }
        if (inspectOnly) continue;
        if (status.appliedRevision === revision) {
          remember({ gatewayId: definition.id, revision, operationId, state: "applied" });
          continue;
        }
        if (!allowRejectedRetry && status.state === "rejected" && status.operation?.revision === revision) {
          remember({ gatewayId: definition.id, revision, operationId, state: "rejected", code: status.acknowledgement?.code, blockedByOperationId: status.operation.operationId });
          continue;
        }
        // Repeated progress/final captures never retry a known rejection under a fresh hidden identity.
        if (previous?.revision === revision && previous.state === "rejected") continue;
        try { await supervisor.apply(definition, operationId); } catch { /* The supervisor retains exact accepted identity for resolve(). */ }
        remember(appliedFromAck(operationId, definition, supervisor));
      }
      return receipt(operationId) ?? summarize(operationId, outcomes.values());
    }
  });
}
