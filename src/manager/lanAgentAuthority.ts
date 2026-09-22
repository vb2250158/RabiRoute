import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit, type DataMutationAuditRecord } from "../observability/dataMutationAudit.js";

import type { InstanceAgent } from "../shared/agentInstance.js";

export type LanAgentApprovedBinding = Pick<InstanceAgent, "agentId" | "provider" | "sessionId" | "managedSessionIds">;
export type LanAgentIdentity = { nodeId: string };
export type LanAgentCredential = LanAgentIdentity & { token: string };
export type LanAgentAuthoritySnapshot = {
  revision: string;
  nodes: Array<LanAgentIdentity & { enabledAgentIds: string[]; agentBindings?: LanAgentApprovedBinding[] }>;
};

/** Identify credentials before any loopback exception; malformed lan1 tokens still require auth. */
export function isLanAgentCredentialToken(token: string): boolean {
  return typeof token === "string" && token.startsWith("lan1:");
}

function stateRevision(state: AuthorityState): string {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: state.schemaVersion, nodes: state.nodes })).digest("hex");
}
export type LanAgentBootstrapTicket = { ticket: string; expiresAt: number };
export type LanAgentAuthorityOptions = {
  /** Trusted Manager-owned path, never derived from a remote request. */
  statePath: string;
  now?: () => number;
  bootstrapTtlMs?: number;
  maxBootstrapTickets?: number;
};

type NodeGrant = { nodeId: string; secretHash: string; enabledAgentIds: string[]; disabledAgentIds?: string[]; agentBindings?: LanAgentApprovedBinding[] };

function setNodeAgentEnabled(node: NodeGrant, agentId: string, enabled: boolean): void {
  const disabled = node.disabledAgentIds ?? [];
  if (!enabled && !disabled.includes(agentId) && disabled.length >= MAX_AGENTS_PER_NODE) throw new Error("Agent disable capacity reached.");
  if (enabled && !node.enabledAgentIds.includes(agentId) && node.enabledAgentIds.length >= MAX_AGENTS_PER_NODE) throw new Error("Agent grant capacity reached.");
  node.disabledAgentIds = enabled ? disabled.filter(id => id !== agentId) : [...new Set([...disabled, agentId])];
  node.enabledAgentIds = enabled ? [...new Set([...node.enabledAgentIds, agentId])] : node.enabledAgentIds.filter(id => id !== agentId);
}
export type LanAgentAuthorizationMutation = {
  nodeId: string; agentId: string; enabled: boolean; binding?: LanAgentApprovedBinding;
  expectedRevision: string; idempotencyKey: string;
  /** Trusted synchronous Manager validation; skipped for durable replay, never hashed/persisted. */
  validateBinding?: () => void;
};
/** Historical result of this command, not a claim about current effective policy. */
export type LanAgentAuthorizationResult = { revision: string; replayed: boolean; enabled: boolean };
type MutationReceipt = {
  keyHash: string; requestHash: string; revision: string; enabled: boolean; committedAt: number; expiresAt: number;
};
type AuthorityState = { schemaVersion: 1; nodes: NodeGrant[]; mutationReceipts?: MutationReceipt[] };
export const LAN_AGENT_MUTATION_RECEIPT_TTL_MS = 24 * 60 * 60_000;
export const LAN_AGENT_MUTATION_RECEIPT_LIMIT = 1_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 2_000;
const MAX_AGENTS_PER_NODE = 1_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function copyBinding(value: unknown, persisted = false): LanAgentApprovedBinding {
  const validText = (text: unknown, max: number): text is string => typeof text === "string"
    && text.length > 0 && text.length <= max && text.trim() === text && !/[\u0000-\u001f\u007f]/.test(text);
  if (!isRecord(value) || !validId(value.agentId) || !validText(value.provider, 80)
    || (value.sessionId !== undefined && !validText(value.sessionId, 192))
    || (value.managedSessionIds !== undefined && (!Array.isArray(value.managedSessionIds)
      || value.managedSessionIds.length > 512 || !value.managedSessionIds.every(id => validText(id, 192))
      || new Set(value.managedSessionIds).size !== value.managedSessionIds.length))
    || (persisted && Object.keys(value).some(key => !["agentId", "provider", "sessionId", "managedSessionIds"].includes(key)))) {
    throw new Error("Invalid LAN agent authority binding.");
  }
  return {
    agentId: value.agentId, provider: value.provider,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.managedSessionIds !== undefined ? { managedSessionIds: [...value.managedSessionIds as string[]] } : {})
  };
}

