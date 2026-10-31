import type { ApiOperationDefinition, ApiOperationStream } from "./apiOperationContract.js";

export const MANAGER_EVENT_LIMITS = Object.freeze({ subscribers: 128, queuedFrames: 64, queuedBytes: 4 * 1024 * 1024,
  frameBytes: 4 * 1024 * 1024, heartbeatMs: 15_000, retryMs: 3000 });
type Frame = Readonly<{ event?: string; data?: unknown; retry?: number; comment?: string }>;
type QueuedFrame = { frame: Frame; bytes: number };
type Subscriber = { queue: QueuedFrame[]; bytes: number; closed: boolean; controller: AbortController; wake?: () => void };
type EventLimits = { readonly [Key in keyof typeof MANAGER_EVENT_LIMITS]: number };

/** One publication owner for business events and protocol keepalives; never executes subscriber code while publishing. */
export class ManagerEventHub {
  private readonly subscribers = new Set<Subscriber>();
  private unsubscribe?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  readonly limits: EventLimits;
  private readonly subscribe?: (publish: (event: string, data: unknown) => void) => () => void;

  constructor(options: {
    subscribe?(publish: (event: string, data: unknown) => void): () => void;
    limits?: Partial<EventLimits>;
  } = {}) {
    const limits = { ...MANAGER_EVENT_LIMITS, ...options.limits };
    for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Manager event resource limit.");
    this.limits = Object.freeze(limits); this.subscribe = options.subscribe;
    const initial = [this.prepare({ retry: limits.retryMs }), this.prepare({ event: "ready", data: {} })];
    if (limits.queuedFrames < initial.length || limits.queuedBytes < initial.reduce((size, value) => size + value.bytes, 0)
      || initial.some(value => value.bytes > limits.frameBytes)) throw new Error("Manager event limits cannot hold the initial protocol frames.");
  }

  private prepare(frame: Frame): QueuedFrame {
    const json = JSON.stringify(frame);
    return { frame: JSON.parse(json), bytes: Buffer.byteLength(json, "utf8") };
  }
  private push(subscriber: Subscriber, frame: QueuedFrame): void {
    if (subscriber.closed) return;
    const limits = this.limits;
    if (subscriber.queue.length >= limits.queuedFrames || subscriber.bytes + frame.bytes > limits.queuedBytes || frame.bytes > limits.frameBytes) {
      this.close(subscriber, new Error("Manager event queue capacity exceeded.")); return;
    }
    subscriber.queue.push(frame); subscriber.bytes += frame.bytes;
    subscriber.wake?.(); subscriber.wake = undefined;
  }
  private close(subscriber: Subscriber, failure?: Error): void {
    if (subscriber.closed) return;
    subscriber.closed = true; subscriber.queue.length = 0; subscriber.bytes = 0;
    if (failure) subscriber.controller.abort(failure);
    subscriber.wake?.(); subscriber.wake = undefined; this.subscribers.delete(subscriber);
    if (!this.subscribers.size) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
      unsubscribe?.();
    }
  }
  publish(event: string, data: unknown): void {
    if (!this.subscribers.size) return;
    let frame: QueuedFrame;
    try { frame = this.prepare({ event: event.replace(/[^a-zA-Z0-9_.:-]/g, "_"), data: data === undefined ? null : data }); }
    catch { return; } // An invalid notification must not fail an already committed business write.
    for (const subscriber of [...this.subscribers]) this.push(subscriber, frame);
  }
  open(): ApiOperationStream | undefined {
    if (this.subscribers.size >= this.limits.subscribers) return undefined;
    const subscriber: Subscriber = { queue: [], bytes: 0, closed: false, controller: new AbortController() };
    this.subscribers.add(subscriber);
    try {
      this.push(subscriber, this.prepare({ retry: this.limits.retryMs }));
      this.push(subscriber, this.prepare({ event: "ready", data: {} }));
      if (this.subscribers.size === 1) {
        const unsubscribe = this.subscribe?.((event, data) => this.publish(event, data));
        if (!this.subscribers.size) { unsubscribe?.(); return undefined; }
        this.unsubscribe = unsubscribe;
        // event-driven-allow: SSE protocol keepalive; no business state is queried.
        this.heartbeat = setInterval(() => {
          const frame = this.prepare({ comment: `keepalive ${Date.now()}` });
          for (const client of [...this.subscribers]) this.push(client, frame);
        }, this.limits.heartbeatMs);
        this.heartbeat.unref?.();
      }
    } catch (error) { this.close(subscriber); throw error; }
    const close = () => this.close(subscriber);
    return { frames: (async function* () {
      try {
        while (!subscriber.closed) {
          const next = subscriber.queue.shift();
          if (next) { subscriber.bytes -= next.bytes; yield next.frame; continue; }
          await new Promise<void>(resolve => { subscriber.wake = resolve; });
        }
      } finally { close(); }
    })(), signal: subscriber.controller.signal, cancel: close };
  }
  closeAll(): void { for (const subscriber of [...this.subscribers]) this.close(subscriber); }
  activeSubscriberCount(): number { return this.subscribers.size; }
}

export function createManagerEventsOperation(hub: ManagerEventHub): ApiOperationDefinition {
  const empty = { type: "object", properties: {}, additionalProperties: false } as const;
  return { contract: {
    operationId: "manager.events", contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/events",
    description: "Subscribe to the current Manager event stream; reconnect and refresh state after disconnection rather than replaying business writes.",
    exposure: "public", transport: "sse",
    request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "text/event-stream; charset=utf-8", stream: { framing: "sse-json", maxFrameBytes: hub.limits.frameBytes,
      frameSchema: { type: "object", additionalProperties: false, properties: { event: { type: "string" }, data: true,
        retry: { type: "integer", minimum: 0 }, comment: { type: "string" } },
        anyOf: [{ required: ["event", "data"], properties: { event: true, data: true } }, { required: ["retry"], properties: { retry: true } }, { required: ["comment"], properties: { comment: true } }] },
      completion: "EOF when the subscription closes; delivery of an event is not completion of the referenced business operation.",
      cancellation: "Client disconnect or activation retirement stops the subscription, discards queued frames and drains producer cleanup before releasing the old operation lease." } },
      "429": { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode", "retryable"], additionalProperties: false,
        properties: { code: { const: -1 }, errorCode: { const: "MANAGER_EVENT_CAPACITY" }, retryable: { const: false } } } } },
    effects: { mode: "subscription", description: "Keeps one bounded in-memory notification subscription and shared keepalive/knowledge event listener. Does not run the referenced business actions." },
    recovery: { strategy: "reconnect-and-refresh", description: "The stream has no durable replay cursor. On EOF/reconnect, refresh current resources and API discovery under the current Manager identity; never replay writes because an event was missed." },
    validators: [{ id: "manager.events.capacity", description: `All admitted callers share limits of ${hub.limits.subscribers} subscriptions, ${hub.limits.queuedFrames} queued frames and ${hub.limits.queuedBytes} queued bytes per subscriber. Slow consumers close on queue overflow. Only protocol keepalive uses a timer; no business polling is added.` }]
  }, handler: () => {
    const stream = hub.open();
    return stream ? { status: 200, stream, headers: { "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } }
      : { status: 429, body: { code: -1, errorCode: "MANAGER_EVENT_CAPACITY", retryable: false } };
  } };
}
