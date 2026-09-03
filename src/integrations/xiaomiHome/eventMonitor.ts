import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import {
  resolveXiaomiHomeManagerConfig,
  xiaomiHomeResourceId,
  type XiaomiHomeManagerConfigInput
} from "./managerApi.js";
import type { XiaomiHomeArtifactPublicRecord } from "./artifactStore.js";
import type { XiaomiMiotMotionClipCandidate } from "./clipCapture.js";

type HomeAssistantState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

type HomeAssistantStateChanged = {
  event_type?: string;
  time_fired?: string;
  data?: {
    entity_id?: string;
    old_state?: HomeAssistantState | null;
    new_state?: HomeAssistantState | null;
  };
};

type SocketLike = {
  on(event: "message", listener: (data: unknown) => void): SocketLike;
  on(event: "close" | "error" | "open", listener: () => void): SocketLike;
  send(data: string): void;
  close(): void;
};

export type XiaomiHomeEventMonitorConfig = XiaomiHomeManagerConfigInput & {
  agentRoleId?: string;
  eventMonitorEnabled?: boolean;
  eventDeliveryMode?: "significant" | "all";
  cameraMotionEntityIds?: readonly string[];
};

type XiaomiHomeEventMonitorDependencies = {
  credentialToken?: string;
  createSocket?: (url: string) => SocketLike;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
  captureMotionClip?: (candidate: XiaomiMiotMotionClipCandidate) => Promise<XiaomiHomeArtifactPublicRecord>;
  reconnectDelayMs?: number;
};

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function eventId(state: HomeAssistantState, occurredAt: string): string {
  return `xiaomi-home:${createHash("sha256").update(`${state.entity_id}\n${state.state}\n${occurredAt}\n${JSON.stringify(state.attributes ?? {})}`).digest("hex").slice(0, 32)}`;
}

function attributeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  const text = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return new Date(number > 10_000_000_000 ? number : number * 1000).toISOString();
  }
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

export function xiaomiMiotMotionClipFromStateChange(change: HomeAssistantStateChanged): XiaomiMiotMotionClipCandidate | undefined {
  if (change.event_type !== "state_changed") return undefined;
  const state = change.data?.new_state;
  if (!state?.entity_id) return undefined;
  const attributes = state.attributes ?? {};
  const playlistUrl = String(attributes.motion_video_latest ?? "").trim();
  if (!playlistUrl) return undefined;
  const oldAttributes = change.data?.old_state?.attributes ?? {};
  const rawTime = attributes.motion_video_time;
  if (String(oldAttributes.motion_video_latest ?? "") === playlistUrl
    && String(oldAttributes.motion_video_time ?? "") === String(rawTime ?? "")) return undefined;
  const fallback = change.time_fired || state.last_updated || state.last_changed || new Date().toISOString();
  const occurredAt = attributeTimestamp(rawTime, fallback);
  const resourceName = String(attributes.friendly_name || state.entity_id);
  const eventType = String(attributes.motion_video_type || "camera_motion_detected");
  const sourceEventId = `xiaomi-miot-clip:${createHash("sha256").update(`${state.entity_id}\n${occurredAt}\n${eventType}\n${playlistUrl}`).digest("hex").slice(0, 32)}`;
  return {
    sourceEventId,
    resourceId: xiaomiHomeResourceId(state.entity_id),
    resourceName,
    occurredAt,
    eventType,
    playlistUrl,
    thumbnailUrl: String(attributes.motion_image ?? "").trim() || undefined
  };
}

function normalizedWords(state: HomeAssistantState): string {
  const attributes = state.attributes ?? {};
  return [state.entity_id, attributes.friendly_name, attributes.device_class, attributes.event_type]
    .map(value => String(value ?? "").toLowerCase())
    .join(" ");
}

