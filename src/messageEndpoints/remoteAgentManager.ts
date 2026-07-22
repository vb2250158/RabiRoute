import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type { MessageContextAttachment, MessageContextRecord } from "../messageContextStore.js";

export const REMOTE_AGENT_CONTROL_PORT_START = 8797;
export const REMOTE_AGENT_DISCOVERY_PORT_START = 8798;
export const REMOTE_AGENT_DISCOVERY_PORT_END = 8818;
export const REMOTE_AGENT_PROTOCOL_VERSION = 3;
export const REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES = Number(process.env.REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES || 10 * 1024 * 1024);
export const REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES = Number(process.env.REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES || 25 * 1024 * 1024);

export type RemoteAgentDeviceInfo = {
  deviceId: string;
  deviceName?: string;
  agentType?: string;
  os?: string;
  osVersion?: string;
  arch?: string;
  declaredIp?: string;
  defaultCwd?: string;
  defaultThreadName?: string;
};

export type RemoteAgentTaskRequest = {
  deviceId?: string;
  message?: string;
  text?: string;
  taskKind?: string;
  cwd?: string;
  threadName?: string;
  filePaths?: string[];
  files?: RemoteAgentFileTransfer[];
  attachments?: Array<RemoteAgentFileTransfer | { path?: string; name?: string; kind?: string }>;
  originGatewayId?: string;
  gatewayId?: string;
  originReplyContext?: Record<string, unknown>;
};

export type RemoteAgentFileTransfer = {
  name: string;
  relativePath?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  contentBase64?: string;
};

export type RemoteAgentTaskEvent = {
  taskId?: string;
  status?: "queued" | "delivered" | "started" | "progress" | "completed" | "failed";
  summary?: string;
  message?: string;
  artifactPath?: string;
  logPath?: string;
  files?: RemoteAgentFileTransfer[];
  savedFiles?: RemoteAgentFileTransfer[];
  error?: string;
  data?: unknown;
  device?: Partial<RemoteAgentDeviceInfo>;
};

export type RemoteAgentTask = {
  taskId: string;
  deviceId: string;
  message: string;
  taskKind: string;
  cwd?: string;
  threadName?: string;
  files: RemoteAgentFileTransfer[];
  originGatewayId: string;
  originReplyContext?: Record<string, unknown>;
  status: "queued" | "delivered" | "started" | "progress" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  events: RemoteAgentTaskEvent[];
};

export type RemoteAgentDeviceStatus = RemoteAgentDeviceInfo & {
  connected: boolean;
  observedIp?: string;
  host?: string;
  port?: number;
  controlUrl?: string;
  discoveryPort?: number;
  protocolVersion?: number;
  discoveredAt?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  lastTaskAt?: string;
  passwordSaved?: boolean;
  connectionError?: string;
};

export type RemoteAgentConnectRequest = {
  deviceId?: string;
  password?: string;
};

type RemoteAgentDiscoveredDevice = RemoteAgentDeviceInfo & {
  host: string;
  port: number;
  controlUrl: string;
  discoveryPort?: number;
  protocolVersion?: number;
  observedIp?: string;
  discoveredAt: string;
};

type RemoteAgentDeviceRecord = {
  info: RemoteAgentDeviceInfo;
  socket: WebSocket;
  host?: string;
  port?: number;
  controlUrl?: string;
  discoveryPort?: number;
  protocolVersion?: number;
  observedIp?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastTaskAt?: string;
  connectionError?: string;
};

export type RemoteAgentHubOptions = {
  managerPort: number;
  managerHost?: string;
  publicHost?: string;
  discoveryPort?: number;
  passwordStorePath?: string;
  fileStoreDir?: string;
  connectionTimeoutMs?: number;
  getDefaultGatewayId: () => string | undefined;
  onTaskEvent?: (task: RemoteAgentTask, event: RemoteAgentTaskEvent) => void | Promise<void>;
  /** Manager-owned persistence hook for the persona conversation ledger. */
  onConversationRecord?: (record: MessageContextRecord) => void | Promise<void>;
};

