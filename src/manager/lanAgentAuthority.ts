import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWriteFileSync, withFileLockSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit, type DataMutationAuditRecord } from "../observability/dataMutationAudit.js";

export type LanAgentIdentity = { nodeId: string };
export type LanAgentCredential = LanAgentIdentity & { token: string };
export type LanAgentCredentialDiagnostic = Readonly<{ index: number; nodeId?: string; reason: "invalid_record" | "duplicate_identity" }>;
export type LanAgentAuthoritySnapshot = { revision: string; nodes: Array<LanAgentIdentity & { enabled: boolean }>; diagnostics: readonly LanAgentCredentialDiagnostic[] };
export type LanAgentConnectionLease = Readonly<{ nodeId: string; incarnation: string }>;
export type LanAgentBootstrapTicket = { ticket: string; expiresAt: number };
export type LanAgentAuthorityOptions = { statePath: string; now?: () => number; bootstrapTtlMs?: number; maxBootstrapTickets?: number };
type NodeCredential = { nodeId: string; secretHash: string; connectionIncarnation: string; enabled?: boolean };
type AuthorityState = { schemaVersion: 2; nodes: NodeCredential[] };
type CredentialSource = { nodes: unknown[]; validIds: Set<string>; diagnostics: LanAgentCredentialDiagnostic[] };
const credentialSources = new WeakMap<AuthorityState, CredentialSource>();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 2_000;
const validId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function isLanAgentCredentialToken(token: string): boolean { return typeof token === "string" && token.startsWith("lan1:"); }
function storageState(state: AuthorityState): { schemaVersion: 2; nodes: unknown[] } {
  const source = credentialSources.get(state);
  if (!source) return state;
  const remaining = new Map(state.nodes.map(node => [node.nodeId, node]));
  const nodes: unknown[] = [];
  for (const original of source.nodes) {
    const id = isRecord(original) && typeof original.nodeId === "string" ? original.nodeId : undefined;
    if (id && source.validIds.has(id)) {
      const node = remaining.get(id);
      if (node) nodes.push(node);
      remaining.delete(id);
    } else nodes.push(original);
  }
  nodes.push(...remaining.values());
  return { schemaVersion: 2, nodes };
}
function stateRevision(state: AuthorityState): string { return hashSecret(JSON.stringify(storageState(state))); }
function assertWritableNode(state: AuthorityState, nodeId: string): void {
  if (credentialSources.get(state)?.diagnostics.some(item => item.nodeId === nodeId)) {
    throw new Error("Computer credential identity is isolated. Repair its original credential records before changing this node.");
  }
}