function isMotionState(state: HomeAssistantState): boolean {
  const deviceClass = String(state.attributes?.device_class ?? "").toLowerCase();
  if (["motion", "occupancy", "presence"].includes(deviceClass)) return state.state === "on";
  const words = normalizedWords(state);
  return state.entity_id.startsWith("event.") && /(motion|occupancy|presence|person|human|有人|移动|人体)/i.test(words);
}

function isCameraMotionState(state: HomeAssistantState, configuredIds: ReadonlySet<string>): boolean {
  if (!isMotionState(state)) return false;
  if (configuredIds.has(state.entity_id.toLowerCase())) return true;
  return /(camera|doorbell|摄像|门铃)/i.test(normalizedWords(state));
}

export function xiaomiHomeEventFromHomeAssistantStateChange(
  change: HomeAssistantStateChanged,
  options: { deliveryMode?: "significant" | "all"; cameraMotionEntityIds?: readonly string[] } = {}
): XiaomiHomeEvent | undefined {
  if (change.event_type !== "state_changed") return undefined;
  const state = change.data?.new_state;
  if (!state?.entity_id) return undefined;
  const motionClip = xiaomiMiotMotionClipFromStateChange(change);
  if (motionClip) {
    return {
      id: motionClip.sourceEventId,
      kind: "camera_motion_detected",
      resourceId: motionClip.resourceId,
      resourceName: motionClip.resourceName,
      occurredAt: motionClip.occurredAt,
      summary: `${motionClip.resourceName} 检测到有人移动，事件录像地址已更新`
    };
  }
  const occurredAt = change.time_fired || state.last_updated || state.last_changed || new Date().toISOString();
  const resourceName = String(state.attributes?.friendly_name || state.entity_id);
  const configuredIds = new Set((options.cameraMotionEntityIds ?? []).map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean));
  let kind: XiaomiHomeEvent["kind"];
  let summary: string;
  if (state.state === "unavailable") {
    kind = "device_offline";
    summary = `${resourceName} 已离线`;
  } else if (isCameraMotionState(state, configuredIds)) {
    kind = "camera_motion_detected";
    summary = `${resourceName} 检测到有人移动`;
  } else if (isMotionState(state) || state.entity_id.startsWith("event.")) {
    kind = "sensor_alert";
    summary = `${resourceName} 触发事件`;
  } else if (options.deliveryMode === "all") {
    kind = "device_state_changed";
    summary = `${resourceName} 状态变为 ${state.state}`;
  } else {
    return undefined;
  }
  return {
    id: eventId(state, occurredAt),
    kind,
    resourceId: xiaomiHomeResourceId(state.entity_id),
    resourceName,
    occurredAt,
    summary
  };
}

export class XiaomiHomeEventMonitor {
  private readonly resolved;
  private readonly token: string;
  private readonly agentRoleId: string;
  private readonly enabled: boolean;
  private readonly deliveryMode: "significant" | "all";
  private readonly cameraMotionEntityIds: string[];
  private readonly createSocket: (url: string) => SocketLike;
  private readonly reconnectDelayMs: number;
  private socket?: SocketLike;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private subscriptionId = 1;
  private connectionState: "disabled" | "authorization_required" | "stopped" | "connecting" | "authorizing" | "subscribing" | "subscribed" | "authorization_failed" | "reconnecting" = "stopped";

  constructor(config: XiaomiHomeEventMonitorConfig, private readonly dependencies: XiaomiHomeEventMonitorDependencies) {
    this.resolved = resolveXiaomiHomeManagerConfig(config);
    this.token = String(dependencies.credentialToken || "").trim();
    this.agentRoleId = String(config.agentRoleId || "YeYu").trim();
    this.enabled = config.eventMonitorEnabled !== false;
    this.deliveryMode = config.eventDeliveryMode === "all" ? "all" : "significant";
    this.cameraMotionEntityIds = Array.isArray(config.cameraMotionEntityIds) ? config.cameraMotionEntityIds : [];
    this.createSocket = dependencies.createSocket ?? (url => new WebSocket(url) as unknown as SocketLike);
    this.reconnectDelayMs = dependencies.reconnectDelayMs ?? 5000;
    this.connectionState = !this.enabled ? "disabled" : !this.token ? "authorization_required" : "stopped";
  }