function loadState(statePath: string): AuthorityState {
  let text: string;
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("Invalid LAN agent authority file.");
    text = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, nodes: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Invalid LAN agent authority JSON."); }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)
    || parsed.nodes.length > MAX_NODES || Object.keys(parsed).some(key => !["schemaVersion", "nodes", "mutationReceipts"].includes(key))) {
    throw new Error("Invalid LAN agent authority schema.");
  }
  const seen = new Set<string>();
  const nodes: NodeGrant[] = parsed.nodes.map((node: unknown) => {
    if (!isRecord(node) || !validId(node.nodeId) || seen.has(node.nodeId)
      || typeof node.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(node.secretHash)
      || !Array.isArray(node.enabledAgentIds) || node.enabledAgentIds.length > MAX_AGENTS_PER_NODE
      || !node.enabledAgentIds.every(validId) || new Set(node.enabledAgentIds).size !== node.enabledAgentIds.length
      || (node.disabledAgentIds !== undefined && (!Array.isArray(node.disabledAgentIds)
        || node.disabledAgentIds.length > MAX_AGENTS_PER_NODE || !node.disabledAgentIds.every(validId)
        || new Set(node.disabledAgentIds).size !== node.disabledAgentIds.length
        || node.disabledAgentIds.some(id => (node.enabledAgentIds as string[]).includes(id))))
      || Object.keys(node).some(key => !["nodeId", "secretHash", "enabledAgentIds", "disabledAgentIds", "agentBindings"].includes(key))) {
      throw new Error("Invalid LAN agent authority node.");
    }
    seen.add(node.nodeId);
    let agentBindings: LanAgentApprovedBinding[] | undefined;
    if (node.agentBindings !== undefined) {
      if (!Array.isArray(node.agentBindings) || node.agentBindings.length > MAX_AGENTS_PER_NODE) {
        throw new Error("Invalid LAN agent authority bindings.");
      }
      agentBindings = node.agentBindings.map(binding => copyBinding(binding, true));
      if (new Set(agentBindings.map(binding => binding.agentId)).size !== agentBindings.length) {
        throw new Error("Invalid LAN agent authority duplicate binding.");
      }
    }
    // Legacy files cannot distinguish a reviewed-but-never-enabled binding from a
    // deliberately disabled one. Preserve both as disabled; an admin can enable it.
    // Unbound legacy IDs are not registered implicitly by this migration.
    const disabledAgentIds = node.disabledAgentIds as string[] | undefined
      ?? (agentBindings ?? []).filter(binding => !(node.enabledAgentIds as string[]).includes(binding.agentId)).map(binding => binding.agentId);
    return { nodeId: node.nodeId, secretHash: node.secretHash, enabledAgentIds: [...node.enabledAgentIds],
      disabledAgentIds: [...disabledAgentIds],
      ...(agentBindings !== undefined ? { agentBindings } : {}) };
  });
  let mutationReceipts: MutationReceipt[] | undefined;
  if (parsed.mutationReceipts !== undefined) {
    if (!Array.isArray(parsed.mutationReceipts) || parsed.mutationReceipts.length > LAN_AGENT_MUTATION_RECEIPT_LIMIT) {
      throw new Error("Invalid LAN agent authority receipts.");
    }
    const keys = new Set<string>();
    mutationReceipts = parsed.mutationReceipts.map((receipt: unknown) => {
      if (!isRecord(receipt) || ![receipt.keyHash, receipt.requestHash, receipt.revision]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
        || typeof receipt.enabled !== "boolean" || !Number.isSafeInteger(receipt.committedAt)
        || !Number.isSafeInteger(receipt.expiresAt) || Number(receipt.committedAt) < 0
        || Number(receipt.expiresAt) - Number(receipt.committedAt) !== LAN_AGENT_MUTATION_RECEIPT_TTL_MS
        || Object.keys(receipt).some(key => !["keyHash", "requestHash", "revision", "enabled", "committedAt", "expiresAt"].includes(key))) {
        throw new Error("Invalid LAN agent authority receipt.");
      }
      const validated = receipt as MutationReceipt;
      if (keys.has(validated.keyHash)) throw new Error("Invalid LAN agent authority duplicate receipt.");
      keys.add(validated.keyHash);
      return { ...validated };
    });
  }
  return { schemaVersion: 1, nodes, ...(mutationReceipts !== undefined ? { mutationReceipts } : {}) };
}