/** One-time retirement of session grants. Preserve credentials and their incarnation; keep exact private recovery bytes. */
function loadState(statePath: string, migrate = false): AuthorityState {
  let text: string;
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("Invalid computer credential file.");
    text = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 2, nodes: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Invalid computer credential JSON."); }
  if (!isRecord(parsed) || ![1, 2].includes(parsed.schemaVersion as number) || !Array.isArray(parsed.nodes) || parsed.nodes.length > MAX_NODES
    || Object.keys(parsed).some(key => !(parsed.schemaVersion === 1 ? ["schemaVersion", "nodes", "mutationReceipts"] : ["schemaVersion", "nodes"]).includes(key))) throw new Error("Invalid computer credential schema.");
  const legacy = parsed.schemaVersion === 1;
  const counts = new Map<string, number>();
  for (const value of parsed.nodes) if (isRecord(value) && validId(value.nodeId)) counts.set(value.nodeId, (counts.get(value.nodeId) ?? 0) + 1);
  const nodes: NodeCredential[] = [];
  const diagnostics: LanAgentCredentialDiagnostic[] = [];
  for (const [index, value] of parsed.nodes.entries()) {
    const nodeId = isRecord(value) && validId(value.nodeId) ? value.nodeId : undefined;
    if (nodeId && counts.get(nodeId)! > 1) { diagnostics.push({ index, nodeId, reason: "duplicate_identity" }); continue; }
    const invalid = () => diagnostics.push({ index, ...(nodeId ? { nodeId } : {}), reason: "invalid_record" });
    if (!isRecord(value) || !nodeId || !hash(value.secretHash)) { invalid(); continue; }
    const incarnation = value.connectionIncarnation ?? (legacy ? value.authorizationIncarnation ?? hashSecret(value.secretHash) : undefined);
    if (!hash(incarnation) || Object.keys(value).some(key => !(legacy
      ? ["nodeId", "secretHash", "connectionIncarnation", "authorizationIncarnation", "enabledAgentIds", "disabledAgentIds", "agentBindings", "enabled"]
      : ["nodeId", "secretHash", "connectionIncarnation", "enabled"]).includes(key))) { invalid(); continue; }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") { invalid(); continue; }
    nodes.push({ nodeId, secretHash: value.secretHash, connectionIncarnation: incarnation, ...(value.enabled === false ? { enabled: false } : {}) });
  }
  const state: AuthorityState = { schemaVersion: 2, nodes };
  credentialSources.set(state, { nodes: parsed.nodes, validIds: new Set(nodes.map(node => node.nodeId)), diagnostics });
  if (legacy) {
    if (!migrate) throw new Error("Computer credentials require the locked startup migration.");
    const backup = statePath + ".before-explicit-sessions-" + randomBytes(12).toString("hex") + ".json";
    fs.writeFileSync(backup, text, { mode: 0o600, flag: "wx" });
    if (fs.readFileSync(statePath, "utf8") !== text || fs.readFileSync(backup, "utf8") !== text) throw new Error("Computer credential migration snapshot changed.");
    atomicWriteFileSync(statePath, JSON.stringify(storageState(state)) + "\n", { mode: 0o600 });
    const readback = loadState(statePath);
    if (stateRevision(readback) !== stateRevision(state)) { atomicWriteFileSync(statePath, text, { mode: 0o600 }); throw new Error("Computer credential migration verification failed; restored original."); }
  }
  return state;
}

/** Installation admission uses the same storage validator without migration or credential disclosure. */
export function inspectLanAgentCredentialState(statePath: string): { schemaVersion: 2; nodeCount: number } {
  const state = loadState(path.resolve(statePath));
  return { schemaVersion: state.schemaVersion, nodeCount: state.nodes.length };
}

