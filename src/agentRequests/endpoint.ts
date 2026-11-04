import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { createHash } from "node:crypto";
import type { AgentRequestParty } from "./store.js";

/** Full opaque owner identity; names and workspaces are not owner substitutes. */
export type AgentRequestEndpoint = {
  kind: "local" | "instance" | "device" | "service";
  managerInstanceId: string;
  /** Transport address of the execution owner, independent of the business ledger owner. */
  ownerDeviceId?: string;
  /** Original business ledger address for replies; routing metadata, not endpoint authority. */
  ledgerOwnerDeviceId?: string;
  instanceId?: string;
  nodeId?: string;
  agentId: string;
  provider: string;
  sessionId: string;
  authorizationIncarnation: string;
};

/** The admitted connection is an attribution source, never an executable task address. */
export type AgentConnectionSource = {
  kind: "connection";
  managerInstanceId: string;
  transport: "lan-agent" | "rabilink" | "local" | "service";
  id: string;
  authorizationIncarnation?: string;
  /** Route to the original Manager record, never part of source identity. */
  ledgerOwnerDeviceId?: string;
};
export type AgentDeliverySource = AgentRequestEndpoint | AgentConnectionSource;

export function normalizeAgentConnectionSource(value: AgentConnectionSource): AgentConnectionSource {
  if (!value || value.kind !== "connection" || !["lan-agent", "rabilink", "local", "service"].includes(value.transport)) {
    throw new Error("Invalid Agent connection source.");
  }
  for (const field of ["managerInstanceId", "id"] as const) {
    if (typeof value[field] !== "string" || !value[field] || value[field] !== value[field].trim()
      || value[field].length > 4096 || /[\0\r\n\u2028\u2029]/.test(value[field])) throw new Error(`Invalid Agent connection source ${field}.`);
  }
  return { kind: "connection", managerInstanceId: value.managerInstanceId, transport: value.transport, id: value.id,
    ...(typeof value.ledgerOwnerDeviceId === "string" && value.ledgerOwnerDeviceId ? { ledgerOwnerDeviceId: value.ledgerOwnerDeviceId } : {}),
    ...(typeof value.authorizationIncarnation === "string" && value.authorizationIncarnation ? { authorizationIncarnation: value.authorizationIncarnation } : {}) };
}

export function normalizeAgentDeliverySource(value: AgentDeliverySource): AgentDeliverySource {
  return value.kind === "connection" ? normalizeAgentConnectionSource(value) : normalizeAgentRequestEndpoint(value);
}

/** Compare a frozen source record; connection epochs are attribution, not a task authority. */
export function sameAgentDeliverySource(left?: AgentDeliverySource, right?: AgentDeliverySource): boolean {
  if (!left || !right) return false;
  if (left.kind === "connection" || right.kind === "connection") return left.kind === "connection" && right.kind === "connection"
    && agentDeliverySourceIdentity(left) === agentDeliverySourceIdentity(right);
  return sameAgentEndpoint(left, right);
}

export function agentDeliverySourceForParty(party: AgentRequestParty): AgentDeliverySource | undefined {
  return party.endpoint ?? party.connection;
}

export function normalizeAgentRequestEndpoint(value: AgentRequestEndpoint): AgentRequestEndpoint {
  if (!value || !["local", "instance", "device", "service"].includes(value.kind)) throw new Error("Invalid Agent endpoint kind.");
  const required = ["managerInstanceId", "agentId", "provider", "sessionId", "authorizationIncarnation"] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 4096) {
      throw new Error(`Invalid Agent endpoint ${key}.`);
    }
  }
  if (value.ownerDeviceId !== undefined && (typeof value.ownerDeviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.ownerDeviceId))) throw new Error("Invalid endpoint owner device.");
  if (value.ledgerOwnerDeviceId !== undefined && (typeof value.ledgerOwnerDeviceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.ledgerOwnerDeviceId))) throw new Error("Invalid endpoint ledger address.");
  if (value.kind === "instance") {
    for (const key of ["instanceId", "nodeId"] as const) {
      if (typeof value[key] !== "string" || !value[key]!.trim() || value[key] !== value[key]!.trim() || value[key]!.length > 4096) throw new Error(`Invalid instance endpoint ${key}.`);
    }
  }
  if (value.kind === "device") {
    if (typeof value.instanceId !== "string" || !value.instanceId.trim() || value.instanceId !== value.instanceId.trim()
      || value.instanceId.length > 4096 || value.nodeId !== undefined || value.provider !== "deviceAgent") throw new Error("Invalid device endpoint owner.");
  }
  return { kind: value.kind, managerInstanceId: value.managerInstanceId,
    ...(value.ownerDeviceId ? { ownerDeviceId: value.ownerDeviceId } : {}),
    ...(value.ledgerOwnerDeviceId ? { ledgerOwnerDeviceId: value.ledgerOwnerDeviceId } : {}),
    ...(value.kind === "instance" ? { instanceId: value.instanceId, nodeId: value.nodeId } : value.kind === "device" ? { instanceId: value.instanceId } : {}),
    agentId: value.agentId, provider: value.provider, sessionId: value.sessionId,
    authorizationIncarnation: value.authorizationIncarnation };
}

