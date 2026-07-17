import { randomUUID } from "node:crypto";

/**
 * Short-lived request/response queue for capabilities that are executed by a
 * selected Rabi PC. Payloads stay in memory and are removed after their short
 * retention window; this queue is intentionally not a durable event store.
 */
export class RelayProxyRequestQueue {
  constructor({ name, idPrefix, requestWaitMs, leaseMs, retentionMs }) {
    this.name = name;
    this.idPrefix = idPrefix;
    this.requestWaitMs = requestWaitMs;
    this.leaseMs = leaseMs;
    this.retentionMs = retentionMs;
    this.requests = new Map();
    this.claimWaiters = [];
    this.completionWaiters = new Map();
  }

  create(input) {
    const now = Date.now();
    const request = {
      id: `${this.idPrefix}-${now}-${randomUUID().slice(0, 8)}`,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.requestWaitMs,
      leaseUntil: 0,
      attempts: 0,
      appId: input.appId || "",
      appName: input.appName || "",
      targetDeviceId: input.targetDeviceId || "",
      method: String(input.method || "GET").toUpperCase(),
      path: input.path || "/",
      headers: { ...(input.headers || {}) },
      bodyBase64: input.bodyBase64 || "",
      response: null,
      error: ""
    };
    this.requests.set(request.id, request);
    this.#notifyClaimWaiters();
    return request;
  }

  get(requestId) {
    this.cleanup();
    return this.requests.get(requestId) || null;
  }

  forTransport(request) {
    return {
      id: request.id,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      expiresAt: request.expiresAt,
      attempts: request.attempts,
      appId: request.appId,
      appName: request.appName,
      targetDeviceId: request.targetDeviceId,
      method: request.method,
      path: request.path,
      headers: request.headers,
      bodyBase64: request.bodyBase64,
      error: request.error || ""
    };
  }

  claim(limit, predicate) {
    this.cleanup();
    const now = Date.now();
    const claimed = [];
    for (const request of this.requests.values()) {
      if (claimed.length >= limit) break;
      if (!predicate(request)) continue;
      if (request.status === "leased" && request.leaseUntil <= now) {
        request.status = "queued";
        request.leaseUntil = 0;
      }
      if (request.status !== "queued") continue;
      request.status = "leased";
      request.updatedAt = now;
      request.leaseUntil = now + this.leaseMs;
      request.attempts += 1;
      claimed.push(request);
    }
    return claimed;
  }

  hasClaimable(predicate) {
    this.cleanup();
    const now = Date.now();
    for (const request of this.requests.values()) {
      if (!predicate(request)) continue;
      if (request.status === "queued") return true;
      if (request.status === "leased" && request.leaseUntil <= now) return true;
    }
    return false;
  }

  waitForClaimable(timeoutMs, predicate) {
    if (timeoutMs <= 0 || this.hasClaimable(predicate)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { resolve, predicate, timer: null };
      waiter.timer = setTimeout(() => this.#finishClaimWaiter(waiter), timeoutMs);
      this.claimWaiters.push(waiter);
      if (this.hasClaimable(predicate)) this.#finishClaimWaiter(waiter);
    });
  }

  waitForCompletion(request, timeoutMs) {
    if (["done", "failed"].includes(request.status)) return Promise.resolve(request);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.expire(request.id, `${this.name} request timed out before the Rabi PC returned a response.`);
        this.#finishCompletionWaiter(request.id, waiter, request);
      }, timeoutMs);
      const waiters = this.completionWaiters.get(request.id) || [];
      waiters.push(waiter);
      this.completionWaiters.set(request.id, waiters);
    });
  }

  complete(requestId, body) {
    const request = this.requests.get(requestId);
    if (!request) return { request: null, deduplicated: false };
    if (["done", "failed"].includes(request.status)) return { request, deduplicated: true };
    const ok = body?.ok !== false && Number(body?.statusCode || 0) >= 100;
    request.status = ok ? "done" : "failed";
    request.updatedAt = Date.now();
    request.leaseUntil = 0;
    request.response = ok
      ? {
        statusCode: Math.min(599, Math.max(100, Number(body.statusCode || 200))),
        headers: { ...(body.headers || {}) },
        bodyBase64: String(body.bodyBase64 || "")
      }
      : null;
    request.error = ok ? "" : String(body?.error || `${this.name} request failed on the Rabi PC.`);
    request.bodyBase64 = "";
    this.#finishAllCompletionWaiters(request);
    return { request, deduplicated: false };
  }

  expire(requestId, error) {
    const request = this.requests.get(requestId);
    if (!request || ["done", "failed"].includes(request.status)) return request || null;
    request.status = "failed";
    request.updatedAt = Date.now();
    request.leaseUntil = 0;
    request.error = String(error || `${this.name} request expired.`);
    request.bodyBase64 = "";
    this.#finishAllCompletionWaiters(request);
    return request;
  }

  cleanup(now = Date.now()) {
    for (const [id, request] of this.requests.entries()) {
      if (!["done", "failed"].includes(request.status) && request.expiresAt <= now) {
        this.expire(id, `${this.name} request timed out before the Rabi PC returned a response.`);
      }
      if (["done", "failed"].includes(request.status) && request.updatedAt + this.retentionMs <= now) {
        this.requests.delete(id);
      }
    }
  }

  counts() {
    this.cleanup();
    const values = [...this.requests.values()];
    return {
      total: values.length,
      queued: values.filter((request) => request.status === "queued").length,
      leased: values.filter((request) => request.status === "leased").length
    };
  }

  #notifyClaimWaiters() {
    for (const waiter of [...this.claimWaiters]) {
      if (this.hasClaimable(waiter.predicate)) this.#finishClaimWaiter(waiter);
    }
  }

  #finishClaimWaiter(waiter) {
    const index = this.claimWaiters.indexOf(waiter);
    if (index >= 0) this.claimWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  #finishCompletionWaiter(requestId, waiter, request) {
    const waiters = this.completionWaiters.get(requestId) || [];
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiters.length > 0) this.completionWaiters.set(requestId, waiters);
    else this.completionWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(request);
  }

  #finishAllCompletionWaiters(request) {
    for (const waiter of [...(this.completionWaiters.get(request.id) || [])]) {
      this.#finishCompletionWaiter(request.id, waiter, request);
    }
  }
}