/** Computer credentials authenticate the connection. Agent type and session ID belong to each invocation. */
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
    withFileLockSync(`${this.statePath}.lock`, () => { loadState(this.statePath, true); });
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

  /** Client-held secrets allow an exact exchange to be recovered after a lost response. */
  enroll(ticket: string, nodeId: string, enrollmentSecret?: string): LanAgentCredential {
    if (!validId(nodeId)) this.reject("enroll", "Invalid node ID.");
    if (enrollmentSecret !== undefined && !SECRET_PATTERN.test(enrollmentSecret)) this.reject("enroll", "Invalid enrollment recovery secret.");
    const secret = enrollmentSecret ?? randomBytes(32).toString("base64url");
    const credential = { nodeId, token: `lan1:${nodeId}:${secret}` };
    // Possession proves only the currently active credential. A revoked/replaced
    // secret cannot recover or recreate a node with a spent ticket.
    if (enrollmentSecret && this.authenticate(credential.token)) return credential;
    if (!this.validateBootstrapTicket(ticket)) this.reject("enroll", "Invalid or expired bootstrap ticket.");
    this.mutate("enroll", state => {
      assertWritableNode(state, nodeId);
      const existing = state.nodes.find(node => node.nodeId === nodeId);
      if (enrollmentSecret && existing?.secretHash === hashSecret(secret)) return false;
      if (!this.validateBootstrapTicket(ticket)) this.reject("enroll", "Invalid or expired bootstrap ticket.");
      if (existing) {
        if (!enrollmentSecret) this.reject("enroll", "Node already enrolled.");
        existing.secretHash = hashSecret(secret);
        existing.connectionIncarnation = randomBytes(32).toString("hex");
        return true;
      }
      if (storageState(state).nodes.length >= MAX_NODES) this.reject("enroll", "Node capacity reached; retained isolated records also occupy storage.");
      state.nodes.push({ nodeId, secretHash: hashSecret(secret), connectionIncarnation: randomBytes(32).toString("hex") });
      return true;
    });
    this.tickets.delete(hashSecret(ticket));
    return credential;
  }

  /** Invalid credentials return null; storage corruption/read failure throws (fail closed). */
  authenticate(token: string): LanAgentIdentity | null {
    const node = this.authenticatedNode(token);
    return node ? { nodeId: node.nodeId } : null;
  }

  /** Connection authority belongs to the enrolled computer, never a saved Agent/session. */
  acquireConnectionLease(token: string): LanAgentConnectionLease | null {
    const node = this.authenticatedNode(token);
    return node && node.enabled !== false ? Object.freeze({ nodeId: node.nodeId,
      incarnation: node.connectionIncarnation }) : null;
  }

  assertConnectionLease(token: string, lease: LanAgentConnectionLease): void {
    const current = this.acquireConnectionLease(token);
    if (!current || current.nodeId !== lease.nodeId || current.incarnation !== lease.incarnation) {
      this.reject("revalidate-connection", "Remote computer connection was disabled, revoked or replaced.");
    }
  }

  getNodeAuthorization(nodeId: string): LanAgentConnectionLease | null {
    const node = this.readState().nodes.find(item => item.nodeId === nodeId);
    return node && node.enabled !== false ? Object.freeze({ nodeId, incarnation: node.connectionIncarnation }) : null;
  }

  /** Detached, secret-free view for trusted Manager UI/registry projections. */
  getSnapshot(): LanAgentAuthoritySnapshot {
    const state = this.readState();
    return {
      revision: stateRevision(state),
      nodes: state.nodes.map(node => ({ nodeId: node.nodeId, enabled: node.enabled !== false })),
      diagnostics: (credentialSources.get(state)?.diagnostics ?? []).map(item => ({ ...item }))
    };
  }

  isNodeEnabled(nodeId: string): boolean { return this.readState().nodes.some(node => node.nodeId === nodeId && node.enabled !== false); }

  /** A single instance switch controls the connection, never individual features or sessions. */
  setNodeEnabled(nodeId: string, enabled: boolean, expectedEnabled?: boolean): void {
    if (!validId(nodeId) || typeof enabled !== "boolean") this.reject("set-node-enabled", "Invalid instance enabled setting.");
    this.mutate("set-node-enabled", state => {
      assertWritableNode(state, nodeId);
      const node = state.nodes.find(item => item.nodeId === nodeId);
      if (!node) this.reject("set-node-enabled", "Computer is not enrolled.");
      const current = node.enabled !== false;
      if (current === enabled) return false;
      if (expectedEnabled !== undefined && current !== expectedEnabled) this.reject("set-node-enabled", "Instance enabled setting conflict.");
      if (enabled) delete node.enabled; else node.enabled = false;
      node.connectionIncarnation = randomBytes(32).toString("hex");
      return true;
    });
  }

  /** Trusted admin only. Idempotently removes the computer credential. */
  revokeNode(nodeId: string): void {
    if (!validId(nodeId)) this.reject("revoke-node", "Invalid node ID.");
    this.mutate("revoke-node", state => {
      assertWritableNode(state, nodeId);
      const count = state.nodes.length;
      state.nodes = state.nodes.filter(node => node.nodeId !== nodeId);
      return count !== state.nodes.length;
    });
  }

  private authenticatedNode(token: string, state?: AuthorityState): NodeCredential | null {
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
        const content = `${JSON.stringify(storageState(state))}\n`;
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
      target: { type: "lan-agent-authority", id: "computer-credentials" },
      dataSource: { kind, id: kind === "file" ? this.statePath : "lan-agent-bootstrap-tickets" }, outcome
    });
  }
}