export function sameAgentEndpoint(left?: AgentRequestEndpoint, right?: AgentRequestEndpoint): boolean {
  return !!left && !!right && ["kind", "managerInstanceId", "ownerDeviceId", "instanceId", "nodeId", "agentId", "provider", "sessionId", "authorizationIncarnation"]
    .every(key => key === "agentId" && left.kind === "instance" && right.kind === "instance" || left[key as keyof AgentRequestEndpoint] === right[key as keyof AgentRequestEndpoint]);
}

/** Instance catalog aliases locate a backend; they do not create a different session owner. */
export function stableAgentEndpointIdentity(value: AgentRequestEndpoint) {
  const { ledgerOwnerDeviceId: _ledgerAddress, ...normalized } = normalizeAgentRequestEndpoint(value);
  if (normalized.kind !== "instance") return normalized;
  const { agentId: _alias, ...identity } = normalized;
  return identity;
}

/** Historical caller-key attribution excludes connection epochs. */
export function agentDeliverySourceIdentity(value: AgentDeliverySource): string {
  if (value.kind === "connection") {
    const { authorizationIncarnation: _incarnation, ledgerOwnerDeviceId: _ledgerAddress, ...connection } = normalizeAgentConnectionSource(value);
    return JSON.stringify(connection);
  }
  const { authorizationIncarnation: _incarnation, ...identity } = stableAgentEndpointIdentity(value);
  if (identity.kind === "local") { const { ownerDeviceId: _route, ...local } = identity; return JSON.stringify(local); }
  return JSON.stringify(identity);
}

function externalPeerSource(value: AgentRequestEndpoint): boolean {
  return (value.kind === "local" || value.kind === "instance") && Boolean(value.ownerDeviceId && value.ledgerOwnerDeviceId
    && value.ownerDeviceId !== value.ledgerOwnerDeviceId);
}

/** Old Peer producers recorded the remote PC's local instance; both forms name the same caller. */
export function agentDeliveryCallerSourceIdentity(value: AgentDeliverySource): string {
  if (value.kind === "connection") return agentDeliverySourceIdentity(value);
  if (!externalPeerSource(value)) return agentDeliverySourceIdentity(value);
  const source = normalizeAgentRequestEndpoint(value);
  return JSON.stringify({ managerInstanceId: source.managerInstanceId, ownerDeviceId: source.ownerDeviceId,
    provider: source.provider, sessionId: source.sessionId });
}

/** Historical reads also retain alias-sensitive instance keys and the earlier local-Peer formula. */
export function sourceScopedAgentDeliveryId(source: AgentDeliverySource, callerDeliveryId: string, legacyAlias = false): string {
  if (source.kind === "connection") return `agent-${createHash("sha256").update(JSON.stringify([agentDeliverySourceIdentity(source), callerDeliveryId])).digest("hex")}`;
  if (!legacyAlias && source.kind === "local" && externalPeerSource(source)) return `agent-${createHash("sha256").update(JSON.stringify([agentDeliveryCallerSourceIdentity(source), callerDeliveryId])).digest("hex")}`;
  if (source.ownerDeviceId && source.kind !== "local") return `agent-${createHash("sha256").update(JSON.stringify([agentDeliverySourceIdentity(source), callerDeliveryId])).digest("hex")}`;
  return `agent-${createHash("sha256").update(JSON.stringify([source.managerInstanceId, source.kind, source.instanceId,
    source.nodeId, source.kind === "instance" && !legacyAlias ? undefined : source.agentId, source.provider, source.sessionId, callerDeliveryId])).digest("hex")}`;
}

export function sameAgentParty(left: AgentRequestParty, right: AgentRequestParty): boolean {
  if (left.connection || right.connection) return !!left.connection && !!right.connection
    && agentDeliverySourceIdentity(left.connection) === agentDeliverySourceIdentity(right.connection);
  if (left.endpoint || right.endpoint) return sameAgentEndpoint(left.endpoint, right.endpoint)
    && left.threadId === right.threadId && left.agentAdapter === right.agentAdapter
    && left.agentType === right.agentType;
  return left.threadId === right.threadId
    && (!left.agentAdapter || !right.agentAdapter || left.agentAdapter === right.agentAdapter)
    && (!left.workspace || !right.workspace || sameCodexWorkspace(left.workspace, right.workspace));
}


/** Reply routing coordinates, independent of the source's descriptive role or connection epoch.
 * Prepared frames and receipts must continue to use sameAgentEndpoint instead. */
export function sameAgentPartyAddress(left: AgentRequestParty, right: AgentRequestParty): boolean {
  if (left.connection || right.connection) return false;
  if (left.threadId !== right.threadId) return false;
  if (left.endpoint || right.endpoint) {
    if (!left.endpoint || !right.endpoint) return false;
    if (left.endpoint.kind === "device" && right.endpoint.kind === "device") {
      // The original source recorded an owner-host hint; reply execution resolves the current device owner.
      return (["managerInstanceId", "agentId", "provider", "sessionId"] as const)
        .every(key => left.endpoint![key] === right.endpoint![key]);
    }
    const keys = ["kind", "managerInstanceId", "ownerDeviceId", "instanceId", "nodeId", "agentId", "provider", "sessionId"] as const;
    return keys.every(key => key === "agentId" && left.endpoint!.kind === "instance" && right.endpoint!.kind === "instance"
      || left.endpoint![key] === right.endpoint![key]);
  }
  return !left.agentAdapter || !right.agentAdapter || left.agentAdapter === right.agentAdapter;
}
