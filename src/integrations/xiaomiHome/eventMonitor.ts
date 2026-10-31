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
import { cameraEventId, type CameraEventAdapter } from "./cameraEvents.js";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";

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
  monitoredEntityIds?: readonly string[];
};

type XiaomiHomeEventMonitorDependencies = {
  credentialToken?: string;
  createSocket?: (url: string) => SocketLike;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
  captureMotionClip?: (candidate: XiaomiMiotMotionClipCandidate) => Promise<XiaomiHomeArtifactPublicRecord>;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  recoverConnection?: () => Promise<void>;
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
  const cameraId = String(attributes.did ?? state.entity_id).trim();
  const sourceEventId = cameraEventId("xiaomi-miot", cameraId, occurredAt, eventType);
  return {
    sourceEventId,
    cameraId,
    resourceId: xiaomiHomeResourceId(state.entity_id),
    resourceName,
    occurredAt,
    eventType,
    playlistUrl,
    thumbnailUrl: String(attributes.motion_image ?? "").trim() || undefined
  };
}

export const xiaomiMiotCameraAdapter: CameraEventAdapter<HomeAssistantStateChanged> = {
  id: "xiaomi-miot",
  event(change) {
    const candidate = xiaomiMiotMotionClipFromStateChange(change);
    if (!candidate) return undefined;
    return { eventId: candidate.sourceEventId, cameraId: candidate.cameraId!, adapterId: "xiaomi-miot",
      occurredAt: candidate.occurredAt, kind: candidate.eventType, resourceId: candidate.resourceId };
  }
};

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
  options: {
    deliveryMode?: "significant" | "all";
    cameraMotionEntityIds?: readonly string[];
    monitoredEntityIds?: readonly string[];
  } = {}
): XiaomiHomeEvent | undefined {
  if (change.event_type !== "state_changed") return undefined;
  const state = change.data?.new_state;
  if (!state?.entity_id) return undefined;
    const motionClip = xiaomiMiotMotionClipFromStateChange(change);
  const cameraEvent = xiaomiMiotCameraAdapter.event(change);
  if (motionClip && cameraEvent) {
    return {
      id: cameraEvent.eventId,
      cameraId: cameraEvent.cameraId,
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
  const monitoredIds = new Set((options.monitoredEntityIds ?? []).map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean));
  const normalizedEntityId = state.entity_id.toLowerCase();
  const oldState = change.data?.old_state;
  const isStateChanged = !oldState || oldState.state !== state.state;

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
  } else if (
    isStateChanged && (
      options.deliveryMode === "all"
      || monitoredIds.has(normalizedEntityId)
    )
  ) {
    const unit = state.attributes?.unit_of_measurement ? ` ${state.attributes.unit_of_measurement}` : "";
    kind = "device_state_changed";
    summary = `${resourceName} 状态变为 ${state.state}${unit}`;
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
  private readonly monitoredEntityIds: string[];
  private readonly createSocket: (url: string) => SocketLike;
  private readonly reconnectDelayMs: number;
  private socket?: SocketLike;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatDeadline?: NodeJS.Timeout;
  private pendingPingId?: number;
  private nextPingId = 2;
  private lastEventAt?: string;
  private lastTransportError?: string;
  private lastDeliveryState?: "accepted" | "missed" | "failed";
  private stopped = true;
  private subscriptionId = 1;
  private connectionState: "disabled" | "authorization_required" | "stopped" | "connecting" | "authorizing" | "subscribing" | "subscribed" | "authorization_failed" | "reconnecting" = "stopped";

  constructor(config: XiaomiHomeEventMonitorConfig, private readonly dependencies: XiaomiHomeEventMonitorDependencies) {
    this.resolved = resolveXiaomiHomeManagerConfig(config);
    this.token = String(dependencies.credentialToken || "").trim();
    this.agentRoleId = String(config.agentRoleId ?? "").trim();
    this.enabled = config.eventMonitorEnabled !== false;
    this.deliveryMode = config.eventDeliveryMode === "all" ? "all" : "significant";
    this.cameraMotionEntityIds = Array.isArray(config.cameraMotionEntityIds) ? config.cameraMotionEntityIds : [];
    this.monitoredEntityIds = Array.isArray(config.monitoredEntityIds) ? config.monitoredEntityIds : [];
    this.createSocket = dependencies.createSocket ?? (url => new WebSocket(url, { handshakeTimeout: this.resolved.requestTimeoutMs }) as unknown as SocketLike);
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
    this.clearHeartbeat();
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
      monitoredEntityCount: this.monitoredEntityIds.length,
      agentRoleConfigured: Boolean(this.agentRoleId),
      ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}),
      ...(this.lastTransportError ? { lastTransportError: this.lastTransportError } : {}),
      ...(this.lastDeliveryState ? { lastDeliveryState: this.lastDeliveryState } : {})
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
      void this.dependencies.recoverConnection?.().catch(() => undefined);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
      return;
    }
    this.socket = socket;
    this.heartbeatDeadline = setTimeout(() => {
      if (this.stopped || this.socket !== socket || this.connectionState === "subscribed") return;
      this.lastTransportError = "subscription_timeout";
      this.connectionState = "reconnecting";
      socket.close();
    }, this.resolved.requestTimeoutMs);
    this.heartbeatDeadline.unref?.();
    socket.on("message", data => { if (!this.stopped && this.socket === socket) this.handleMessage(data); });
    socket.on("error", () => {
      if (this.stopped || this.socket !== socket) return;
      this.lastTransportError = "socket_error";
      this.connectionState = "reconnecting";
      socket.close();
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearHeartbeat();
      if (!this.stopped) {
        this.connectionState = this.connectionState === "authorization_failed" ? "authorization_failed" : "reconnecting";
        if (this.connectionState !== "authorization_failed") {
          void this.dependencies.recoverConnection?.().catch(() => undefined);
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
        }
      }
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = undefined;
    this.heartbeatDeadline = undefined;
    this.pendingPingId = undefined;
  }

  private async deliver(event: XiaomiHomeEvent): Promise<void> {
    try {
      const result = await this.dependencies.deliverEvent(event, { agentRoleId: this.agentRoleId });
      const missed = Array.isArray(result) && result.some(item => item?.status === "missed" || item?.status === "failed");
      this.lastDeliveryState = missed ? "missed" : "accepted";
      if (!missed) return;
    } catch { this.lastDeliveryState = "failed"; }
    recordDataMutationAudit({ group: "xiaomi-home", event: "xiaomi_home_event_delivery_failed", owner: "xiaomi-home-event-monitor",
      action: "deliver", target: { type: "event", id: event.id }, dataSource: { kind: "runtime", id: "xiaomi-home-event-delivery" },
      outcome: "failed", result: this.lastDeliveryState });
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    if (this.stopped || !this.socket) return;
    const socket = this.socket;
    this.heartbeatTimer = setTimeout(() => {
      if (this.stopped || this.socket !== socket) return;
      this.pendingPingId = this.nextPingId++;
      this.heartbeatDeadline = setTimeout(() => {
        if (this.stopped || this.socket !== socket) return;
        this.lastTransportError = "heartbeat_timeout";
        this.connectionState = "reconnecting";
        socket.close();
      }, this.resolved.requestTimeoutMs);
      this.heartbeatDeadline.unref?.();
      try { socket.send(JSON.stringify({ id: this.pendingPingId, type: "ping" })); }
      catch { this.lastTransportError = "heartbeat_send_failed"; socket.close(); }
    }, Math.max(1000, this.dependencies.heartbeatIntervalMs ?? 30000));
    this.heartbeatTimer.unref?.();
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
    if (message.type === "pong" && Number(message.id) === this.pendingPingId) {
      this.lastTransportError = undefined;
      this.scheduleHeartbeat();
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
      if (message.success === true) this.scheduleHeartbeat();
      if (message.success !== true) this.socket?.close();
      return;
    }
    if (message.type !== "event" || Number(message.id) !== this.subscriptionId) return;
    this.connectionState = "subscribed";
    this.lastEventAt = new Date().toISOString();
    try { this.handleStateChange(message.event as HomeAssistantStateChanged); }
    catch {
      recordDataMutationAudit({ group: "xiaomi-home", event: "xiaomi_home_event_processing_failed", owner: "xiaomi-home-event-monitor",
        action: "normalize-event", target: { type: "event", id: "home-assistant-state-change" },
        dataSource: { kind: "runtime", id: "home-assistant-websocket" }, outcome: "failed" });
    }
  }

  private handleStateChange(stateChange: HomeAssistantStateChanged): void {
    const motionClip = xiaomiMiotMotionClipFromStateChange(stateChange);
    const event = xiaomiHomeEventFromHomeAssistantStateChange(stateChange, {
      deliveryMode: this.deliveryMode,
      cameraMotionEntityIds: this.cameraMotionEntityIds,
      monitoredEntityIds: this.monitoredEntityIds
    });
    if (event) void this.deliver(event);
    if (motionClip && this.dependencies.captureMotionClip) {
      void this.dependencies.captureMotionClip(motionClip).then(artifact => this.deliver({
        id: `${motionClip.sourceEventId}:ready`,
        kind: "camera_clip_ready",
        resourceId: motionClip.resourceId,
        resourceName: motionClip.resourceName,
        occurredAt: motionClip.occurredAt,
        summary: `${motionClip.resourceName} 的移动事件录像已保存`,
        artifactId: artifact.artifactId,
        sourceEventId: motionClip.sourceEventId,
        cameraId: motionClip.cameraId
      }), () => this.deliver({
        id: `${motionClip.sourceEventId}:capture-failed`,
        kind: "action_failed",
        resourceId: motionClip.resourceId,
        resourceName: motionClip.resourceName,
        occurredAt: new Date().toISOString(),
        summary: `${motionClip.resourceName} 的移动事件录像抓取失败`,
        sourceEventId: motionClip.sourceEventId,
        cameraId: motionClip.cameraId
      }));
    }
  }
}
