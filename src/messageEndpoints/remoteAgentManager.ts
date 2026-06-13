import http from "node:http";
import os from "node:os";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

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
  connectedAt?: string;
  lastSeenAt?: string;
  lastTaskAt?: string;
};

type RemoteAgentDeviceRecord = {
  info: RemoteAgentDeviceInfo;
  socket: WebSocket;
  observedIp?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastTaskAt?: string;
};

type RemoteAgentHubOptions = {
  managerPort: number;
  managerHost?: string;
  discoveryPort?: number;
  token?: string;
  getDefaultGatewayId: () => string | undefined;
  onTaskEvent?: (task: RemoteAgentTask, event: RemoteAgentTaskEvent) => void | Promise<void>;
};

type ClientMessage =
  | { type: "register"; device?: RemoteAgentDeviceInfo }
  | { type: "heartbeat"; device?: Partial<RemoteAgentDeviceInfo> }
  | ({ type: "taskEvent" } & RemoteAgentTaskEvent);

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

function firstLocalIp(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
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

export class RemoteAgentHub {
  private readonly devices = new Map<string, RemoteAgentDeviceRecord>();
  private readonly tasks = new Map<string, RemoteAgentTask>();
  private readonly options: RemoteAgentHubOptions;

  constructor(options: RemoteAgentHubOptions) {
    this.options = options;
  }

  attach(server: http.Server): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (requestUrl.pathname !== "/api/remote-agent/connect") {
        return;
      }
      const expectedToken = this.options.token?.trim();
      const providedToken = requestUrl.searchParams.get("token") || request.headers["x-remote-agent-token"];
      if (expectedToken && providedToken !== expectedToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        this.handleConnection(ws, request.socket.remoteAddress);
      });
    });
  }

  startDiscoveryResponder(): void {
    const discoveryPort = this.options.discoveryPort ?? 8798;
    const socket = dgram.createSocket("udp4");
    socket.on("message", (message, remote) => {
      let payload: { type?: string } = {};
      try {
        payload = JSON.parse(message.toString("utf8")) as { type?: string };
      } catch {
        return;
      }
      if (payload.type !== "rabiroute.remoteAgent.discover") {
        return;
      }
      const host = this.options.managerHost && this.options.managerHost !== "0.0.0.0"
        ? this.options.managerHost
        : firstLocalIp();
      const response = Buffer.from(JSON.stringify({
        type: "rabiroute.remoteAgent.manager",
        name: "RabiRoute Manager",
        host,
        port: this.options.managerPort,
        wsUrl: `ws://${host}:${this.options.managerPort}/api/remote-agent/connect`,
        tokenRequired: Boolean(this.options.token?.trim()),
        deviceCount: this.devices.size,
        sentAt: nowIso()
      }));
      socket.send(response, remote.port, remote.address);
    });
    socket.on("error", (error) => {
      console.warn(`Remote Agent discovery responder error: ${error.message}`);
    });
    socket.bind(discoveryPort, () => {
      socket.setBroadcast(true);
      console.log(`Remote Agent discovery responder listening on udp://0.0.0.0:${discoveryPort}`);
    });
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
    const tokenConfigured = Boolean(this.options.token?.trim());
    return {
      type: "remoteAgent",
      label: "远端 Agent",
      maturity: "experimental",
      installed: this.devices.size > 0,
      requirements: [
        { id: "bridge", label: "远端 Agent bridge", required: true, ok: this.devices.size > 0, detail: this.devices.size > 0 ? `已连接 ${this.devices.size} 台远端 Agent 设备。` : "远端机器只需运行 plugin-adapters/remote-agent-rabiroute，不需要安装完整 RabiRoute。" },
        { id: "token", label: "连接 token", required: true, ok: tokenConfigured, detail: tokenConfigured ? "已配置 REMOTE_AGENT_TOKEN。" : "建议设置 REMOTE_AGENT_TOKEN；未设置时只适合本机或受信任内网测试。" },
        { id: "api", label: "Rabi API", required: true, ok: true, detail: "本机人格可通过 /api/remote-agent/devices 和 /api/remote-agent/tasks 发现和投递任务。" }
      ],
      endpoints: [
        { label: "远端 Agent WebSocket", url: `ws://<this-host>:${this.options.managerPort}/api/remote-agent/connect`, healthy: this.devices.size > 0 },
        { label: "局域网自动发现", url: `udp://255.255.255.255:${this.options.discoveryPort ?? 8798}`, healthy: true }
      ],
      warnings: ["远端 Agent 是下游 Agent 设备入口；远端插件通过参数声明 agentType，例如 codex。"]
    };
  }

  listDevices(): RemoteAgentDeviceStatus[] {
    return [...this.devices.values()].map((record) => ({
      ...record.info,
      connected: record.socket.readyState === WebSocket.OPEN,
      observedIp: record.observedIp,
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
      lastTaskAt: record.lastTaskAt
    }));
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

  private handleConnection(socket: WebSocket, observedIp?: string): void {
    let deviceId = `pending-${randomUUID()}`;
    const connectedAt = nowIso();
    const registerDevice = (device: Partial<RemoteAgentDeviceInfo> | undefined): void => {
      const info = normalizeDeviceInfo(device, deviceId);
      deviceId = info.deviceId;
      this.devices.set(deviceId, {
        info,
        socket,
        observedIp,
        connectedAt,
        lastSeenAt: nowIso()
      });
      socket.send(JSON.stringify({
        type: "registered",
        deviceId,
        observedIp,
        managerTime: nowIso()
      }));
    };

    socket.on("message", (data) => {
      try {
        const message = safeJsonParse(data) as ClientMessage;
        if (message.type === "register") {
          registerDevice(message.device);
          return;
        }
        const record = this.devices.get(deviceId);
        if (record) {
          record.lastSeenAt = nowIso();
          if (message.type === "heartbeat" && message.device) {
            record.info = normalizeDeviceInfo({ ...record.info, ...message.device }, deviceId);
          }
        }
        if (message.type === "taskEvent") {
          this.handleTaskEvent(message);
        }
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
      }
    });

    socket.on("close", () => {
      const record = this.devices.get(deviceId);
      if (record?.socket === socket) {
        this.devices.delete(deviceId);
      }
    });
  }

  private handleTaskEvent(event: RemoteAgentTaskEvent): void {
    this.receiveTaskEvent(event, event.device?.deviceId ?? "");
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
