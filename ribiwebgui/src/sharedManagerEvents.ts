type EventHandler<T extends Event> = ((this: EventSource, event: T) => unknown) | null;

type SharedConnection = {
  source: EventSource;
  clients: Set<ManagerEventSubscription>;
  ready?: MessageEvent;
};

const connections = new Map<string, SharedConnection>();

function copyEvent(event: Event): Event {
  return event instanceof MessageEvent ? new MessageEvent(event.type, {
    data: event.data, origin: event.origin, lastEventId: event.lastEventId
  }) : new Event(event.type);
}

/** Each component owns its listeners while the document shares one HTTP stream. */
class ManagerEventSubscription extends EventTarget implements EventSource {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  onopen: EventHandler<Event> = null;
  onerror: EventHandler<Event> = null;
  onmessage: EventHandler<MessageEvent> = null;
  private readonly forwarders = new Map<string, EventListener>();
  private closed = false;

  constructor(private readonly connection: SharedConnection, private readonly key: string) {
    super();
    connection.clients.add(this);
    super.addEventListener("open", event => this.onopen?.(event));
    super.addEventListener("error", event => this.onerror?.(event));
    super.addEventListener("message", event => this.onmessage?.(event as MessageEvent));
    for (const type of ["open", "error", "message"]) this.forward(type);
    if (connection.source.readyState === this.OPEN) {
      const ready = connection.ready;
      queueMicrotask(() => {
        if (this.readyState !== this.OPEN) return;
        this.deliver(new Event("open"));
        if (ready && !this.closed && connection.ready === ready) this.deliver(ready);
      });
    }
  }

  get url(): string { return this.connection.source.url; }
  get withCredentials(): boolean { return this.connection.source.withCredentials; }
  get readyState(): number { return this.closed ? this.CLOSED : this.connection.source.readyState; }

  private deliver(event: Event): void {
    this.dispatchEvent(copyEvent(event));
  }

  private forward(type: string): void {
    if (this.closed || this.forwarders.has(type)) return;
    const listener: EventListener = event => { if (!this.closed) this.deliver(event); };
    this.forwarders.set(type, listener);
    this.connection.source.addEventListener(type, listener);
  }

  override addEventListener<K extends keyof EventSourceEventMap>(type: K, callback: (this: EventSource, event: EventSourceEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, callback: (this: EventSource, event: MessageEvent) => unknown, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, callback: unknown, options?: boolean | AddEventListenerOptions): void {
    this.forward(type);
    super.addEventListener(type, callback as EventListenerOrEventListenerObject | null, options);
  }

  override removeEventListener<K extends keyof EventSourceEventMap>(type: K, callback: (this: EventSource, event: EventSourceEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, callback: (this: EventSource, event: MessageEvent) => unknown, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, callback: unknown, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, callback as EventListenerOrEventListenerObject | null, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const { source, clients } = this.connection;
    for (const [type, listener] of this.forwarders) source.removeEventListener(type, listener);
    this.forwarders.clear();
    clients.delete(this);
    if (clients.size === 0) {
      source.close();
      if (connections.get(this.key) === this.connection) connections.delete(this.key);
    }
  }
}

export function subscribeToManagerEvents(url: string): EventSource {
  let connection = connections.get(url);
  if (!connection || connection.source.readyState === 2) {
    const source = new EventSource(url);
    const shared: SharedConnection = { source, clients: new Set() };
    source.addEventListener("ready", event => { shared.ready = event as MessageEvent; });
    source.addEventListener("error", () => { shared.ready = undefined; });
    connection = shared;
    connections.set(url, shared);
  }
  return new ManagerEventSubscription(connection, url);
}
