import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import fs from "node:fs";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { ApiUpgradeInput } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createLanAgentConnectionOperation, LAN_AGENT_WEBSOCKET_LIMITS, type LanAgentConnectionOptions } from "./lanAgentConnectionOperation.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { normalizeInstanceAgents, type AgentInstance, type InstanceAgent } from "../shared/agentInstance.js";
import { WebSocket, WebSocketServer } from "ws";
import { webguiTokenMatches } from "./webguiLanAccess.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { LanAgentTerminals } from "./lanAgentTerminals.js";

export type LanAgentNodeHello = {
  nodeId: string;
  hostname?: string;
  version: string;
  platform: string;
  agentTypes?: string[];
  allowedWorkspaces?: string[];
  agents?: InstanceAgent[];
  terminalShells?: string[];
  computerCapabilities?: string[];
  taskTargeting?: "explicit-session-v1";
};

export type LanAgentUpdateState = "idle" | "requested" | "updating" | "updated" | "failed";

export type LanAgentNodeStatus = LanAgentNodeHello & {
  /** Local display alias owned by Manager, never supplied by the connector. */
  name?: string;
  connected: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  remoteAddress?: string;
  targetVersion?: string;
  updateState?: LanAgentUpdateState;
  lastUpdateAt?: string;
  lastUpdateError?: string;
};

export type LanAgentTaskStatus = "queued" | "delivered" | "acknowledged" | "progress" | "completed" | "failed" | "interrupted";

export type LanAgentTask = {
  taskId: string;
  idempotencyKey: string;
  nodeId: string;
  targetAgent: string;
  agentId?: string;
  threadId: string;
  message: string;
  cwd?: string;
  status: LanAgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
};

type PersistedState = {
  schemaVersion: 2;
  nodes: LanAgentNodeStatus[];
  tasks: LanAgentTask[];
  resultReceipts?: LanAgentResultReceipt[];
};

type LanAgentResultReceipt = {
  taskId: string;
  nodeId: string;
  idempotencyKey: string;
  assignmentHash: string;
  status: "completed" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  resultHash: string;
  eventId?: string;
  payloadHash?: string;
};

const terminalTaskStates = new Set<LanAgentTaskStatus>(["completed", "failed", "interrupted"]);
const completedTaskHistoryLimit = 500;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assignmentHash = (task: Pick<LanAgentTask, "targetAgent" | "agentId" | "threadId" | "message" | "cwd">) => fingerprint({
  targetAgent: task.targetAgent, agentId: task.agentId, threadId: task.threadId, message: task.message, cwd: task.cwd
});
const resultHash = (result: Pick<LanAgentTask, "status" | "result" | "error">) => fingerprint({ status: result.status, result: result.result, error: result.error });
const idempotencyScope = (nodeId: string, key: string) => JSON.stringify([nodeId, key]);

function receiptForTask(task: LanAgentTask): LanAgentResultReceipt {
  if (!terminalTaskStates.has(task.status)) throw new Error("Only a terminal task can be compacted.");
  return { taskId: task.taskId, nodeId: task.nodeId, idempotencyKey: task.idempotencyKey, assignmentHash: assignmentHash(task),
    status: task.status as LanAgentResultReceipt["status"], createdAt: task.createdAt, updatedAt: task.updatedAt, resultHash: resultHash(task) };
}

type Connection = {
  socket: WebSocket;
  nodeId?: string;
  authenticated: boolean;
  credential?: string;
  authenticatedNodeId?: string;
  authenticatedNodeIncarnation?: string;
  authenticationTimer: NodeJS.Timeout;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizedRemoteAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^::ffff:/, "");
  return normalized || undefined;
}

function normalizeNodeId(value: unknown): string {
  const nodeId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
    throw new Error("Rabi Agent nodeId must use 1-128 letters, numbers, dots, underscores, or hyphens.");
  }
  return nodeId;
}

function normalizeTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => typeof item === "string" ? item.trim() : "")
    .filter(item => Boolean(item) && item.length <= maxLength))]
    .slice(0, maxItems);
}

function normalizeHello(value: unknown): LanAgentNodeHello {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<LanAgentNodeHello>
    : {};
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const hostname = typeof raw.hostname === "string" ? raw.hostname.trim() : "";
  if (hostname.length > 255 || /[\u0000-\u001f\u007f]/u.test(hostname)) throw new Error("Rabi Agent hostname must be single-line text of at most 255 characters.");
  const platform = typeof raw.platform === "string" ? raw.platform.trim() : "";
  if (!version || version.length > 80) throw new Error("Rabi Agent version is required.");
  if (!platform || platform.length > 80) throw new Error("Rabi Agent platform is required.");
  return {
    nodeId: normalizeNodeId(raw.nodeId),
    hostname: hostname || undefined,
    version,
    platform,
    agentTypes: normalizeTextList(raw.agentTypes, 16, 80),
    allowedWorkspaces: normalizeTextList(raw.allowedWorkspaces, 32, 1_024),
    agents: raw.agents === undefined ? undefined : normalizeInstanceAgents(raw.agents),
    taskTargeting: raw.taskTargeting === "explicit-session-v1" ? raw.taskTargeting : undefined,
    terminalShells: normalizeTextList(raw.terminalShells, 5, 16).filter(shell => ["cmd", "powershell", "zsh", "bash", "sh"].includes(shell)),
    computerCapabilities: normalizeTextList(raw.computerCapabilities, 3, 16).filter(capability => ["files", "windows", "screenshots"].includes(capability))
  };
}

function parseMessage(value: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
    const timer = setTimeout(() => socket.terminate(), LAN_AGENT_WEBSOCKET_LIMITS.closeGraceMs); timer.unref?.();
    socket.once("close", () => clearTimeout(timer));
  }
}


