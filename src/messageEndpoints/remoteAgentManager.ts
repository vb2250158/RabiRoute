import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export const REMOTE_AGENT_CONTROL_PORT_START = 8797;
export const REMOTE_AGENT_DISCOVERY_PORT_START = 8798;
export const REMOTE_AGENT_DISCOVERY_PORT_END = 8818;
export const REMOTE_AGENT_PROTOCOL_VERSION = 2;

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
  originGatewayId?: string;
  gatewayId?: string;
  originReplyContext?: Record<string, unknown>;
};

export type RemoteAgentTaskEvent = {
  taskId?: string;
  status?: "queued" | "delivered" | "started" | "progress" | "completed" | "failed";
  summary?: string;
  message?: string;
  artifactPath?: string;
  logPath?: string;
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

type RemoteAgentHubOptions = {
  managerPort: number;
  managerHost?: string;
  publicHost?: string;
  discoveryPort?: number;
  passwordStorePath?: string;
  getDefaultGatewayId: () => string | undefined;
  onTaskEvent?: (task: RemoteAgentTask, event: RemoteAgentTaskEvent) => void | Promise<void>;
};

type PasswordStore = {
  devices?: Record<string, { password?: string; updatedAt?: string }>;
};

type RemoteAgentSocketMessage =
  | { type: "registered"; device?: RemoteAgentDeviceInfo; deviceId?: string; observedIp?: string }
  | { type: "heartbeat"; device?: Partial<RemoteAgentDeviceInfo> }
  | ({ type: "taskEvent" } & RemoteAgentTaskEvent)
  | { type: "error"; error?: string };

function nowIso(): string {
  return new Date().toISOString();
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

function defaultPasswordStorePath(): string {
  return path.join(process.cwd(), "data", "remote-agent-connections.json");
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
    // Remote Agent v2 uses Rabi as the outbound controller. This method is kept
    // so older manager wiring can call it without exposing an inbound token API.
  }

  startDiscoveryResponder(): void {
    console.log("Remote Agent manager discovery responder is not used in v2; RabiGUI scans remote clients instead.");
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
          detail: "远端 bridge 默认密码为 123456；连接成功后 Rabi 会在本机运行期数据中记住密码。"
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
      const timer = setTimeout(() => {
        reject(new Error("Remote Agent connection timed out."));
      }, 6000);
      const fail = (error: Error): void => {
        clearTimeout(timer);
        record.connectionError = error.message;
        try { socket.close(); } catch { /* ignore */ }
        reject(error);
      };
      socket.once("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          password,
          manager: localDeviceInfo(),
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION
        }));
      });
      socket.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.on("message", (data) => {
        try {
          const message = safeJsonParse(data) as RemoteAgentSocketMessage;
          if (message.type === "registered") {
            clearTimeout(timer);
            const info = normalizeDeviceInfo(message.device || { deviceId: message.deviceId }, deviceId);
            record.info = info;
            record.lastSeenAt = nowIso();
            this.savePassword(deviceId, password);
            resolve();
            return;
          }
          if (message.type === "error") {
            fail(new Error(message.error || "Remote Agent rejected the connection."));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
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
    const task: RemoteAgentTask = {
      taskId: randomUUID(),
      deviceId: targetDevice.deviceId,
      message,
      taskKind: String(request.taskKind || "remote-agent-task"),
      cwd: request.cwd || targetDevice.defaultCwd,
      threadName: request.threadName || targetDevice.defaultThreadName,
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
      task,
      center: {
        ...localDeviceInfo(),
        sentAt: task.createdAt
      }
    }));
    this.patchTask(task.taskId, { status: "delivered", message: "Task delivered to remote Agent bridge." });
    return this.tasks.get(task.taskId) ?? task;
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
    const task = this.patchTask(event.taskId, event);
    void Promise.resolve(this.options.onTaskEvent?.(task, event))
      .catch((error) => {
        this.patchTask(task.taskId, {
          status: "failed",
          error: `Remote Agent task event handler failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    return task;
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
          found.push({
            ...normalizeDeviceInfo(device, deviceId),
            host: String(item.host || remote.address),
            port,
            controlUrl: String(item.controlUrl),
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
