import fs from "node:fs";
import type http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { webguiTokenMatches } from "./webguiLanAccess.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type LanAgentNodeHello = {
  nodeId: string;
  version: string;
  platform: string;
  agentTypes?: string[];
  allowedWorkspaces?: string[];
};

export type LanAgentUpdateState = "idle" | "requested" | "updating" | "updated" | "failed";

export type LanAgentNodeStatus = LanAgentNodeHello & {
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
};

type Connection = {
  socket: WebSocket;
  nodeId?: string;
  authenticated: boolean;
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
  const platform = typeof raw.platform === "string" ? raw.platform.trim() : "";
  if (!version || version.length > 80) throw new Error("Rabi Agent version is required.");
  if (!platform || platform.length > 80) throw new Error("Rabi Agent platform is required.");
  return {
    nodeId: normalizeNodeId(raw.nodeId),
    version,
    platform,
    agentTypes: normalizeTextList(raw.agentTypes, 16, 80),
    allowedWorkspaces: normalizeTextList(raw.allowedWorkspaces, 32, 1_024)
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
  }
}

function rejectUpgrade(socket: Socket, statusCode: number, message: string): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}

function loadState(statePath: string): PersistedState {
  if (!fs.existsSync(statePath)) return { schemaVersion: 2, nodes: [], tasks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<PersistedState>;
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter((item): item is LanAgentNodeStatus => Boolean(item && typeof item === "object" && typeof item.nodeId === "string")) : [];
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter((item): item is LanAgentTask => Boolean(item && typeof item === "object" && typeof item.taskId === "string")) : [];
    return { schemaVersion: 2, nodes, tasks };
  } catch {
    return { schemaVersion: 2, nodes: [], tasks: [] };
  }
}