type RegistryIsolation = {
  nodes: unknown[]; tasks: unknown[]; resultReceipts: unknown[];
  nodeIds: Set<string>; taskIds: Set<string>; scopes: Set<string>; eventIds: Set<string>;
  diagnostics: Array<{ collection: string; index: number; reason: string }>;
};
function loadState(statePath: string, isolation: RegistryIsolation): PersistedState {
  if (!fs.existsSync(statePath)) return { schemaVersion: 2, nodes: [], tasks: [] };
  const original = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(original) as PersistedState;
  if (!parsed || parsed.schemaVersion !== 2 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.tasks)
    || (parsed.resultReceipts !== undefined && !Array.isArray(parsed.resultReceipts))) throw new Error("Invalid remote computer registry; original file retained.");
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const isolate = (collection: "nodes" | "tasks" | "resultReceipts", raw: unknown, index: number, reason: string) => {
    isolation[collection].push(raw); isolation.diagnostics.push({ collection, index, reason });
    if (!object(raw)) return;
    if (collection === "nodes") { if (text(raw.nodeId)) isolation.nodeIds.add(raw.nodeId.trim()); }
    else {
      if (text(raw.taskId)) isolation.taskIds.add(raw.taskId.trim());
      if (text(raw.nodeId) && text(raw.idempotencyKey)) isolation.scopes.add(idempotencyScope(raw.nodeId.trim(), raw.idempotencyKey.trim()));
      if (text(raw.eventId)) isolation.eventIds.add(raw.eventId);
    }
  };
  const readRows = <T>(collection: "nodes" | "tasks" | "resultReceipts", rows: unknown[], idField: string,
    normalize: (row: Record<string, unknown>) => T): T[] => {
    const counts = new Map<string, number>();
    for (const row of rows) if (object(row) && text(row[idField])) counts.set(row[idField], (counts.get(row[idField]) ?? 0) + 1);
    const result: T[] = [];
    rows.forEach((row, index) => {
      try {
        if (!object(row) || !text(row[idField])) throw new Error("invalid_record");
        if (counts.get(row[idField]) !== 1) throw new Error("duplicate_identity");
        result.push(normalize(row));
      } catch (error) { isolate(collection, row, index, error instanceof Error && error.message === "duplicate_identity" ? error.message : "invalid_record"); }
    });
    return result;
  };
  const nodes = readRows("nodes", parsed.nodes, "nodeId", row => {
    if (normalizeNodeId(row.nodeId) !== row.nodeId
      || ["version", "platform", "hostname", "name", "remoteAddress", "targetVersion", "lastUpdateError", "taskTargeting"].some(key => row[key] !== undefined && typeof row[key] !== "string")
      || ["agentTypes", "allowedWorkspaces", "terminalShells", "computerCapabilities"].some(key => row[key] !== undefined
        && (!Array.isArray(row[key]) || (row[key] as unknown[]).some(value => typeof value !== "string")))
      || ["connectedAt", "lastSeenAt", "lastUpdateAt"].some(key => row[key] !== undefined && !date(row[key]))
      || row.updateState !== undefined && (typeof row.updateState !== "string" || !["idle", "requested", "updating", "updated", "failed"].includes(row.updateState))
      || row.connected !== undefined && typeof row.connected !== "boolean") throw new Error("invalid_record");
    // Historical rows predate modern Hello fields. Preserve their absence;
    // new connections still pass the complete normalizeHello admission.
    return { ...row, ...(row.agents !== undefined ? { agents: normalizeInstanceAgents(row.agents) } : {}) } as LanAgentNodeStatus;
  });
  const tasks = readRows("tasks", parsed.tasks, "taskId", row => {
    if (!text(row.nodeId) || ["idempotencyKey", "targetAgent", "threadId", "message"].some(key => row[key] !== undefined && !text(row[key]))
      || normalizeNodeId(row.nodeId) !== row.nodeId || row.taskId !== String(row.taskId).trim() || row.idempotencyKey !== undefined && row.idempotencyKey !== String(row.idempotencyKey).trim()
      || ["agentId", "cwd", "result", "error"].some(key => row[key] !== undefined && typeof row[key] !== "string")
      || typeof row.status !== "string" || !["queued", "delivered", "acknowledged", "progress", "completed", "failed", "interrupted"].includes(row.status)
      || !date(row.createdAt) || !date(row.updatedAt)) throw new Error("invalid_record");
    return row as LanAgentTask;
  });
  const resultReceipts = readRows("resultReceipts", parsed.resultReceipts ?? [], "taskId", row => {
    if (!["nodeId", "idempotencyKey"].every(key => text(row[key])) || !terminalTaskStates.has(row.status as LanAgentTaskStatus)
      || normalizeNodeId(row.nodeId) !== row.nodeId || row.taskId !== String(row.taskId).trim() || row.idempotencyKey !== String(row.idempotencyKey).trim()
      || !date(row.createdAt) || !date(row.updatedAt) || !digest(row.assignmentHash) || !digest(row.resultHash)
      || (row.eventId !== undefined && (!text(row.eventId) || !digest(row.payloadHash)))) throw new Error("invalid_record");
    return row as LanAgentResultReceipt;
  });
  // Index the original identities once. A conflicting receipt or scope must not
  // leave another readable row able to replay the same uncertain assignment.
  const rows = [
    ...tasks.map(row => ({ collection: "tasks" as const, row })),
    ...resultReceipts.map(row => ({ collection: "resultReceipts" as const, row }))
  ];
  const tokens = (row: LanAgentTask | LanAgentResultReceipt) => ["task:" + row.taskId, ...(row.idempotencyKey ? ["scope:" + idempotencyScope(row.nodeId, row.idempotencyKey)] : []),
    ...("eventId" in row && row.eventId ? ["event:" + row.eventId] : [])];
  const byToken = new Map<string, typeof rows>();
  for (const entry of rows) for (const token of tokens(entry.row)) {
    const group = byToken.get(token) ?? []; group.push(entry); byToken.set(token, group);
  }
  const pending = [
    ...[...isolation.taskIds].map(id => "task:" + id), ...[...isolation.scopes].map(scope => "scope:" + scope),
    ...[...isolation.eventIds].map(id => "event:" + id)
  ];
  for (const [token, group] of byToken) {
    if (!token.startsWith("task:") && new Set(group.map(entry => entry.row.taskId)).size > 1) pending.push(token);
    if (!token.startsWith("task:") || group.length !== 2) continue;
    const task = group.find(entry => entry.collection === "tasks")?.row as LanAgentTask | undefined;
    const receipt = group.find(entry => entry.collection === "resultReceipts")?.row as LanAgentResultReceipt | undefined;
    if (task && receipt && (task.nodeId !== receipt.nodeId || task.idempotencyKey !== receipt.idempotencyKey
      || task.status !== receipt.status || assignmentHash(task) !== receipt.assignmentHash
      // Rehydrated compacted tasks intentionally lack old result text. Validate
      // actual retained result text, not an invented missing-result default.
      || (task.result !== undefined || task.error !== undefined) && resultHash(task) !== receipt.resultHash)) pending.push(token);
  }
  const excluded = new Set<LanAgentTask | LanAgentResultReceipt>(), visited = new Set<string>();
  const indexes = { tasks: new Map(parsed.tasks.map((row, index) => [row, index])),
    resultReceipts: new Map((parsed.resultReceipts ?? []).map((row, index) => [row, index])) };
  while (pending.length) {
    const token = pending.pop()!;
    if (visited.has(token)) continue; visited.add(token);
    for (const entry of byToken.get(token) ?? []) {
      if (excluded.has(entry.row)) continue; excluded.add(entry.row);
      isolate(entry.collection, entry.row, indexes[entry.collection].get(entry.row as never)!, "conflicting_identity");
      pending.push(...tokens(entry.row));
    }
  }
  const next = { ...parsed, schemaVersion: 2 as const, nodes, tasks: tasks.filter(row => !excluded.has(row)),
    resultReceipts: resultReceipts.filter(row => !excluded.has(row)) };
  const stored = { ...next, nodes: [...next.nodes, ...isolation.nodes], tasks: [...next.tasks, ...isolation.tasks],
    resultReceipts: [...next.resultReceipts, ...isolation.resultReceipts] };
  const changed = JSON.stringify(stored) !== JSON.stringify(parsed);
  if (changed || isolation.diagnostics.length) {
    const backup = isolation.diagnostics.length ? statePath + ".before-record-isolation-" + fingerprint({
      nodes: isolation.nodes.map(value => JSON.stringify(value)).sort(), tasks: isolation.tasks.map(value => JSON.stringify(value)).sort(),
      resultReceipts: isolation.resultReceipts.map(value => JSON.stringify(value)).sort()
    }) + ".json" : statePath + ".before-explicit-sessions-" + randomUUID() + ".json";
    let created = false;
    try { fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (fs.readFileSync(statePath, "utf8") !== original || created && fs.readFileSync(backup,"utf8") !== original) throw new Error("Remote registry migration snapshot changed.");
    if (changed) {
      atomicWriteFileSync(statePath, JSON.stringify(stored) + "\n", { mode: 0o600 });
      if (JSON.stringify(JSON.parse(fs.readFileSync(statePath,"utf8"))) !== JSON.stringify(stored)) { atomicWriteFileSync(statePath, original, { mode: 0o600 }); throw new Error("Remote registry migration verification failed; original restored."); }
    }
  }
  return next;
}

