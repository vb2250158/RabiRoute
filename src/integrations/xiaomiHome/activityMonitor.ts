import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type { HomeAssistantActivityPort, HomeAssistantActivityRecord, HomeAssistantActivityRequest } from "../../shared/homeAssistantActivity.js";

type SocketLike = Pick<WebSocket, "on" | "send" | "close">;
type Dependencies = { port: HomeAssistantActivityPort; credentialToken?: string; createSocket?: (url: string) => SocketLike; reconnectDelayMs?: number };

/** Matches HA's logbook/event_stream, including ordinary states and custom activity. */
export function homeAssistantActivityRecord(input: unknown, names: ReadonlyMap<string, string>): HomeAssistantActivityRecord | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const occurredAt = Number(row.when) * 1000;
  if (typeof row.when !== "number" || !Number.isFinite(occurredAt) || occurredAt <= 0 || occurredAt > Date.now() + 60_000) return null;
  const string = (key: string) => typeof row[key] === "string" ? (row[key] as string).slice(0, 100000) : undefined;
  const entityId = string("entity_id"), domain = string("domain"), state = string("state"), message = string("message");
  if (state === undefined && !message) return null;
  const name = string("name") || (entityId && names.get(entityId)) || entityId || domain || "Home Assistant";
  // Names are presentation data and may change between reconnects.
  const identity = [row.when, entityId, domain, state, message, string("context_id"), string("source")];
  return {
    id: `logbook:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    occurredAt, entityId, domain, name, state,
    text: state !== undefined ? `${name} → ${state}` : `${name} ${message}`
  };
}

/** One credential-bound Activity owner; the recording owner controls its lifetime. */
export class HomeAssistantActivityMonitor {
  private request: HomeAssistantActivityRequest | null = null;
  private socket?: SocketLike;
  private unsubscribe?: () => void;
  private retry?: NodeJS.Timeout;
  private names = new Map<string, string>();
  private state = "stopped";
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly baseUrl: string, private readonly dependencies: Dependencies) {}
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.dependencies.port.subscribe(request => {
      if (request?.roleId === this.request?.roleId && request?.startedAt === this.request?.startedAt) return;
      this.close(); this.request = request;
      if (request) this.connect();
    });
  }
  async stop(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.request = null; this.close(); await this.pending;
  }
  status() { return { state: this.state, recording: !!this.request }; }
  private close(): void {
    clearTimeout(this.retry); this.retry = undefined;
    const socket = this.socket; this.socket = undefined;
    socket?.close(); this.state = "stopped";
  }
  private report(error: string): void {
    if (this.request) this.dependencies.port.report(this.request.roleId, error);
  }
  private reconnect(socket: SocketLike): void {
    if (socket !== this.socket) return;
    this.socket = undefined; this.state = "reconnecting";
    this.report("Home Assistant 活动连接中断，正在重连");
    this.retry = setTimeout(() => this.connect(), this.dependencies.reconnectDelayMs ?? 5000);
    this.retry.unref();
  }
  private connect(): void {
    const request = this.request;
    if (!request) return;
    if (!this.dependencies.credentialToken) {
      this.state = "authorization_required"; this.report("请先连接 Home Assistant"); return;
    }
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`; url.search = ""; url.hash = "";
    this.state = "connecting"; this.report("正在连接 Home Assistant 活动");
    let socket: SocketLike;
    try { socket = (this.dependencies.createSocket ?? (address => new WebSocket(address)))(url.toString()); }
    catch { this.report("Home Assistant 活动连接失败"); this.retry = setTimeout(() => this.connect(), this.dependencies.reconnectDelayMs ?? 5000); this.retry.unref(); return; }
    this.socket = socket;
    socket.on("error", () => socket.close());
    socket.on("close", () => this.reconnect(socket));
    socket.on("message", raw => {
      if (socket !== this.socket || request !== this.request) return;
      let row: Record<string, unknown>;
      try { row = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (row.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.dependencies.credentialToken }));
      else if (row.type === "auth_invalid") {
        this.socket = undefined; socket.close(); this.state = "authorization_failed"; this.report("Home Assistant 授权失效，请重新连接");
      } else if (row.type === "auth_ok") {
        socket.send(JSON.stringify({ id: 1, type: "get_states" }));
      } else if (row.type === "result" && row.id === 1) {
        this.names.clear();
        if (row.success && Array.isArray(row.result)) for (const item of row.result) {
          if (typeof item?.entity_id === "string" && typeof item?.attributes?.friendly_name === "string") this.names.set(item.entity_id, item.attributes.friendly_name);
        }
        socket.send(JSON.stringify({ id: 2, type: "logbook/event_stream", start_time: new Date(Math.max(request.startedAt, Date.now() - 24 * 3600_000)).toISOString() }));
      } else if (row.type === "result" && row.id === 2) {
        if (row.success) { this.state = "subscribed"; this.report(""); }
        else { this.state = "unavailable"; this.report("Home Assistant 活动订阅失败，请检查 Activity / logbook 与授权"); this.socket = undefined; socket.close(); }
      } else if (row.type === "event" && row.id === 2) {
        const payload = row.event as { events?: unknown[] } | undefined;
        if (!Array.isArray(payload?.events)) return;
        const events = payload.events.map(entry => homeAssistantActivityRecord(entry, this.names)).filter((entry): entry is HomeAssistantActivityRecord => !!entry && entry.occurredAt >= request.startedAt);
        this.pending = this.pending.then(async () => {
          for (const event of events) {
            if (this.request !== request) return;
            await this.dependencies.port.receive(request.roleId, event);
          }
        }).catch(() => this.report("Home Assistant 活动保存失败"));
      }
    });
  }
}