type PasswordStore = {
  devices?: Record<string, { password?: string; updatedAt?: string }>;
};

type RemoteAgentSocketMessage =
  | { type: "challenge"; protocolVersion?: number; algorithm?: string; nonce?: string }
  | { type: "registered"; protocolVersion?: number; serverProof?: string; device?: RemoteAgentDeviceInfo; deviceId?: string; observedIp?: string }
  | { type: "heartbeat"; device?: Partial<RemoteAgentDeviceInfo> }
  | ({ type: "taskEvent" } & RemoteAgentTaskEvent)
  | { type: "error"; error?: string };

function nowIso(): string {
  return new Date().toISOString();
}

function contextString(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = String(context?.[key] ?? "").trim();
  return value || undefined;
}

function epochSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : Math.floor(Date.now() / 1000);
}

function remoteAgentConversationKey(task: RemoteAgentTask): string {
  const thread = String(task.threadName || task.taskId).trim() || task.taskId;
  return `remoteAgent:gateway:${task.originGatewayId}:instance:${task.deviceId}:thread:${thread}`;
}

function contextAttachments(files: RemoteAgentFileTransfer[] | undefined): MessageContextAttachment[] | undefined {
  if (!files?.length) return undefined;
  const attachments = files.map((file) => ({
    id: file.sha256,
    kind: "file",
    name: file.name,
    mimeType: file.mimeType,
    size: file.size
  }));
  return attachments.length > 0 ? attachments : undefined;
}

/** A task is recorded only after the remote bridge has accepted the socket write. */
export function remoteAgentTaskRequestContextRecord(task: RemoteAgentTask): MessageContextRecord {
  return {
    time: epochSeconds(task.createdAt),
    direction: "outbound",
    adapter: "remoteAgent",
    transport: "remoteAgent",
    gatewayId: task.originGatewayId,
    instanceId: task.deviceId,
    channel: "remoteAgent",
    conversationKey: remoteAgentConversationKey(task),
    kind: "task_request",
    status: "sent",
    sender: "Agent",
    target: task.deviceId,
    text: task.message,
    messageId: `remote-agent-task:${task.taskId}`,
    sessionId: task.taskId,
    routeProfileId: contextString(task.originReplyContext, "routeProfileId"),
    attachments: contextAttachments(task.files)
  };
}

/** Progress events stay operational; only a received terminal result becomes conversation context. */
export function remoteAgentTaskEventContextRecord(
  task: RemoteAgentTask,
  event: RemoteAgentTaskEvent
): MessageContextRecord | undefined {
  const status = event.status ?? task.status;
  if (status !== "completed" && status !== "failed") return undefined;
  const returnedFiles = event.savedFiles?.length ? event.savedFiles : event.files;
  const lines = [
    status === "completed" ? "远端 Agent 任务已完成。" : "远端 Agent 任务执行失败。",
    event.summary ? `摘要：${event.summary}` : "",
    event.message ? `消息：${event.message}` : "",
    event.error ? `错误：${event.error}` : "",
    event.artifactPath ? `产物路径：${event.artifactPath}` : "",
    event.logPath ? `日志路径：${event.logPath}` : "",
    returnedFiles?.length ? `返回文件：${returnedFiles.map((file) => file.name).filter(Boolean).join("、")}` : ""
  ].filter(Boolean);
  return {
    time: epochSeconds(task.updatedAt),
    direction: "inbound",
    adapter: "remoteAgent",
    transport: "remoteAgent",
    gatewayId: task.originGatewayId,
    instanceId: task.deviceId,
    channel: "remoteAgent",
    conversationKey: remoteAgentConversationKey(task),
    kind: "task_result",
    status: "received",
    sender: event.device?.deviceName || task.deviceId,
    target: "Agent",
    text: lines.join("\n"),
    messageId: `remote-agent-result:${task.taskId}:${status}`,
    replyToMessageId: `remote-agent-task:${task.taskId}`,
    sessionId: task.taskId,
    routeProfileId: contextString(task.originReplyContext, "routeProfileId"),
    attachments: contextAttachments(returnedFiles)
  };
}