export class LanAgentNodeNameConflictError extends Error {
  constructor() { super("节点名称已被修改，请刷新后重试。"); }
}

export class LanAgentRegistry {
  readonly terminals = new LanAgentTerminals((instanceId, body, assertAuthorized) => {
    if (!this.requireNode(instanceId).terminalShells?.length) throw new Error("This connector does not support remote terminals. Update it first.");
    return this.manageAgent(instanceId, "terminal", body, 45_000, assertAuthorized);
  });
  private readonly connections = new Map<string, Connection>();
  private readonly nodes = new Map<string, LanAgentNodeStatus>();
  private readonly tasks = new Map<string, LanAgentTask>();
  private readonly isolation: RegistryIsolation = { nodes: [], tasks: [], resultReceipts: [], nodeIds: new Set(), taskIds: new Set(),
    scopes: new Set(), eventIds: new Set(), diagnostics: [] };
  private readonly resultReceipts = new Map<string, LanAgentResultReceipt>();
  private readonly resultEvents = new Map<string, string>();
  private readonly completedIdempotency = new Map<string, string>();
  private readonly taskChanges = new EventEmitter();
  private readonly deliveryEvents = new EventEmitter();

  onDeliveryRecoveryEvent(listener: () => void): () => void {
    this.deliveryEvents.on("change", listener);
    return () => this.deliveryEvents.off("change", listener);
  }
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: LAN_AGENT_WEBSOCKET_LIMITS.maxMessageBytes });
  private protocolGuards = new WeakMap<WebSocket, Pick<ApiUpgradeInput, "validateIncoming" | "validateOutgoing" | "signal">>();
  private upgradeInputs = new WeakMap<http.IncomingMessage, ApiUpgradeInput>();
  private upgradeHeadersInstalled = false;
  private readonly statePath: string;
  readonly localInstanceId: string;
  private readonly managementRequests = new Map<string, { connection: Connection; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; operation: string; readOnly: boolean; assertAuthorized?: () => void }>();
  private detachUpgrade: (() => void) | undefined;

  constructor(private readonly options: {
    statePath: string;
    authenticateNode?: (token: string) => { nodeId: string; incarnation?: string } | null;
    nodeEnabled?: (nodeId: string) => boolean;
    currentRelease?: (nodeId: string) => Readonly<{ version: string; releaseDigest: string }>;
  }) {
    this.statePath = path.resolve(options.statePath);
    this.initializeUpgradeHooks();
    const identityPath = path.join(path.dirname(this.statePath), "agent-instance-id.json");
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    try {
      fs.writeFileSync(identityPath, JSON.stringify({ instanceId: randomUUID() }), { flag: "wx", mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.localInstanceId = JSON.parse(fs.readFileSync(identityPath, "utf8")).instanceId;
    if (typeof this.localInstanceId !== "string" || !this.localInstanceId) throw new Error("Invalid local instance identity.");
    const persisted = loadState(this.statePath, this.isolation);
    for (const node of persisted.nodes) this.nodes.set(node.nodeId, { ...node, connected: false });
    for (const task of persisted.tasks) this.tasks.set(task.taskId, task);
    for (const receipt of persisted.resultReceipts ?? []) this.resultReceipts.set(receipt.taskId, receipt);
    for (const task of this.tasks.values()) {
      if (terminalTaskStates.has(task.status) && [task.idempotencyKey, task.targetAgent, task.threadId, task.message].every(value => typeof value === "string" && value.length > 0)
        && !this.resultReceipts.has(task.taskId)) this.resultReceipts.set(task.taskId, receiptForTask(task));
    }
    for (const receipt of this.resultReceipts.values()) {
      this.completedIdempotency.set(idempotencyScope(receipt.nodeId, receipt.idempotencyKey), receipt.taskId);
      if (receipt.eventId) this.resultEvents.set(receipt.eventId, receipt.taskId);
    }
  }

  private initializeUpgradeHooks(): void {
    // Existing native instances predate these fields. Their original sockets stay
    // owned by the native registry until listener/facade migration is verified.
    this.protocolGuards ??= new WeakMap(); this.upgradeInputs ??= new WeakMap();
    if (this.upgradeHeadersInstalled) return;
    this.wss.on("headers", (headers, request) => {
      const input = this.upgradeInputs.get(request);
      if (input) input.prepareHandshake(Object.fromEntries(headers.slice(1).map(line => {
        const separator = line.indexOf(":"); return [line.slice(0, separator), line.slice(separator + 1).trim()];
      })));
    });
    this.upgradeHeadersInstalled = true;
  }

  /** Compatibility adapter for standalone owners/tests; production registers this operation in core. */
  attach(server: http.Server, options: LanAgentConnectionOptions): () => void {
    this.detachUpgrade?.();
    const routes = new ManagerPluginRouteRegistry();
    const registration = routes.registerUpgrades("standalone-lan-agent", [createLanAgentConnectionOperation(this, options)]);
    const listener = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      try { routes.handleUpgrade(request, new URL(request.url || "/", "http://manager.invalid"), socket, head); }
      catch { socket.destroy(); }
    };
    server.on("upgrade", listener);
    this.detachUpgrade = () => { server.off("upgrade", listener); registration.stopAccepting(); this.detachUpgrade = undefined; };
    return this.detachUpgrade;
  }

  async upgradeConnection(input: ApiUpgradeInput, options: LanAgentConnectionOptions): Promise<void> {
    this.initializeUpgradeHooks();
    input.assertCurrent();
    if (!options.enabled() || (!this.options.authenticateNode && !options.getToken().trim())) {
      input.reject(401, { code: -1, message: "LAN Agent connection is disabled or has no existing credential authority." }); return;
    }
    await new Promise<void>((resolve, reject) => {
      const closed = () => { cleanup(); resolve(); };
      const cleanup = () => { input.socket.off("close", closed); this.upgradeInputs.delete(input.request); };
      input.socket.once("close", closed);
      try {
        input.assertCurrent();
        this.upgradeInputs.set(input.request, input);
        this.wss.handleUpgrade(input.request, input.socket, Buffer.from(input.head), websocket => {
          cleanup();
          let settled!: () => void;
          const complete = new Promise<void>(done => { settled = done; });
          websocket.once("close", () => { this.protocolGuards?.delete(websocket); queueMicrotask(settled); });
          this.protocolGuards.set(websocket, input);
          input.accept({ closed: complete, close: async reason => { closeSocket(websocket, 1001, reason); await complete; } });
          this.bindSocket(websocket, normalizedRemoteAddress(input.request.socket.remoteAddress), options.getToken);
          resolve();
        });
      } catch (error) { cleanup(); reject(error); }
    });
  }

  listNodes(): LanAgentNodeStatus[] {
    return [...this.nodes.values()]
      .map(node => ({ ...structuredClone(node), connected: this.connections.get(node.nodeId)?.socket.readyState === WebSocket.OPEN }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  storageDiagnostics(): ReadonlyArray<Readonly<{ collection: string; index: number; reason: string }>> {
    return this.isolation.diagnostics.map(item => ({ ...item }));
  }

  getNode(nodeId: string): LanAgentNodeStatus | undefined {
    const node = this.nodes.get(nodeId);
    return node ? structuredClone(node) : undefined;
  }

  listTasks(limit = 100): LanAgentTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(task => ({ ...task }));
  }

  listInstances(localAgents: InstanceAgent[] = []): AgentInstance[] {
    return [{ instanceId: this.localInstanceId, local: true, connected: true, agents: localAgents }, ...this.listNodes().map(node => ({
      instanceId: node.nodeId, name: node.name, hostname: node.hostname, local: false, enabled: this.options.nodeEnabled?.(node.nodeId) ?? true, address: node.remoteAddress, connected: node.connected, version: node.version,
      agents: (node.agents ?? []).map(agent => ({ ...agent, enabled: agent.enabled }))
    }))];
  }

  getInstanceAgent(instanceId: string, agentId: string): InstanceAgent | undefined {
    const agent = this.nodes.get(instanceId)?.agents?.find(agent => agent.agentId === agentId);
    return agent ? { ...agent } : undefined;
  }

  setNodeName(nodeId: string, name: unknown, expectedName: string): LanAgentNodeStatus {
    const node = this.requireNode(nodeId);
    if ((node.name ?? "") !== expectedName) throw new LanAgentNodeNameConflictError();
    if (typeof name !== "string" || name.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error("节点名称须为不超过 80 个字符的单行文字。");
    }
    const next = { ...node, name: name.trim() || undefined };
    this.nodes.set(nodeId, next);
    try { this.persist(); }
    catch (error) { this.nodes.set(nodeId, node); throw error; }
    recordDataMutationAudit({
      group: "lan-agent", event: "lan_agent_node_name_changed", owner: "lan-agent-registry",
      action: "set-node-name", target: { type: "lan-agent-node", id: nodeId },
      dataSource: { kind: "file", id: "lan-agent/registry.json" }, outcome: "committed",
      changes: [{ field: "name", from: node.name ?? "", to: next.name ?? "" }]
    });
    return structuredClone(next);
  }

  manageAgent(instanceId: string, operation: string, params: unknown, timeoutMs = getTimeoutMs("agent.remote.management", 15000), assertAuthorized?: () => void): Promise<unknown> {
    if (this.options.nodeEnabled?.(instanceId) === false) throw new Error("Remote instance is disabled.");
    assertAuthorized?.();
    let connection: Connection;
    try { connection = this.requireConnection(instanceId); }
    catch (cause) {
      throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), {
        code: "LAN_AGENT_MANAGEMENT_NOT_SENT", deliveryFrameSent: false, instanceId, operation
      });
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.managementRequests.delete(requestId); reject(new Error("Instance management timed out; refresh before retrying a change.")); }, timeoutMs);
      const action = params && typeof params === "object" ? (params as Record<string, unknown>).action : undefined;
      const readOnly = operation === "scan" || operation === "threads" && ["read", "list"].includes(String(action ?? "list"));
      this.managementRequests.set(requestId, { connection, resolve, reject, timer, operation, readOnly, assertAuthorized });
      try { assertAuthorized?.(); this.send(connection.socket, { type: "manageAgent", requestId, operation, params }); }
      catch (error) { clearTimeout(timer); this.managementRequests.delete(requestId); reject(error); }
    });
  }

  async waitForTaskAcceptance(taskId: string, timeoutMs = getTimeoutMs("agent.remote.acceptance", 12000)): Promise<LanAgentTask> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        const task = this.tasks.get(taskId);
        if (!task) { cleanup(); reject(new Error("Remote Agent task does not exist.")); return; }
        if (["failed", "interrupted"].includes(task.status)) { cleanup(); reject(new Error(task.error || "Remote Agent rejected the message.")); }
        else if (["progress", "completed"].includes(task.status)) { cleanup(); resolve({ ...task }); }
      };
      const cleanup = (): void => { clearTimeout(timer); this.taskChanges.off(taskId, finish); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Remote Agent has not confirmed acceptance yet. Check the existing task record before retrying.")); }, timeoutMs);
      this.taskChanges.on(taskId, finish);
      finish();
    });
  }

  requestUpdate(nodeId: string, version: string, assertAuthorized?: () => void): LanAgentNodeStatus {
    assertAuthorized?.();
    const connection = this.requireConnection(nodeId);
    const node = this.requireNode(nodeId);
    const targetVersion = version.trim();
    if (!targetVersion || targetVersion.length > 80) throw new Error("Rabi Agent update version is required.");
    const next = { ...node, targetVersion, updateState: "requested" as const, lastUpdateAt: nowIso(), lastUpdateError: undefined };
    this.nodes.set(nodeId, next);
    this.persist();
    assertAuthorized?.();
    this.send(connection.socket, { type: "updateAvailable", version: targetVersion });
    return { ...next, connected: true };
  }

  assignTask(input: { nodeId: string; targetAgent: string; agentId?: string; threadId: string; message: string; cwd?: string; taskId?: string; idempotencyKey?: string }, assertAuthorized?: () => void): LanAgentTask {
    assertAuthorized?.();
    const nodeId = normalizeNodeId(input.nodeId);
    if (this.isolation.nodeIds.has(nodeId) || (input.taskId && this.isolation.taskIds.has(input.taskId.trim()))
      || (input.idempotencyKey && this.isolation.scopes.has(idempotencyScope(nodeId, input.idempotencyKey.trim())))) {
      throw new Error("Original remote assignment evidence is isolated; repair its retained record before retrying this identity.");
    }
    const targetAgent = typeof input.targetAgent === "string" ? input.targetAgent.trim() : "";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    if (!targetAgent || targetAgent.length > 80) throw new Error("Rabi Agent task targetAgent is required.");
    if (typeof input.threadId !== "string" || !input.threadId || input.threadId !== input.threadId.trim()
      || input.threadId.length > 4096 || /[\0\r\n\u2028\u2029]/u.test(input.threadId)) throw new Error("Explicit full threadId is required; query the Agent thread list.");
    if (!message) throw new Error("Rabi Agent task message is required.");
    const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : randomUUID();
    const existing = [...this.tasks.values()].find(task => task.nodeId === nodeId && task.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.targetAgent !== targetAgent || existing.agentId !== input.agentId || existing.threadId !== input.threadId || existing.message !== message || existing.cwd !== cwd) throw new Error("Remote Agent idempotency key was already used for a different message.");
      return { ...existing };
    }
    const completedTaskId = this.completedIdempotency.get(idempotencyScope(nodeId, idempotencyKey));
    const completed = completedTaskId ? this.resultReceipts.get(completedTaskId) : undefined;
    if (completed) {
      if (completed.assignmentHash !== assignmentHash({ targetAgent, agentId: input.agentId, threadId: input.threadId, message, cwd })) {
        throw new Error("Remote Agent idempotency key was already used for a different message.");
      }
      const restored: LanAgentTask = { taskId: completed.taskId, idempotencyKey, nodeId, targetAgent, agentId: input.agentId, threadId: input.threadId,
        message, cwd, status: completed.status, createdAt: completed.createdAt, updatedAt: completed.updatedAt };
      // Rehydrate proven assignment details for existing acceptance readers; this never dispatches or changes the receipt.
      this.tasks.set(completed.taskId, restored);
      return { ...restored };
    }
    if (input.taskId && (this.tasks.has(input.taskId.trim()) || this.resultReceipts.has(input.taskId.trim()))) throw new Error("Remote task ID already belongs to an original assignment.");
    if (this.options.nodeEnabled?.(nodeId) === false) throw new Error("Remote instance is disabled.");
    const connection = this.requireConnection(nodeId);
    if (this.requireNode(nodeId).taskTargeting !== "explicit-session-v1") {
      throw new Error("Upgrade the remote connector: explicit-session-v1 task targeting is required; the configured session will not be used as a fallback.");
    }

    if (!this.requireNode(nodeId).agentTypes?.includes(targetAgent)) throw new Error("The selected remote node does not support the requested Agent.");
    const now = nowIso();
    const task: LanAgentTask = {
      taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : randomUUID(),
      idempotencyKey,
      nodeId,
      targetAgent,
      agentId: input.agentId,
      threadId: input.threadId,
      message,
      cwd,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    if (this.tasks.has(task.taskId) || this.resultReceipts.has(task.taskId)) throw new Error("Remote Agent taskId already belongs to an existing assignment.");
    this.tasks.set(task.taskId, task);
    try { this.persist(); } catch (error) { this.tasks.delete(task.taskId); throw error; }
    assertAuthorized?.();
    this.send(connection.socket, { type: "assignTask", task });
    this.patchTask(task.taskId, { status: "delivered" });
    return { ...(this.tasks.get(task.taskId) ?? task) };
  }

  close(): void {
    for (const pending of this.managementRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Manager is stopping.")); }
    this.managementRequests.clear();
    this.detachUpgrade?.();
    for (const connection of this.connections.values()) {
      if (connection.nodeId) this.terminals.disconnect(connection.nodeId);
      clearTimeout(connection.authenticationTimer);
      closeSocket(connection.socket, 1001, "Manager is stopping.");
    }
    for (const socket of this.wss.clients) closeSocket(socket, 1001, "Manager is stopping.");
    this.connections.clear();
    this.persist();
    this.wss.close();
  }

  private bindSocket(socket: WebSocket, remoteAddress: string | undefined, getToken: () => string): void {
    let connection: Connection | undefined;
    const authenticationTimer = setTimeout(() => {
      if (!connection?.authenticated) closeSocket(socket, 1008, "Rabi Agent authentication timed out.");
    }, LAN_AGENT_WEBSOCKET_LIMITS.authenticationMs);
    authenticationTimer.unref?.();
    connection = { socket, authenticated: false, authenticationTimer };
    socket.on("message", data => {
      const message = parseMessage(data);
      if (!message) {
        closeSocket(socket, 1003, "Rabi Agent messages must be JSON objects.");
        return;
      }
      try {
        this.protocolGuards?.get(socket)?.validateIncoming(message, Buffer.isBuffer(data) ? data.byteLength
          : Array.isArray(data) ? data.reduce((size, item) => size + item.byteLength, 0) : data.byteLength);
        this.handleMessage(connection!, message, getToken, remoteAddress);
      } catch (error) {
        try { this.send(socket, { type: "error", error: error instanceof Error ? error.message : String(error) }); }
        catch { socket.terminate(); }
      }
    });
    socket.on("close", () => {
      for (const [id, pending] of this.managementRequests) {
        if (pending.connection === connection) { clearTimeout(pending.timer); pending.reject(new Error("Instance disconnected during management.")); this.managementRequests.delete(id); }
      }
      clearTimeout(authenticationTimer);
      const nodeId = connection?.nodeId;
      if (nodeId && this.connections.get(nodeId) === connection) {
        this.terminals.disconnect(nodeId);
        this.connections.delete(nodeId);
        const existing = this.nodes.get(nodeId);
        if (existing) {
          this.nodes.set(nodeId, { ...existing, connected: false, lastSeenAt: nowIso() });
          this.persist();
        }
      }
    });
    socket.on("error", () => undefined);
  }

  private handleMessage(connection: Connection, message: Record<string, unknown>, getToken: () => string, remoteAddress: string | undefined): void {
    const type = typeof message.type === "string" ? message.type : "";
    if (!connection.authenticated) {
      const token = typeof message.token === "string" ? message.token.trim() : "";
      const identity = this.options.authenticateNode?.(token);
      const accepted = this.options.authenticateNode ? Boolean(identity) : webguiTokenMatches(token, getToken().trim());
      if (type !== "authenticate" || !accepted) {
        closeSocket(connection.socket, 1008, "Rabi Agent authentication failed.");
        return;
      }
      connection.authenticated = true;
      connection.credential = token;
      connection.authenticatedNodeId = identity?.nodeId;
      connection.authenticatedNodeIncarnation = identity?.incarnation;
      this.send(connection.socket, { type: "authenticated", managerTime: nowIso() });
      return;
    }
    if (!this.connectionAuthorityCurrent(connection)) {
      closeSocket(connection.socket, 1008, "Node credential was revoked.");
      return;
    }
    if (!connection.nodeId) {
      if (type !== "hello") throw new Error("Rabi Agent must send hello after authentication.");
      const hello = normalizeHello(message.node);
      if (this.isolation.nodeIds.has(hello.nodeId)) throw new Error("Original remote node identity is isolated; repair its retained record before reconnecting this identity.");
      if (this.options.authenticateNode && hello.nodeId !== connection.authenticatedNodeId) {
        closeSocket(connection.socket, 1008, "Node identity does not match its credential.");
        return;
      }
      const previous = this.connections.get(hello.nodeId);
      if (previous && previous.socket !== connection.socket) {
        this.terminals.disconnect(hello.nodeId);
        clearTimeout(previous.authenticationTimer);
        closeSocket(previous.socket, 4000, "A newer connection uses this nodeId.");
      }
      const previousStatus = this.nodes.get(hello.nodeId);
      const status: LanAgentNodeStatus = {
        ...hello,
        hostname: hello.hostname || previousStatus?.hostname,
        name: previousStatus?.name,
        connected: true,
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
        remoteAddress,
        targetVersion: previousStatus?.targetVersion,
        updateState: previousStatus?.updateState ?? "idle",
        lastUpdateAt: previousStatus?.lastUpdateAt,
        lastUpdateError: previousStatus?.lastUpdateError
      };
      connection.nodeId = hello.nodeId;
      this.connections.set(hello.nodeId, connection);
      this.nodes.set(hello.nodeId, status);
      clearTimeout(connection.authenticationTimer);
      this.persist();
      let release: Readonly<{ version: string; releaseDigest: string }> | undefined;
      try { release = this.options.currentRelease?.(hello.nodeId); } catch { /* Keep the connection available if release publication is unavailable. */ }
      this.send(connection.socket, { type: "connected", nodeId: hello.nodeId, managerTime: nowIso(), ...(release ? { release } : {}) });
      this.deliveryEvents.emit("change");
      return;
    }
    const node = this.requireNode(connection.nodeId);
    if (this.connections.get(connection.nodeId) !== connection) throw new Error("Instance connection was replaced.");
    if (type === "terminalEvent") {
      if (message.event && typeof message.event === "object") this.terminals.receive(connection.nodeId, message.event as Record<string, unknown>);
      return;
    }
    this.nodes.set(connection.nodeId, { ...node, connected: true, lastSeenAt: nowIso() });
    if (type === "managementResult") {
      const id = typeof message.requestId === "string" ? message.requestId : "";
      const pending = this.managementRequests.get(id);
      if (!pending || pending.connection !== connection) return;
      clearTimeout(pending.timer);
      this.managementRequests.delete(id);
      try { pending.assertAuthorized?.(); } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); return; }
      if (message.error) pending.reject(new Error(String(message.error).slice(0, 1024)));
      else pending.resolve(message.result);
      const noFrameResult = pending.operation === "prepared_delivery" && message.result && typeof message.result === "object"
        && (message.result as { status?: unknown }).status === "not_sent";
      if (!noFrameResult && !pending.readOnly && !["reconcile_prepared_delivery", "delivery_records", "terminal", "computer"].includes(pending.operation)) this.deliveryEvents.emit("change");
      return;
    }
    if (type === "agentCatalog") {
      const agents = normalizeInstanceAgents(message.agents);
      this.nodes.set(connection.nodeId, { ...this.requireNode(connection.nodeId), agents });
      this.persist();
      this.deliveryEvents.emit("change");
      return;
    }
    if (type === "heartbeat") {
      this.persist();
      return;
    }
    const taskId = typeof message.taskId === "string" ? message.taskId.trim() : "";
    if (type === "ackTask") {
      this.patchOwnedTask(connection, taskId, { status: "acknowledged" });
      return;
    }
    if (type === "progress") {
      this.patchOwnedTask(connection, taskId, {
        status: "progress",
        result: typeof message.summary === "string" ? message.summary.slice(0, 12_000) : undefined
      });
      return;
    }
    if (type === "taskResult") {
      try { this.receiveTaskResult(connection, taskId, message); }
      catch (error) { this.nodes.set(connection.nodeId, node); throw error; }
      return;
    }
    if (type === "updateResult") {
      const state: LanAgentUpdateState = message.status === "updated"
        ? "updated"
        : message.status === "updating"
          ? "updating"
          : "failed";
      this.nodes.set(connection.nodeId, {
        ...this.requireNode(connection.nodeId),
        updateState: state,
        lastUpdateAt: nowIso(),
        lastUpdateError: state === "failed" ? (typeof message.error === "string" ? message.error.slice(0, 1_024) : "Rabi Agent update failed.") : undefined
      });
      this.persist();
      return;
    }
    throw new Error(`Unsupported Rabi Agent message type: ${type || "missing"}.`);
  }

  private patchOwnedTask(connection: Connection, taskId: string, patch: Partial<Pick<LanAgentTask, "status" | "result" | "error">>): void {
    const task = this.tasks.get(taskId) ?? this.resultReceipts.get(taskId);
    if (!task) throw new Error(`Rabi Agent task was not found: ${taskId}`);
    if (task.nodeId !== connection.nodeId) throw new Error(`Rabi Agent node ${connection.nodeId ?? "unknown"} does not own task ${taskId}.`);
    if (!terminalTaskStates.has(task.status)) this.patchTask(taskId, patch);
  }

  private receiveTaskResult(connection: Connection, taskId: string, message: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    const previousReceipt = this.resultReceipts.get(taskId);
    const owner = task ?? previousReceipt;
    if (!owner) throw new Error(`Rabi Agent task was not found: ${taskId}`);
    if (owner.nodeId !== connection.nodeId) throw new Error(`Rabi Agent node ${connection.nodeId ?? "unknown"} does not own task ${taskId}.`);
    const eventId = message.eventId;
    if (this.isolation.taskIds.has(taskId) || typeof eventId === "string" && this.isolation.eventIds.has(eventId)) {
      throw new Error("Original remote result evidence is isolated; repair its retained record before confirming this event.");
    }
    if (eventId !== undefined && (typeof eventId !== "string" || !eventId || eventId !== eventId.trim()
      || eventId.length > 200 || /[\u0000-\u001f\u007f]/u.test(eventId))) throw new Error("Invalid taskResult eventId.");
    if (eventId !== undefined && !["completed", "failed", "interrupted"].includes(String(message.status))) throw new Error("Invalid taskResult terminal status.");
    const status = message.status === "completed" || message.status === "interrupted" ? message.status : "failed";
    const summary = typeof message.summary === "string" ? message.summary : undefined;
    const error = typeof message.error === "string" ? message.error : undefined;
    const payloadHash = fingerprint({ taskId, status, summary, error });
    const patch: Pick<LanAgentTask, "status" | "result" | "error"> = { status, result: summary?.slice(0, 12_000), error: error?.slice(0, 12_000) };
    if (typeof eventId === "string") {
      const eventTask = this.resultEvents.get(eventId);
      if (eventTask && eventTask !== taskId) throw new Error("taskResult eventId conflicts with its original task or node.");
      if (previousReceipt?.eventId) {
        if (previousReceipt.eventId !== eventId || previousReceipt.payloadHash !== payloadHash) throw new Error("taskResult eventId or payload conflicts with the committed result.");
        this.send(connection.socket, { type: "resultAck", eventId, taskId });
        return;
      }
    }
    if (previousReceipt && previousReceipt.resultHash !== resultHash(patch)) throw new Error("A committed terminal task result cannot be replaced.");
    // Old connectors get their existing single-write behavior, without claiming a durable result ACK.
    if (previousReceipt && eventId === undefined) return;
    const next = previousReceipt ? task : { ...task!, ...patch, updatedAt: nowIso() };
    const receipt = { ...(previousReceipt ?? receiptForTask(next!)), ...(typeof eventId === "string" ? { eventId, payloadHash } : {}) };
    if (next) this.tasks.set(taskId, next);
    this.resultReceipts.set(taskId, receipt);
    this.completedIdempotency.set(idempotencyScope(receipt.nodeId, receipt.idempotencyKey), taskId);
    if (typeof eventId === "string") this.resultEvents.set(eventId, taskId);
    try { this.persist(); }
    catch (failure) {
      if (task) this.tasks.set(taskId, task); else this.tasks.delete(taskId);
      if (previousReceipt) this.resultReceipts.set(taskId, previousReceipt); else {
        this.resultReceipts.delete(taskId); this.completedIdempotency.delete(idempotencyScope(receipt.nodeId, receipt.idempotencyKey));
      }
      if (typeof eventId === "string") this.resultEvents.delete(eventId);
      throw failure;
    }
    if (!previousReceipt) { this.taskChanges.emit(taskId); this.deliveryEvents.emit("change"); }
    // Once persisted, a lost socket ACK is recovered by an identical event on the original node.
    if (typeof eventId === "string") this.send(connection.socket, { type: "resultAck", eventId, taskId });
  }

  private patchTask(taskId: string, patch: Partial<Pick<LanAgentTask, "status" | "result" | "error">>): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Rabi Agent task was not found: ${taskId}`);
    if (terminalTaskStates.has(task.status)) return;
    this.tasks.set(taskId, { ...task, ...patch, updatedAt: nowIso() });
    try { this.persist(); } catch (error) { this.tasks.set(taskId, task); throw error; }
    this.taskChanges.emit(taskId);
    this.deliveryEvents.emit("change");
  }

  private requireNode(nodeId: string): LanAgentNodeStatus {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Rabi Agent node is not known: ${nodeId}`);
    return node;
  }

  private requireConnection(nodeId: string): Connection {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Rabi Agent node is not connected: ${nodeId}`);
    }
    if (!this.connectionAuthorityCurrent(connection)) {
      closeSocket(connection.socket, 1008, "Node credential was revoked.");
      throw new Error("Rabi Agent node credential was revoked.");
    }
    return connection;
  }

  private connectionAuthorityCurrent(connection: Connection): boolean {
    if (!this.options.authenticateNode) return true;
    const identity = this.options.authenticateNode(connection.credential ?? "");
    return identity?.nodeId === connection.authenticatedNodeId
      && (connection.authenticatedNodeIncarnation === undefined || identity?.incarnation === connection.authenticatedNodeIncarnation);
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Rabi Agent WebSocket is not open.");
    if (this.protocolGuards?.get(socket)?.signal.aborted) { closeSocket(socket, 1001, "Connection retiring."); return; }
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json);
    this.protocolGuards?.get(socket)?.validateOutgoing(payload, bytes);
    if (socket.bufferedAmount + bytes > LAN_AGENT_WEBSOCKET_LIMITS.maxBufferedBytes) {
      socket.terminate(); throw new Error("LAN Agent connection buffered-byte capacity exceeded; inspect original task state before retrying.");
    }
    socket.send(json);
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tasks = [...this.tasks.values()];
    const retained = tasks.filter(task => !terminalTaskStates.has(task.status) || !this.resultReceipts.has(task.taskId));
    retained.push(...tasks.filter(task => terminalTaskStates.has(task.status) && this.resultReceipts.has(task.taskId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, completedTaskHistoryLimit));
    const state = { schemaVersion: 2, nodes: [...this.listNodes(), ...this.isolation.nodes], tasks: [...retained, ...this.isolation.tasks],
      resultReceipts: [...this.resultReceipts.values(), ...this.isolation.resultReceipts] };
    try {
      atomicWriteFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "lan-agent",
        event: "lan_agent_registry_write_failed",
        owner: "lan-agent-registry",
        action: "persist-state",
        target: { type: "lan-agent-registry", id: "registry" },
        dataSource: { kind: "file", id: "lan-agent/registry.json" },
        outcome: "failed",
        error
      });
      throw error;
    }
    recordDataMutationAudit({
      group: "lan-agent",
      event: "lan_agent_registry_written",
      owner: "lan-agent-registry",
      action: "persist-state",
      target: { type: "lan-agent-registry", id: "registry" },
      dataSource: { kind: "file", id: "lan-agent/registry.json" },
      outcome: "committed",
      changes: [
        { field: "nodeCount", to: state.nodes.length },
        { field: "taskCount", to: state.tasks.length }
      ]
    });
  }
}
