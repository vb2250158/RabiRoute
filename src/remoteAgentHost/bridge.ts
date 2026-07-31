import dgram from "node:dgram";
import os from "node:os";
import type http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { REMOTE_AGENT_PROTOCOL_VERSION, type RemoteAgentTask, type RemoteAgentTaskEvent } from "../messageEndpoints/remoteAgentProtocol.js";
import type { RemoteAgentHostConfigStore } from "./configStore.js";

type BridgeTask = RemoteAgentTask & {
  files?: Array<{
    name: string;
    mimeType?: string;
    size?: number;
    sha256?: string;
    contentBase64?: string;
  }>;
};

type BridgeStatus = {
  running: boolean;
  connected: boolean;
  manager?: Record<string, unknown>;
  discoveryPort?: number;
  lastTaskAt?: string;
  lastError?: string;
};

export type RemoteAgentHostBridgeOptions = {
  configStore: RemoteAgentHostConfigStore;
  server: http.Server;
  onTask: (task: BridgeTask) => Promise<void>;
};

function authProof(password: string, role: "manager" | "server", nonce: string): string {
  return createHmac("sha256", password)
    .update(`rabiroute.remote-agent.v3:${role}:${nonce}`)
    .digest("base64url");
}

function proofMatches(candidate: unknown, expected: string): boolean {
  const actual = Buffer.from(String(candidate || ""), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function firstLocalIp(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RemoteAgentHostBridge {
  private readonly configStore: RemoteAgentHostConfigStore;
  private readonly onTask: RemoteAgentHostBridgeOptions["onTask"];
  private readonly wss: WebSocketServer;
  private managerSocket?: WebSocket;
  private manager?: Record<string, unknown>;
  private discoverySocket?: dgram.Socket;
  private heartbeat?: NodeJS.Timeout;
  private discoveryPort?: number;
  private lastTaskAt?: string;
  private lastError?: string;
  private readonly terminalTasks = new Set<string>();

  constructor(options: RemoteAgentHostBridgeOptions) {
    this.configStore = options.configStore;
    this.onTask = options.onTask;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    options.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      if (url.pathname !== "/api/remote-agent/control") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.acceptSocket(ws));
    });
  }

  async start(): Promise<void> {
    await this.startDiscovery();
    // event-driven-allow: transport heartbeat keepalive
    this.heartbeat = setInterval(() => {
      if (this.managerSocket?.readyState === WebSocket.OPEN) {
        this.managerSocket.send(JSON.stringify({ type: "heartbeat", device: this.deviceInfo(), time: nowIso() }));
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    try { this.discoverySocket?.close(); } catch { /* best effort */ }
    this.discoverySocket = undefined;
    try { this.managerSocket?.close(); } catch { /* best effort */ }
    this.managerSocket = undefined;
    this.wss.close();
  }

  disconnectManager(reason = "Remote Agent settings changed."): void {
    const socket = this.managerSocket;
    this.managerSocket = undefined;
    this.manager = undefined;
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, reason);
  }

  status(): BridgeStatus {
    return {
      running: true,
      connected: this.managerSocket?.readyState === WebSocket.OPEN,
      manager: this.manager,
      discoveryPort: this.discoveryPort,
      lastTaskAt: this.lastTaskAt,
      lastError: this.lastError
    };
  }

  sendTaskEvent(event: RemoteAgentTaskEvent): boolean {
    const taskId = String(event.taskId || "").trim();
    if (!taskId) return false;
    if (this.terminalTasks.has(taskId)) return false;
    if (event.status === "completed" || event.status === "failed") this.terminalTasks.add(taskId);
    if (this.managerSocket?.readyState !== WebSocket.OPEN) {
      this.lastError = "主 Manager 已断开，任务事件无法回传。";
      return false;
    }
    this.managerSocket.send(JSON.stringify({
      type: "taskEvent",
      ...event,
      device: this.deviceInfo()
    }));
    return true;
  }

  private deviceInfo(): Record<string, unknown> {
    const config = this.configStore.read();
    return {
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      agentType: "rabi-agent",
      agentTypes: config.profile.agentAdapters,
      os: process.platform,
      osVersion: os.release(),
      arch: process.arch,
      declaredIp: firstLocalIp()
    };
  }

  private acceptSocket(ws: WebSocket): void {
    const config = this.configStore.read();
    if (!config.enabled) {
      ws.close(1008, "Remote Agent host is disabled.");
      return;
    }
    let authenticated = false;
    const nonce = randomBytes(32).toString("base64url");
    const timeout = setTimeout(() => ws.close(1008, "Authentication timed out."), 5_000);
    ws.send(JSON.stringify({
      type: "challenge",
      protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
      algorithm: "hmac-sha256",
      nonce
    }));
    ws.on("message", raw => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, any>;
        if (!authenticated) {
          const latest = this.configStore.read();
          const expected = authProof(latest.password, "manager", nonce);
          if (
            message.type !== "hello"
            || message.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION
            || !proofMatches(message.proof, expected)
          ) {
            ws.send(JSON.stringify({ type: "error", error: "Invalid remote Agent protocol or password." }));
            ws.close();
            return;
          }
          authenticated = true;
          clearTimeout(timeout);
          if (this.managerSocket && this.managerSocket !== ws) {
            try { this.managerSocket.close(); } catch { /* best effort */ }
          }
          this.managerSocket = ws;
          this.manager = message.manager && typeof message.manager === "object" ? message.manager : undefined;
          this.lastError = undefined;
          ws.send(JSON.stringify({
            type: "registered",
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
            serverProof: authProof(latest.password, "server", nonce),
            device: this.deviceInfo(),
            managerTime: nowIso()
          }));
          return;
        }
        if (message.type === "task" && message.task) {
          void this.receiveTask(message.task as BridgeTask);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", error: this.lastError }));
        }
      }
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (this.managerSocket === ws) {
        this.managerSocket = undefined;
        this.manager = undefined;
      }
    });
    ws.on("error", error => {
      clearTimeout(timeout);
      this.lastError = error.message;
    });
  }

  private async receiveTask(task: BridgeTask): Promise<void> {
    const taskId = String(task.taskId || "").trim();
    if (!taskId || !String(task.message || "").trim()) return;
    this.lastTaskAt = nowIso();
    this.sendTaskEvent({ taskId, status: "started", summary: "Remote Agent Host 已接收任务，正在投递到本机 Agent。" });
    try {
      await this.onTask(task);
      this.sendTaskEvent({
        taskId,
        status: "progress",
        summary: "任务已投递到本机 Agent；等待 Agent 通过 RabiRoute 回传结果。"
      });
    } catch (error) {
      this.sendTaskEvent({
        taskId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async startDiscovery(): Promise<void> {
    const config = this.configStore.read();
    let lastError: unknown;
    for (let port = config.discoveryPortStart; port <= config.discoveryPortEnd; port += 1) {
      const socket = dgram.createSocket("udp4");
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(port, "0.0.0.0", () => {
            socket.off("error", reject);
            resolve();
          });
        });
        socket.setBroadcast(true);
        socket.on("message", (raw, remote) => {
          try {
            const request = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
            if (
              request.type !== "rabiroute.remoteAgent.client.discover"
              || request.protocolVersion !== REMOTE_AGENT_PROTOCOL_VERSION
              || !this.configStore.read().enabled
            ) return;
            const latest = this.configStore.read();
            const host = firstLocalIp();
            socket.send(Buffer.from(JSON.stringify({
              type: "rabiroute.remoteAgent.client",
              protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
              device: this.deviceInfo(),
              host,
              port: latest.port,
              controlUrl: `ws://${host}:${latest.port}/api/remote-agent/control`,
              discoveryPort: port
            })), remote.port, remote.address);
          } catch {
            // Ignore malformed discovery probes.
          }
        });
        this.discoverySocket = socket;
        this.discoveryPort = port;
        return;
      } catch (error) {
        lastError = error;
        try { socket.close(); } catch { /* best effort */ }
      }
    }
    throw new Error(`Remote Agent discovery port unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}