function remoteAgentAuthProof(password: string, role: "manager" | "server", nonce: string): string {
  return createHmac("sha256", password)
    .update(`rabiroute.remote-agent.v3:${role}:${nonce}`)
    .digest("base64url");
}

function authProofMatches(candidate: unknown, expected: string): boolean {
  const actualBuffer = Buffer.from(String(candidate || ""), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function localDeviceInfo(): RemoteAgentDeviceInfo {
  return {
    deviceId: os.hostname(),
    deviceName: os.hostname(),
    agentType: "rabiroute",
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch
  };
}

function normalizeDeviceInfo(input: Partial<RemoteAgentDeviceInfo> | undefined, fallbackId: string): RemoteAgentDeviceInfo {
  const deviceId = String(input?.deviceId || fallbackId).trim() || fallbackId;
  return {
    deviceId,
    deviceName: input?.deviceName ? String(input.deviceName) : deviceId,
    agentType: input?.agentType ? String(input.agentType) : "agent",
    os: input?.os ? String(input.os) : undefined,
    osVersion: input?.osVersion ? String(input.osVersion) : undefined,
    arch: input?.arch ? String(input.arch) : undefined,
    declaredIp: input?.declaredIp ? String(input.declaredIp) : undefined,
    defaultCwd: input?.defaultCwd ? String(input.defaultCwd) : undefined,
    defaultThreadName: input?.defaultThreadName ? String(input.defaultThreadName) : undefined
  };
}

function safeJsonParse(data: WebSocket.RawData): unknown {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : data.toString();
  return JSON.parse(text);
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function discoveryTargets(): string[] {
  const targets = new Set(["255.255.255.255"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== "IPv4" || item.internal || !item.address || !item.netmask) continue;
      const address = ipv4ToInt(item.address);
      const netmask = ipv4ToInt(item.netmask);
      if (address == null || netmask == null) continue;
      targets.add(intToIpv4((address | (~netmask >>> 0)) >>> 0));
    }
  }
  return [...targets];
}

function discoveryPorts(): number[] {
  const ports: number[] = [];
  for (let port = REMOTE_AGENT_DISCOVERY_PORT_START; port <= REMOTE_AGENT_DISCOVERY_PORT_END; port += 1) {
    ports.push(port);
  }
  return ports;
}

export function controlUrlFromObservedAddress(rawControlUrl: unknown, observedAddress: string, port: number, preserveAdvertised = false): string {
  if (preserveAdvertised) {
    const parsed = new URL(String(rawControlUrl || ""));
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      || !parsed.hostname
      || parsed.pathname !== "/api/remote-agent/control"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("Remote Agent advertised an invalid public control URL.");
    }
    return parsed.toString();
  }
  const host = observedAddress.includes(":") && !observedAddress.startsWith("[")
    ? `[${observedAddress}]`
    : observedAddress;
  return `ws://${host}:${port}/api/remote-agent/control`;
}

function defaultPasswordStorePath(): string {
  return path.join(process.cwd(), "data", "remote-agent-connections.json");
}

function defaultFileStoreDir(): string {
  return path.join(process.cwd(), "data", "remote-agent-files");
}

function safeFileName(value: string, fallback: string): string {
  const base = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_");
  return base || fallback;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeTransferContent(file: RemoteAgentFileTransfer): Buffer {
  const content = String(file.contentBase64 || "");
  return Buffer.from(content, "base64");
}

function stripTransferContent(file: RemoteAgentFileTransfer): RemoteAgentFileTransfer {
  const { contentBase64: _contentBase64, ...metadata } = file;
  return metadata;
}

export class RemoteAgentHub {
  private readonly discovered = new Map<string, RemoteAgentDiscoveredDevice>();
  private readonly devices = new Map<string, RemoteAgentDeviceRecord>();
  private readonly tasks = new Map<string, RemoteAgentTask>();
  private readonly options: RemoteAgentHubOptions;
  private lastScanError = "";

  constructor(options: RemoteAgentHubOptions) {
    this.options = options;
  }

  attach(_server: http.Server): void {
    // Remote Agent v3 uses Rabi as the outbound controller. This method is kept
    // so older manager wiring can call it without exposing an inbound token API.
  }

  startDiscoveryResponder(): void {
    console.log("Remote Agent manager discovery responder is not used in v3; RabiGUI scans remote clients instead.");
  }

  localScanResult(): {
    type: "remoteAgent";
    label: string;
    maturity: "experimental";
    installed: boolean;
    requirements: Array<{ id: string; label: string; required?: boolean; ok?: boolean; detail?: string; actionLabel?: string; url?: string; path?: string }>;
    endpoints: Array<{ label: string; url: string; healthy?: boolean }>;
    warnings: string[];
  } {
    const connectedCount = this.connectedCount();
    return {
      type: "remoteAgent",
      label: "远端 Agent",
      maturity: "experimental",
      installed: connectedCount > 0 || this.discovered.size > 0,
      requirements: [
        {
          id: "bridge",
          label: "远端 Agent bridge",
          required: true,
          ok: connectedCount > 0 || this.discovered.size > 0,
          detail: connectedCount > 0
            ? `已连接 ${connectedCount} 台远端 Agent 设备。`
            : this.discovered.size > 0
              ? `已扫描到 ${this.discovered.size} 台远端 Agent 设备，输入密码即可连接。`
              : "远端机器只需运行 plugin-adapters/remote-agent-rabiroute；RabiGUI 会扫描并连接。"
        },
        {
          id: "password",
          label: "连接密码",
          required: true,
          ok: true,
          detail: "远端 bridge 不提供公知默认密码；请输入远端终端显示的临时密码或预先配置的高熵密码。连接成功后 Rabi 会在本机运行期数据中记住密码。"
        },
        {
          id: "discovery",
          label: "局域网扫描",
          required: true,
          ok: !this.lastScanError,
          detail: this.lastScanError || `扫描 UDP 端口范围 ${REMOTE_AGENT_DISCOVERY_PORT_START}-${REMOTE_AGENT_DISCOVERY_PORT_END}，无需手动输入端口。`
        }
      ],
      endpoints: [
        { label: "远端 Agent 扫描", url: `udp://255.255.255.255:${REMOTE_AGENT_DISCOVERY_PORT_START}-${REMOTE_AGENT_DISCOVERY_PORT_END}`, healthy: !this.lastScanError },
        { label: "远端 Agent API", url: "/api/remote-agent/devices", healthy: true }
      ],
      warnings: ["Rabi 是主控端；远端 Agent 启动后无人值守等待 RabiGUI 扫描和密码连接。"]
    };
  }

  async scanLan(timeoutMs = 1400): Promise<RemoteAgentDeviceStatus[]> {
    const found = await this.discoverRemoteAgents(timeoutMs);
    for (const item of found) {
      this.discovered.set(item.deviceId, item);
    }
    return this.listDevices();
  }

  async connectDevice(request: RemoteAgentConnectRequest): Promise<RemoteAgentDeviceStatus> {
    const deviceId = String(request.deviceId || "").trim();
    if (!deviceId) throw new Error("Missing remote Agent device id.");
    const discovered = this.discovered.get(deviceId);
    if (!discovered) throw new Error(`Remote Agent device has not been scanned: ${deviceId}`);
    if (discovered.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION) {
      throw new Error(`Remote Agent bridge protocol ${String(discovered.protocolVersion ?? "missing")} is incompatible; protocol ${REMOTE_AGENT_PROTOCOL_VERSION} is required.`);
    }
    const password = String(request.password ?? this.savedPassword(deviceId) ?? "").trim();
    if (!password) throw new Error("Missing remote Agent password.");
    const existing = this.devices.get(deviceId);
    if (existing?.socket.readyState === WebSocket.OPEN) {
      return this.deviceStatus(deviceId, existing);
    }

    const socket = new WebSocket(discovered.controlUrl);
    const record: RemoteAgentDeviceRecord = {
      info: normalizeDeviceInfo(discovered, deviceId),
      socket,
      host: discovered.host,
      port: discovered.port,
      controlUrl: discovered.controlUrl,
      discoveryPort: discovered.discoveryPort,
      protocolVersion: discovered.protocolVersion,
      observedIp: discovered.observedIp,
      connectedAt: nowIso(),
      lastSeenAt: nowIso()
    };
    this.devices.set(deviceId, record);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let challengeAnswered = false;
      let authNonce = "";
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        record.connectionError = error.message;
        try { socket.close(); } catch { /* ignore */ }
        reject(error);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => fail(error instanceof Error ? error : new Error(String(error)));
      const onMessage = (data: WebSocket.RawData): void => {
        if (settled) return;
        try {
          const message = safeJsonParse(data) as RemoteAgentSocketMessage;
          if (message.type === "challenge") {
            const nonce = String(message.nonce || "");
            if (
              challengeAnswered
              || message.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION
              || message.algorithm !== "hmac-sha256"
              || nonce.length < 32
            ) {
              fail(new Error("Remote Agent sent an invalid authentication challenge."));
              return;
            }
            challengeAnswered = true;
            authNonce = nonce;
            const proof = remoteAgentAuthProof(password, "manager", nonce);
            socket.send(JSON.stringify({
              type: "hello",
              proof,
              manager: localDeviceInfo(),
              protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION
            }));
            return;
          }
          if (message.type === "registered") {
            const expectedServerProof = authNonce ? remoteAgentAuthProof(password, "server", authNonce) : "";
            if (
              !challengeAnswered
              || message.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION
              || !expectedServerProof
              || !authProofMatches(message.serverProof, expectedServerProof)
            ) {
              fail(new Error("Remote Agent server authentication failed."));
              return;
            }
            const info = normalizeDeviceInfo(message.device || { deviceId: message.deviceId }, deviceId);
            if (info.deviceId !== deviceId) {
              fail(new Error(`Remote Agent registered as unexpected device ${info.deviceId}; expected ${deviceId}.`));
              return;
            }
            record.info = info;
            record.lastSeenAt = nowIso();
            this.savePassword(deviceId, password);
            succeed();
            return;
          }
          if (message.type === "error") {
            fail(new Error(message.error || "Remote Agent rejected the connection."));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(
        () => fail(new Error("Remote Agent connection timed out.")),
        this.options.connectionTimeoutMs ?? 6000
      );
      socket.once("error", onError);
      socket.on("message", onMessage);
    });

    socket.on("message", (data) => {
      try {
        const message = safeJsonParse(data) as RemoteAgentSocketMessage;
        record.lastSeenAt = nowIso();
        if (message.type === "heartbeat" && message.device) {
          record.info = normalizeDeviceInfo({ ...record.info, ...message.device }, deviceId);
        }
        if (message.type === "taskEvent") {
          this.receiveTaskEvent(message, message.device?.deviceId ?? deviceId);
        }
      } catch (error) {
        record.connectionError = error instanceof Error ? error.message : String(error);
      }
    });
    socket.on("close", () => {
      const latest = this.devices.get(deviceId);
      if (latest?.socket === socket) {
        latest.connectionError = latest.connectionError || "Disconnected.";
      }
    });
    socket.on("error", (error) => {
      record.connectionError = error instanceof Error ? error.message : String(error);
    });
    return this.deviceStatus(deviceId, record);
  }

  disconnectDevice(deviceId: string): RemoteAgentDeviceStatus {
    const id = String(deviceId || "").trim();
    const record = this.devices.get(id);
    if (record) {
      try { record.socket.close(); } catch { /* ignore */ }
      this.devices.delete(id);
    }
    return this.listDevices().find((device) => device.deviceId === id) ?? {
      deviceId: id,
      connected: false,
      passwordSaved: Boolean(this.savedPassword(id))
    };
  }

  listDevices(): RemoteAgentDeviceStatus[] {
    const byId = new Map<string, RemoteAgentDeviceStatus>();
    for (const [deviceId, item] of this.discovered.entries()) {
      byId.set(deviceId, {
        ...item,
        connected: false,
        passwordSaved: Boolean(this.savedPassword(deviceId))
      });
    }
    for (const [deviceId, record] of this.devices.entries()) {
      byId.set(deviceId, this.deviceStatus(deviceId, record));
    }
    return [...byId.values()].sort((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return (left.deviceName || left.deviceId).localeCompare(right.deviceName || right.deviceId);
    });
  }

  listTasks(limit = 50): RemoteAgentTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  async createTask(request: RemoteAgentTaskRequest): Promise<RemoteAgentTask> {
    const devices = this.listDevices().filter((device) => device.connected);
    const targetDevice = request.deviceId
      ? devices.find((device) => device.deviceId === request.deviceId)
      : devices[0];
    if (!targetDevice) {
      throw new Error(request.deviceId ? `Remote Agent device is not connected: ${request.deviceId}` : "No Remote Agent device is connected.");
    }
    const record = this.devices.get(targetDevice.deviceId);
    if (!record || record.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Remote Agent device is not connected: ${targetDevice.deviceId}`);
    }
    const originGatewayId = String(request.originGatewayId || request.gatewayId || request.originReplyContext?.gatewayId || this.options.getDefaultGatewayId() || "").trim();
    if (!originGatewayId) {
      throw new Error("Missing originGatewayId; cannot route Remote Agent result back to the originating local persona.");
    }
    const message = String(request.message ?? request.text ?? "").trim();
    if (!message) {
      throw new Error("Missing remote Agent task message.");
    }
    const files = this.prepareTaskFiles(request);
    const task: RemoteAgentTask = {
      taskId: randomUUID(),
      deviceId: targetDevice.deviceId,
      message,
      taskKind: String(request.taskKind || "remote-agent-task"),
      cwd: request.cwd || targetDevice.defaultCwd,
      threadName: request.threadName || targetDevice.defaultThreadName,
      files: files.map(stripTransferContent),
      originGatewayId,
      originReplyContext: request.originReplyContext,
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: []
    };
    this.tasks.set(task.taskId, task);
    record.lastTaskAt = task.updatedAt;
    record.socket.send(JSON.stringify({
      type: "task",
      task: { ...task, files },
      center: {
        ...localDeviceInfo(),
        sentAt: task.createdAt
      }
    }));
    this.patchTask(task.taskId, { status: "delivered", message: "Task delivered to remote Agent bridge." });
    const deliveredTask = this.tasks.get(task.taskId) ?? task;
    this.emitConversationRecord(remoteAgentTaskRequestContextRecord(deliveredTask));
    return deliveredTask;
  }

  receiveTaskEvent(event: RemoteAgentTaskEvent, sourceDeviceId = event.device?.deviceId): RemoteAgentTask {
    if (!event.taskId) {
      throw new Error("Remote Agent task event is missing taskId.");
    }
    const existing = this.tasks.get(event.taskId);
    if (!existing) {
      throw new Error(`Remote Agent task not found: ${event.taskId}`);
    }
    const normalizedSourceDeviceId = sourceDeviceId ? String(sourceDeviceId).trim() : "";
    if (!normalizedSourceDeviceId) {
      throw new Error("Remote Agent task event is missing source device id.");
    }
    if (normalizedSourceDeviceId !== existing.deviceId) {
      throw new Error(`Remote Agent device ${normalizedSourceDeviceId} does not own task ${event.taskId}.`);
    }
    if (existing.status === "completed" || existing.status === "failed") {
      return existing;
    }
    const storedEvent = event.files?.length
      ? { ...event, files: event.files.map(stripTransferContent), savedFiles: this.saveReturnedFiles(existing, event.files) }
      : event;
    const task = this.patchTask(event.taskId, storedEvent);
    const contextRecord = remoteAgentTaskEventContextRecord(task, storedEvent);
    if (contextRecord) this.emitConversationRecord(contextRecord);
    void Promise.resolve(this.options.onTaskEvent?.(task, storedEvent))
      .catch((error) => {
        this.patchTask(task.taskId, {
          status: "failed",
          error: `Remote Agent task event handler failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    return task;
  }

  private emitConversationRecord(record: MessageContextRecord): void {
    void Promise.resolve(this.options.onConversationRecord?.(record))
      .catch((error) => {
        console.warn(`Remote Agent conversation record failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async discoverRemoteAgents(timeoutMs: number): Promise<RemoteAgentDiscoveredDevice[]> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      const found: RemoteAgentDiscoveredDevice[] = [];
      const seen = new Set<string>();
      const finish = (): void => {
        try { socket.close(); } catch { /* ignore */ }
        resolve(found);
      };
      const probe = Buffer.from(JSON.stringify({
        type: "rabiroute.remoteAgent.client.discover",
        protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        manager: localDeviceInfo()
      }));
      socket.on("message", (message, remote) => {
        try {
          const item = JSON.parse(message.toString("utf8")) as Record<string, unknown>;
          if (item.type !== "rabiroute.remoteAgent.client" || !item.device || !item.controlUrl) return;
          const device = item.device as Partial<RemoteAgentDeviceInfo>;
          const port = Number(item.port || 0);
          const deviceId = String(device.deviceId || item.deviceId || "").trim();
          if (!deviceId || !Number.isInteger(port) || port < 1) return;
          const key = deviceId;
          if (seen.has(key)) return;
          seen.add(key);
          const controlUrl = controlUrlFromObservedAddress(item.controlUrl, remote.address, port, item.publicControlUrl === true);
          found.push({
            ...normalizeDeviceInfo(device, deviceId),
            host: remote.address,
            port,
            controlUrl,
            discoveryPort: Number(item.discoveryPort || remote.port),
            protocolVersion: Number(item.protocolVersion || 1),
            observedIp: remote.address,
            discoveredAt: nowIso()
          });
        } catch {
          // ignore malformed discovery responses
        }
      });
      socket.on("error", (error) => {
        this.lastScanError = `远端 Agent 扫描失败：${error.message}`;
        finish();
      });
      socket.bind(() => {
        this.lastScanError = "";
        socket.setBroadcast(true);
        const targets = discoveryTargets();
        for (const target of targets) {
          for (const port of discoveryPorts()) {
            socket.send(probe, port, target);
          }
        }
      });
      setTimeout(finish, timeoutMs);
    });
  }

  private deviceStatus(deviceId: string, record: RemoteAgentDeviceRecord): RemoteAgentDeviceStatus {
    return {
      ...record.info,
      connected: record.socket.readyState === WebSocket.OPEN,
      observedIp: record.observedIp,
      host: record.host,
      port: record.port,
      controlUrl: record.controlUrl,
      discoveryPort: record.discoveryPort,
      protocolVersion: record.protocolVersion,
      discoveredAt: this.discovered.get(deviceId)?.discoveredAt,
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
      lastTaskAt: record.lastTaskAt,
      passwordSaved: Boolean(this.savedPassword(deviceId)),
      connectionError: record.connectionError
    };
  }

  private connectedCount(): number {
    return [...this.devices.values()].filter((record) => record.socket.readyState === WebSocket.OPEN).length;
  }

  private passwordStorePath(): string {
    return this.options.passwordStorePath || defaultPasswordStorePath();
  }

  private fileStoreDir(): string {
    return this.options.fileStoreDir || defaultFileStoreDir();
  }

  private readPasswordStore(): PasswordStore {
    try {
      const file = this.passwordStorePath();
      if (!fs.existsSync(file)) return {};
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PasswordStore;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private writePasswordStore(store: PasswordStore): void {
    const file = this.passwordStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
  }

  private savedPassword(deviceId: string): string {
    return String(this.readPasswordStore().devices?.[deviceId]?.password || "");
  }

  private savePassword(deviceId: string, password: string): void {
    const store = this.readPasswordStore();
    store.devices = store.devices || {};
    store.devices[deviceId] = { password, updatedAt: nowIso() };
    this.writePasswordStore(store);
  }

  private prepareTaskFiles(request: RemoteAgentTaskRequest): RemoteAgentFileTransfer[] {
    const rawFiles: Array<RemoteAgentFileTransfer | { path?: string; name?: string; kind?: string } | string> = [
      ...(Array.isArray(request.filePaths) ? request.filePaths : []),
      ...(Array.isArray(request.files) ? request.files : []),
      ...(Array.isArray(request.attachments) ? request.attachments : [])
    ];
    const files: RemoteAgentFileTransfer[] = [];
    let total = 0;
    for (const raw of rawFiles) {
      const item = typeof raw === "string" ? { path: raw } : raw;
      const sourcePath = String(item.path || "").trim();
      if (!sourcePath) {
        if ("contentBase64" in item && item.contentBase64) {
          const buffer = decodeTransferContent(item as RemoteAgentFileTransfer);
          total += buffer.byteLength;
          this.assertFileTransferSize(buffer.byteLength, total, item.name || "inline file");
          files.push({
            name: safeFileName(item.name || "remote-agent-file", `file-${files.length + 1}`),
            relativePath: item.relativePath,
            mimeType: item.mimeType,
            size: buffer.byteLength,
            sha256: item.sha256 || sha256(buffer),
            contentBase64: buffer.toString("base64")
          });
          if (item.sha256 && item.sha256 !== files.at(-1)?.sha256) {
            throw new Error(`Remote Agent inline file checksum mismatch: ${item.name || "inline file"}`);
          }
        }
        continue;
      }
      if (!fs.existsSync(sourcePath)) throw new Error(`Remote Agent file does not exist: ${sourcePath}`);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) throw new Error(`Remote Agent file is not a regular file: ${sourcePath}`);
      total += stat.size;
      this.assertFileTransferSize(stat.size, total, sourcePath);
      const buffer = fs.readFileSync(sourcePath);
      files.push({
        name: safeFileName(item.name || path.basename(sourcePath), `file-${files.length + 1}`),
        relativePath: "relativePath" in item ? item.relativePath : undefined,
        path: sourcePath,
        size: buffer.byteLength,
        sha256: sha256(buffer),
        contentBase64: buffer.toString("base64")
      });
    }
    return files;
  }

  private assertFileTransferSize(size: number, total: number, label: string): void {
    if (REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES > 0 && size > REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES) {
      throw new Error(`Remote Agent file is too large (${size} bytes): ${label}. Limit: ${REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES} bytes.`);
    }
    if (REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES > 0 && total > REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES) {
      throw new Error(`Remote Agent files exceed total limit (${total} bytes). Limit: ${REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES} bytes.`);
    }
  }

  private saveReturnedFiles(task: RemoteAgentTask, files: RemoteAgentFileTransfer[]): RemoteAgentFileTransfer[] {
    const dir = path.join(this.fileStoreDir(), task.taskId);
    fs.mkdirSync(dir, { recursive: true });
    let total = 0;
    return files.map((file, index) => {
      const buffer = decodeTransferContent(file);
      total += buffer.byteLength;
      this.assertFileTransferSize(buffer.byteLength, total, file.name || `returned-${index + 1}`);
      const name = safeFileName(file.name || file.path || `returned-${index + 1}`, `returned-${index + 1}`);
      const outPath = path.join(dir, name);
      fs.writeFileSync(outPath, buffer);
      return {
        name,
        path: outPath,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        size: buffer.byteLength,
        sha256: sha256(buffer)
      };
    });
  }

  private patchTask(taskId: string, event: RemoteAgentTaskEvent): RemoteAgentTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Remote Agent task not found: ${taskId}`);
    }
    const normalizedEvent: RemoteAgentTaskEvent = {
      ...event,
      status: event.status ?? task.status
    };
    task.status = normalizedEvent.status ?? task.status;
    task.updatedAt = nowIso();
    task.events.push(normalizedEvent);
    this.tasks.set(taskId, task);
    return task;
  }
}