/**
 * Manager is the sole policy owner. Expose only enrollment/authentication to remote
 * callers; ticket issuance, grant changes and revocation require a trusted admin.
 * All methods are synchronous. Reads use the authoritative file (not registry or
 * connection state); file-locked writes reload it, so offline revocation and other
 * instances cannot be overwritten by a stale in-memory snapshot.
 */
export class LanAgentAuthority {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly bootstrapTtlMs: number;
  private readonly maxBootstrapTickets: number;
  private readonly tickets = new Map<string, number>();

  constructor(options: LanAgentAuthorityOptions) {
    this.statePath = path.resolve(options.statePath);
    this.now = options.now ?? Date.now;
    this.bootstrapTtlMs = options.bootstrapTtlMs ?? 30 * 60_000;
    this.maxBootstrapTickets = options.maxBootstrapTickets ?? 128;
    if (!Number.isSafeInteger(this.bootstrapTtlMs) || this.bootstrapTtlMs < 1 || this.bootstrapTtlMs > 30 * 60_000
      || !Number.isSafeInteger(this.maxBootstrapTickets) || this.maxBootstrapTickets < 1 || this.maxBootstrapTickets > 4_096) {
      throw new Error("Invalid LAN agent bootstrap limits.");
    }
    this.readState(); // Corruption must stop startup, never silently reset grants.
  }

