function clean(value) {
  return String(value || "").trim();
}

function eventFrame(type, data, id = "") {
  const lines = [];
  if (id) lines.push(`id: ${clean(id).replace(/[\r\n]+/g, "")}`);
  lines.push(`event: ${clean(type).replace(/[^a-zA-Z0-9_.:-]/g, "_") || "message"}`);
  for (const line of JSON.stringify(data ?? {}).split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function matches(subscriber, event) {
  if (event.appId && event.appId !== subscriber.appId) return false;
  if (event.targetDeviceId
    && ![subscriber.deviceId, subscriber.deviceGuid].filter(Boolean).includes(event.targetDeviceId)) return false;
  if (event.deviceKind && subscriber.deviceKind && event.deviceKind !== subscriber.deviceKind) return false;
  return true;
}

export class RabiLinkEventHub {
  constructor({ keepAliveMs = 15000 } = {}) {
    this.keepAliveMs = Math.max(5000, Number(keepAliveMs) || 15000);
    this.subscribers = new Set();
    this.waiters = new Set();
    this.nextEventId = 1;
  }

  subscribe(response, identity) {
    const subscriber = {
      response,
      appId: clean(identity?.appId),
      deviceId: clean(identity?.deviceId),
      deviceGuid: clean(identity?.deviceGuid),
      deviceKind: clean(identity?.deviceKind),
      closed: false,
      keepAlive: null
    };
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*"
    });
    response.write("retry: 3000\n\n");
    // event-driven-allow: SSE protocol keepalive; no business state is queried.
    subscriber.keepAlive = setInterval(() => {
      if (!subscriber.closed) response.write(`: keepalive ${Date.now()}\n\n`);
    }, this.keepAliveMs);
    subscriber.keepAlive.unref?.();
    this.subscribers.add(subscriber);

    const emit = (type, data = {}) => {
      if (subscriber.closed) return;
      response.write(eventFrame(type, data, String(this.nextEventId++)));
    };
    emit("ready", { time: new Date().toISOString() });

    const close = () => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      clearInterval(subscriber.keepAlive);
      this.subscribers.delete(subscriber);
      if (!response.writableEnded) response.end();
    };
    return { emit, close };
  }

  waitFor(type, identity = {}, timeoutMs = 0) {
    const eventType = clean(type);
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    let settled = false;
    let timer = null;
    let resolvePromise = () => {};
    const waiter = {
      type: eventType,
      appId: clean(identity?.appId),
      deviceId: clean(identity?.deviceId),
      deviceGuid: clean(identity?.deviceGuid),
      deviceKind: clean(identity?.deviceKind),
      finish: (matched) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.waiters.delete(waiter);
        resolvePromise(Boolean(matched));
      }
    };
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    if (!eventType || timeout <= 0) {
      waiter.finish(false);
      return { promise, cancel: () => waiter.finish(false) };
    }
    this.waiters.add(waiter);
    timer = setTimeout(() => waiter.finish(false), timeout);
    timer.unref?.();
    return { promise, cancel: () => waiter.finish(false) };
  }

  hasSubscriber(identity = {}) {
    const appId = clean(identity?.appId);
    const deviceId = clean(identity?.deviceId);
    const deviceGuid = clean(identity?.deviceGuid);
    if (!appId || (!deviceId && !deviceGuid)) return false;
    return [...this.subscribers].some((subscriber) => {
      if (subscriber.closed || subscriber.appId !== appId) return false;
      return Boolean(
        (deviceGuid && subscriber.deviceGuid === deviceGuid)
        || (deviceId && subscriber.deviceId === deviceId)
      );
    });
  }

  publish(type, event = {}) {
    const payload = {
      type,
      time: new Date().toISOString(),
      ...(event.data && typeof event.data === "object" ? event.data : {})
    };
    for (const subscriber of this.subscribers) {
      if (!matches(subscriber, event)) continue;
      if (!subscriber.closed) subscriber.response.write(eventFrame(type, payload, String(this.nextEventId++)));
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.type !== clean(type) || !matches(waiter, event)) continue;
      waiter.finish(true);
    }
  }

  close() {
    for (const subscriber of [...this.subscribers]) {
      subscriber.closed = true;
      clearInterval(subscriber.keepAlive);
      if (!subscriber.response.writableEnded) subscriber.response.end();
      this.subscribers.delete(subscriber);
    }
    for (const waiter of [...this.waiters]) waiter.finish(false);
  }
}

export { eventFrame };