  start(): boolean {
    if (!this.enabled) {
      this.connectionState = "disabled";
      return false;
    }
    if (!this.token) {
      this.connectionState = "authorization_required";
      return false;
    }
    if (!this.agentRoleId) {
      this.connectionState = "stopped";
      return false;
    }
    if (!this.stopped) return true;
    this.stopped = false;
    this.connectionState = "connecting";
    this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.connectionState = !this.enabled ? "disabled" : !this.token ? "authorization_required" : "stopped";
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      authorizationConfigured: Boolean(this.token),
      running: !this.stopped,
      connectionState: this.connectionState,
      deliveryMode: this.deliveryMode,
      cameraMotionEntityCount: this.cameraMotionEntityIds.length,
      agentRoleConfigured: Boolean(this.agentRoleId)
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.connectionState = "connecting";
    let socket: SocketLike;
    try {
      socket = this.createSocket(websocketUrl(this.resolved.baseUrl));
    } catch {
      this.connectionState = "reconnecting";
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
      return;
    }
    this.socket = socket;
    socket.on("message", data => this.handleMessage(data));
    socket.on("error", () => {
      this.connectionState = "reconnecting";
      socket.close();
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.stopped) {
        this.connectionState = this.connectionState === "authorization_failed" ? "authorization_failed" : "reconnecting";
        if (this.connectionState !== "authorization_failed") this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
      }
    });
  }

  private handleMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      const value = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      message = JSON.parse(value) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "auth_required") {
      this.connectionState = "authorizing";
      this.socket?.send(JSON.stringify({ type: "auth", access_token: this.token }));
      return;
    }
    if (message.type === "auth_invalid") {
      this.connectionState = "authorization_failed";
      this.socket?.close();
      return;
    }
    if (message.type === "auth_ok") {
      this.connectionState = "subscribing";
      this.socket?.send(JSON.stringify({ id: this.subscriptionId, type: "subscribe_events", event_type: "state_changed" }));
      return;
    }
    if (message.type === "result" && Number(message.id) === this.subscriptionId) {
      this.connectionState = message.success === true ? "subscribed" : "reconnecting";
      if (message.success !== true) this.socket?.close();
      return;
    }
    if (message.type !== "event" || Number(message.id) !== this.subscriptionId) return;
    this.connectionState = "subscribed";
    const stateChange = message.event as HomeAssistantStateChanged;
    const motionClip = xiaomiMiotMotionClipFromStateChange(stateChange);
    const event = xiaomiHomeEventFromHomeAssistantStateChange(stateChange, {
      deliveryMode: this.deliveryMode,
      cameraMotionEntityIds: this.cameraMotionEntityIds
    });
    if (event) void this.dependencies.deliverEvent(event, { agentRoleId: this.agentRoleId }).catch(() => undefined);
    if (motionClip && this.dependencies.captureMotionClip) {
      void this.dependencies.captureMotionClip(motionClip).then(artifact => this.dependencies.deliverEvent({
        id: `${motionClip.sourceEventId}:ready`,
        kind: "camera_clip_ready",
        resourceId: motionClip.resourceId,
        resourceName: motionClip.resourceName,
        occurredAt: motionClip.occurredAt,
        summary: `${motionClip.resourceName} 的移动事件录像已保存`,
        artifactId: artifact.artifactId
      }, { agentRoleId: this.agentRoleId })).catch(() => this.dependencies.deliverEvent({
        id: `${motionClip.sourceEventId}:capture-failed`,
        kind: "action_failed",
        resourceId: motionClip.resourceId,
        resourceName: motionClip.resourceName,
        occurredAt: new Date().toISOString(),
        summary: `${motionClip.resourceName} 的移动事件录像抓取失败`
      }, { agentRoleId: this.agentRoleId }).catch(() => undefined));
    }
  }
}