export class LanAgentRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly nodes = new Map<string, LanAgentNodeStatus>();
  private readonly tasks = new Map<string, LanAgentTask>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly statePath: string;
  private detachUpgrade: (() => void) | undefined;

  constructor(options: { statePath: string }) {
    this.statePath = path.resolve(options.statePath);
    const persisted = loadState(this.statePath);
    for (const node of persisted.nodes.slice(-500)) this.nodes.set(node.nodeId, { ...node, connected: false });
    for (const task of persisted.tasks.slice(-500)) this.tasks.set(task.taskId, task);
  }

  attach(server: http.Server, options: { getToken: () => string; enabled: () => boolean }): () => void {
    this.detachUpgrade?.();
    const onUpgrade = (request: http.IncomingMessage, socket: Socket, head: Buffer): void => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (requestUrl.pathname !== "/api/lan-agent/connect") return;
      if (!options.enabled() || !options.getToken().trim()) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      this.wss.handleUpgrade(request, socket, head, websocket => {
        this.bindSocket(websocket, normalizedRemoteAddress(request.socket.remoteAddress), options.getToken);
      });
    };
    server.on("upgrade", onUpgrade);
    this.detachUpgrade = () => {
      server.off("upgrade", onUpgrade);
      this.detachUpgrade = undefined;
    };
    return this.detachUpgrade;
  }

  listNodes(): LanAgentNodeStatus[] {
    return [...this.nodes.values()]
      .map(node => ({ ...node, connected: this.connections.get(node.nodeId)?.socket.readyState === WebSocket.OPEN }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  listTasks(limit = 100): LanAgentTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(task => ({ ...task }));
  }

  requestUpdate(nodeId: string, version: string): LanAgentNodeStatus {
    const connection = this.requireConnection(nodeId);
    const node = this.requireNode(nodeId);
    const targetVersion = version.trim();
    if (!targetVersion || targetVersion.length > 80) throw new Error("Rabi Agent update version is required.");
    const next = { ...node, targetVersion, updateState: "requested" as const, lastUpdateAt: nowIso(), lastUpdateError: undefined };
    this.nodes.set(nodeId, next);
    this.persist();
    this.send(connection.socket, { type: "updateAvailable", version: targetVersion });
    return { ...next, connected: true };
  }

  assignTask(input: { nodeId: string; targetAgent: string; message: string; cwd?: string; taskId?: string; idempotencyKey?: string }): LanAgentTask {
    const nodeId = normalizeNodeId(input.nodeId);
    const targetAgent = typeof input.targetAgent === "string" ? input.targetAgent.trim() : "";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    if (!targetAgent || targetAgent.length > 80) throw new Error("Rabi Agent task targetAgent is required.");
    if (!message) throw new Error("Rabi Agent task message is required.");
    const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : randomUUID();
    const existing = [...this.tasks.values()].find(task => task.nodeId === nodeId && task.idempotencyKey === idempotencyKey);
    if (existing) return { ...existing };
    const connection = this.requireConnection(nodeId);
    const now = nowIso();
    const task: LanAgentTask = {
      taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : randomUUID(),
      idempotencyKey,
      nodeId,
      targetAgent,
      message,
      cwd,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(task.taskId, task);
    this.persist();
    this.send(connection.socket, { type: "assignTask", task });
    this.patchTask(task.taskId, { status: "delivered" });
    return { ...(this.tasks.get(task.taskId) ?? task) };
  }

  close(): void {
    this.detachUpgrade?.();
    for (const connection of this.connections.values()) {
      clearTimeout(connection.authenticationTimer);
      closeSocket(connection.socket, 1001, "Manager is stopping.");
    }
    this.connections.clear();
    this.persist();
    this.wss.close();
  }

  private bindSocket(socket: WebSocket, remoteAddress: string | undefined, getToken: () => string): void {
    let connection: Connection | undefined;
    const authenticationTimer = setTimeout(() => {
      if (!connection?.authenticated) closeSocket(socket, 1008, "Rabi Agent authentication timed out.");
    }, 10_000);
    authenticationTimer.unref?.();
    connection = { socket, authenticated: false, authenticationTimer };
    socket.on("message", data => {
      const message = parseMessage(data);
      if (!message) {
        closeSocket(socket, 1003, "Rabi Agent messages must be JSON objects.");
        return;
      }
      try {
        this.handleMessage(connection!, message, getToken, remoteAddress);
      } catch (error) {
        this.send(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      const nodeId = connection?.nodeId;
      if (nodeId && this.connections.get(nodeId) === connection) {
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
      if (type !== "authenticate" || !webguiTokenMatches(typeof message.token === "string" ? message.token.trim() : "", getToken().trim())) {
        closeSocket(connection.socket, 1008, "Rabi Agent authentication failed.");
        return;
      }
      connection.authenticated = true;
      this.send(connection.socket, { type: "authenticated", managerTime: nowIso() });
      return;
    }
    if (!connection.nodeId) {
      if (type !== "hello") throw new Error("Rabi Agent must send hello after authentication.");
      const hello = normalizeHello(message.node);
      const previous = this.connections.get(hello.nodeId);
      if (previous && previous.socket !== connection.socket) {
        clearTimeout(previous.authenticationTimer);
        closeSocket(previous.socket, 4000, "A newer connection uses this nodeId.");
      }
      const previousStatus = this.nodes.get(hello.nodeId);
      const status: LanAgentNodeStatus = {
        ...hello,
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
      this.send(connection.socket, { type: "connected", nodeId: hello.nodeId, managerTime: nowIso() });
      return;
    }
    const node = this.requireNode(connection.nodeId);
    this.nodes.set(connection.nodeId, { ...node, connected: true, lastSeenAt: nowIso() });
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
      const status = message.status === "completed" || message.status === "failed" ? message.status : "failed";
      this.patchOwnedTask(connection, taskId, {
        status,
        result: typeof message.summary === "string" ? message.summary.slice(0, 12_000) : undefined,
        error: typeof message.error === "string" ? message.error.slice(0, 12_000) : undefined
      });
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
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Rabi Agent task was not found: ${taskId}`);
    if (task.nodeId !== connection.nodeId) throw new Error(`Rabi Agent node ${connection.nodeId ?? "unknown"} does not own task ${taskId}.`);
    this.patchTask(taskId, patch);
  }

  private patchTask(taskId: string, patch: Partial<Pick<LanAgentTask, "status" | "result" | "error">>): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Rabi Agent task was not found: ${taskId}`);
    this.tasks.set(taskId, { ...task, ...patch, updatedAt: nowIso() });
    this.persist();
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
    return connection;
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Rabi Agent WebSocket is not open.");
    socket.send(JSON.stringify(payload));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const state: PersistedState = { schemaVersion: 2, nodes: this.listNodes(), tasks: this.listTasks(500) };
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.statePath);
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