  /** Trusted admin only. Tickets are memory-only and invalid after restart. */
  issueBootstrapTicket(): LanAgentBootstrapTicket {
    const now = this.now();
    for (const [digest, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(digest);
    }
    if (this.tickets.size >= this.maxBootstrapTickets) {
      this.reject("issue-bootstrap", "Bootstrap ticket capacity reached.");
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.bootstrapTtlMs;
    this.tickets.set(hashSecret(ticket), expiresAt);
    this.audit("issue-bootstrap", "committed", "runtime");
    return { ticket, expiresAt };
  }

  /** Download validation does not consume the ticket; only successful enrollment does. */
  validateBootstrapTicket(ticket: string): boolean {
    if (typeof ticket !== "string" || !SECRET_PATTERN.test(ticket)) return false;
    const expiresAt = this.tickets.get(hashSecret(ticket));
    return expiresAt !== undefined && expiresAt > this.now();
  }

  /** Returns the secret once. Failed persistence leaves the ticket available to retry. */
  enroll(ticket: string, nodeId: string): LanAgentCredential {
    if (!validId(nodeId)) this.reject("enroll", "Invalid node ID.");
    if (!this.validateBootstrapTicket(ticket)) this.reject("enroll", "Invalid or expired bootstrap ticket.");
    const secret = randomBytes(32).toString("base64url");
    this.mutate("enroll", state => {
      if (!this.validateBootstrapTicket(ticket)) this.reject("enroll", "Invalid or expired bootstrap ticket.");
      if (state.nodes.some(node => node.nodeId === nodeId)) this.reject("enroll", "Node already enrolled.");
      if (state.nodes.length >= MAX_NODES) this.reject("enroll", "Node capacity reached.");
      state.nodes.push({ nodeId, secretHash: hashSecret(secret), enabledAgentIds: [], disabledAgentIds: [] });
      return true;
    });
    this.tickets.delete(hashSecret(ticket));
    return { nodeId, token: `lan1:${nodeId}:${secret}` };
  }

  /** Invalid credentials return null; storage corruption/read failure throws (fail closed). */
  authenticate(token: string): LanAgentIdentity | null {
    const node = this.authenticatedNode(token);
    return node ? { nodeId: node.nodeId } : null;
  }

  /** Register a complete catalog only from its live authenticated node connection.
   * Re-authenticate under the write lock, replace (never merge) session claims, and
   * retain Manager-owned explicit disables even across removal and reappearance.
   */
  registerAgentCatalog(token: string, agents: readonly LanAgentApprovedBinding[]): void {
    if (!Array.isArray(agents) || agents.length > MAX_AGENTS_PER_NODE) this.reject("register-agent-catalog", "Invalid Agent catalog.");
    const bindings = agents.map(agent => copyBinding(agent));
    if (new Set(bindings.map(binding => binding.agentId)).size !== bindings.length) this.reject("register-agent-catalog", "Duplicate Agent catalog identity.");
    this.mutate("register-agent-catalog", state => {
      const identity = this.authenticatedNode(token, state);
      if (!identity) this.reject("register-agent-catalog", "Invalid node credential.");
      const node = state.nodes.find(item => item.nodeId === identity.nodeId);
      if (!node) this.reject("register-agent-catalog", "Node is not enrolled.");
      const enabledAgentIds = bindings.filter(binding => !node.disabledAgentIds?.includes(binding.agentId)).map(binding => binding.agentId);
      if (JSON.stringify(node.agentBindings) === JSON.stringify(bindings)
        && JSON.stringify(node.enabledAgentIds) === JSON.stringify(enabledAgentIds)) return false;
      node.agentBindings = bindings;
      node.enabledAgentIds = enabledAgentIds;
      return true;
    });
  }

  /** Only authenticated, registered (or explicitly admin-granted) IDs have authority. */
  authorize(token: string, agentId: string): LanAgentIdentity | null {
    if (!validId(agentId)) return null;
    const node = this.authenticatedNode(token);
    return node?.enabledAgentIds.includes(agentId) ? { nodeId: node.nodeId } : null;
  }

  /** Detached, secret-free view for trusted Manager UI/registry projections. */
  getSnapshot(): LanAgentAuthoritySnapshot {
    const state = this.readState();
    return {
      revision: stateRevision(state),
      nodes: state.nodes.map(node => ({ nodeId: node.nodeId, enabledAgentIds: [...node.enabledAgentIds],
        ...(node.agentBindings !== undefined ? { agentBindings: node.agentBindings.map(binding => copyBinding(binding)) } : {}) }))
    };
  }

  isAgentEnabled(nodeId: string, agentId: string): boolean {
    if (!validId(nodeId) || !validId(agentId)) return false;
    return this.readState().nodes.some(node => node.nodeId === nodeId && node.enabledAgentIds.includes(agentId));
  }

  /** Trusted admin only: freezes reviewed identity claims, never called by catalog ingestion. */
  approveAgentBinding(nodeId: string, agent: LanAgentApprovedBinding, expectedRevision?: string): void {
    if (!validId(nodeId)) this.reject("approve-agent-binding", "Invalid node ID.");
    let binding: LanAgentApprovedBinding;
    try { binding = copyBinding(agent); } catch {
      this.reject("approve-agent-binding", "Invalid LAN agent authority binding.");
    }
    this.mutate("approve-agent-binding", state => {
      if (expectedRevision !== undefined && expectedRevision !== stateRevision(state)) {
        this.reject("approve-agent-binding", "LAN agent authority revision conflict.");
      }
      const node = state.nodes.find(item => item.nodeId === nodeId);
      if (!node) this.reject("approve-agent-binding", "Node is not enrolled.");
      const bindings = node.agentBindings ?? [];
      const index = bindings.findIndex(item => item.agentId === binding.agentId);
      if (index >= 0 && JSON.stringify(bindings[index]) === JSON.stringify(binding)) return false;
      if (index < 0 && bindings.length >= MAX_AGENTS_PER_NODE) this.reject("approve-agent-binding", "Agent binding capacity reached.");
      node.agentBindings = index < 0 ? [...bindings, binding] : bindings.map((item, i) => i === index ? binding : item);
      return true;
    });
  }

  /** Trusted admin only. Exact retries replay for 24h before CAS; active receipts are never evicted. */
  mutateAgentAuthorization(input: LanAgentAuthorizationMutation): LanAgentAuthorizationResult {
    const action = "mutate-agent-authorization";
    if (!validId(input.nodeId) || !validId(input.agentId) || typeof input.enabled !== "boolean"
      || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
      || typeof input.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey)) {
      this.reject(action, "Invalid agent authorization mutation.");
    }
    let binding: LanAgentApprovedBinding | undefined;
    if (input.binding !== undefined) {
      try { binding = copyBinding(input.binding); } catch { this.reject(action, "Invalid LAN agent authority binding."); }
      if (binding.agentId !== input.agentId) this.reject(action, "Agent binding identity mismatch.");
    }
    if (input.enabled && !binding) this.reject(action, "Agent approval binding is required.");
    if (!input.enabled && binding) this.reject(action, "Disabled mutation must not replace identity binding.");
    const keyHash = hashSecret(input.idempotencyKey);
    const requestHash = hashSecret(JSON.stringify({ nodeId: input.nodeId, agentId: input.agentId,
      enabled: input.enabled, binding, expectedRevision: input.expectedRevision }));
    let result: LanAgentAuthorizationResult | undefined;
    this.mutate(action, state => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + LAN_AGENT_MUTATION_RECEIPT_TTL_MS)) {
        this.reject(action, "Invalid authority clock.");
      }
      const receipts = (state.mutationReceipts ?? []).filter(receipt => receipt.expiresAt > now);
      const previous = receipts.find(receipt => receipt.keyHash === keyHash);
      if (previous) {
        if (previous.requestHash !== requestHash) this.reject(action, "LAN agent authorization idempotency conflict.");
        result = { revision: previous.revision, enabled: previous.enabled, replayed: true };
        this.audit(action, "replayed");
        return false;
      }
      if (input.expectedRevision !== stateRevision(state)) this.reject(action, "LAN agent authority revision conflict.");
      if (receipts.length >= LAN_AGENT_MUTATION_RECEIPT_LIMIT) this.reject(action, "Agent mutation receipt capacity reached.");
      input.validateBinding?.();
      const node = state.nodes.find(item => item.nodeId === input.nodeId);
      if (!node) this.reject(action, "Node is not enrolled.");
      if (binding) {
        const bindings = node.agentBindings ?? [];
        const index = bindings.findIndex(item => item.agentId === input.agentId);
        if (index < 0 && bindings.length >= MAX_AGENTS_PER_NODE) this.reject(action, "Agent binding capacity reached.");
        node.agentBindings = index < 0 ? [...bindings, binding] : bindings.map((item, i) => i === index ? binding! : item);
      }
      setNodeAgentEnabled(node, input.agentId, input.enabled);
      const revision = stateRevision(state);
      state.mutationReceipts = [...receipts, { keyHash, requestHash, revision, enabled: input.enabled,
        committedAt: now, expiresAt: now + LAN_AGENT_MUTATION_RECEIPT_TTL_MS }];
      result = { revision, enabled: input.enabled, replayed: false };
      return true;
    });
    return result!;
  }

  /** Trusted admin only: approve the complete identity snapshot and enable in one CAS write. */
  approveAndEnableAgent(nodeId: string, agent: LanAgentApprovedBinding, expectedRevision: string): void {
    if (!validId(nodeId) || typeof expectedRevision !== "string" || !expectedRevision) {
      this.reject("approve-and-enable-agent", "Invalid agent approval.");
    }
    let binding: LanAgentApprovedBinding;
    try { binding = copyBinding(agent); } catch {
      this.reject("approve-and-enable-agent", "Invalid LAN agent authority binding.");
    }
    this.mutate("approve-and-enable-agent", state => {
      if (expectedRevision !== stateRevision(state)) {
        this.reject("approve-and-enable-agent", "LAN agent authority revision conflict.");
      }
      const node = state.nodes.find(item => item.nodeId === nodeId);
      if (!node) this.reject("approve-and-enable-agent", "Node is not enrolled.");
      const bindings = node.agentBindings ?? [];
      const index = bindings.findIndex(item => item.agentId === binding.agentId);
      const enabled = (node.enabledAgentIds as string[]).includes(binding.agentId);
      if (index >= 0 && JSON.stringify(bindings[index]) === JSON.stringify(binding) && enabled) return false;
      if ((index < 0 && bindings.length >= MAX_AGENTS_PER_NODE)
        || (!enabled && node.enabledAgentIds.length >= MAX_AGENTS_PER_NODE)) {
        this.reject("approve-and-enable-agent", "Agent approval capacity reached.");
      }
      // Replacement, not merge: omitted managed sessions revoke previously approved claims.
      node.agentBindings = index < 0 ? [...bindings, binding] : bindings.map((item, i) => i === index ? binding : item);
      setNodeAgentEnabled(node, binding.agentId, true);
      return true;
    });
  }

  /** Identity claims only; callers must separately check current enabled authority. */
  getApprovedAgentBinding(nodeId: string, agentId: string): LanAgentApprovedBinding | null {
    if (!validId(nodeId) || !validId(agentId)) return null;
    const binding = this.readState().nodes.find(node => node.nodeId === nodeId)
      ?.agentBindings?.find(agent => agent.agentId === agentId);
    return binding ? copyBinding(binding) : null;
  }

  /** Trusted admin only. HTTP callers must supply the snapshot revision for CAS. */
  setAgentEnabled(nodeId: string, agentId: string, enabled: boolean, expectedRevision?: string): void {
    if (!validId(nodeId) || !validId(agentId) || typeof enabled !== "boolean") {
      this.reject("set-agent-enabled", "Invalid agent grant.");
    }
    this.mutate("set-agent-enabled", state => {
      if (expectedRevision !== undefined && expectedRevision !== stateRevision(state)) {
        this.reject("set-agent-enabled", "LAN agent authority revision conflict.");
      }
      const node = state.nodes.find(item => item.nodeId === nodeId);
      if (!node) this.reject("set-agent-enabled", "Node is not enrolled.");
      if (enabled ? node.enabledAgentIds.includes(agentId) : node.disabledAgentIds?.includes(agentId)) return false;
      setNodeAgentEnabled(node, agentId, enabled);
      return true;
    });
  }

  /** Trusted admin only. Idempotently removes credential and all grants. */
  revokeNode(nodeId: string): void {
    if (!validId(nodeId)) this.reject("revoke-node", "Invalid node ID.");
    this.mutate("revoke-node", state => {
      const count = state.nodes.length;
      state.nodes = state.nodes.filter(node => node.nodeId !== nodeId);
      return count !== state.nodes.length;
    });
  }

  private authenticatedNode(token: string, state?: AuthorityState): NodeGrant | null {
    if (typeof token !== "string" || token.length > 177) return null;
    const [version, nodeId, secret, extra] = token.split(":");
    if (version !== "lan1" || !validId(nodeId) || !secret || !SECRET_PATTERN.test(secret) || extra !== undefined) return null;
    const node = (state ?? this.readState()).nodes.find(item => item.nodeId === nodeId);
    if (!node || !timingSafeEqual(Buffer.from(node.secretHash, "hex"), Buffer.from(hashSecret(secret), "hex"))) return null;
    return node;
  }

  private readState(): AuthorityState {
    try { return loadState(this.statePath); } catch (error) {
      this.audit("load", "failed");
      throw error;
    }
  }

  private mutate(action: string, update: (state: AuthorityState) => boolean): void {
    this.audit(action, "started");
    try {
      withFileLockSync(`${this.statePath}.lock`, () => {
        const state = this.readState();
        if (!update(state)) {
          this.audit(action, "no_change");
          return;
        }
        const content = `${JSON.stringify(state)}\n`;
        if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("LAN agent authority capacity reached.");
        atomicWriteFileSync(this.statePath, content, { mode: 0o600 });
        this.audit(action, "committed");
      });
    } catch (error) {
      this.audit(action, "failed");
      throw error;
    }
  }

  private reject(action: string, message: string): never {
    this.audit(action, "rejected");
    throw new Error(message);
  }

  private audit(action: string, outcome: DataMutationAuditRecord["outcome"], kind: "file" | "runtime" = "file"): void {
    // Never pass request strings, credential hashes, JSON parse errors or raw errors.
    recordDataMutationAudit({
      group: "security", event: "lan_agent_authority", owner: "lan-agent-authority", action,
      target: { type: "lan-agent-authority", id: "node-grants" },
      dataSource: { kind, id: kind === "file" ? this.statePath : "lan-agent-bootstrap-tickets" }, outcome
    });
  }
}
