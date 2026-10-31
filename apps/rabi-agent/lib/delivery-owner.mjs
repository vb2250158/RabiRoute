import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { DeliveryStore, contentHash } from "./delivery-store.mjs";
import { EndpointAuthenticationError } from "./endpoint-session.mjs";

const BLOCKED_HTTP = new Set([400, 401, 403, 409, 410, 412, 413, 422]);
const PUBLIC_STATES = { pending: "queued", sending: "sending", unknown: "awaiting_confirmation", delivered: "received", blocked: "blocked", cancelled: "cancelled" };
function dataOf(receipt) { try { const body = JSON.parse(receipt.body); return body.data || body; } catch { return {}; } }
function originHint(identity) { return identity.nodeCredential ? contentHash([identity.nodeId, identity.managerUrl, identity.nodeCredential]) : undefined; }

/** One committed runtime owns scheduling. Reads reconnect; mutations never blindly replay. */
export class DeliveryOwner {
  constructor({ configPath, config, client, sendEvent, resolveManagerIdentity, readIdentity, now = Date.now, random = Math.random, store }) {
    this.config = config; this.client = client; this.sendEvent = sendEvent; this.now = now; this.random = random;
    this.readIdentity = readIdentity || (() => fs.existsSync(configPath) ? { ...this.config, ...JSON.parse(fs.readFileSync(configPath, "utf8")) } : this.config);
    this.resolveManagerIdentity = resolveManagerIdentity;
    const policy = config.deliveryPolicy || {};
    const number = (key, fallback) => {
      const value = policy[key] ?? fallback;
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid deliveryPolicy.${key}`);
      return value;
    };
    this.policy = { maxPending: number("maxPending", 10_000), maxBytes: number("maxBytes", 64 * 1024 * 1024),
      baseDelayMs: number("baseDelayMs", 1000), maxDelayMs: number("maxDelayMs", 60_000), pollMs: number("pollMs", 1000),
      maxConcurrency: number("maxConcurrency", 4), maxPerTarget: number("maxPerTarget", 1), ordering: policy.ordering || "target" };
    if (this.policy.maxConcurrency > 64 || this.policy.maxPerTarget > this.policy.maxConcurrency || !["target", "none"].includes(this.policy.ordering)
      || this.policy.ordering === "target" && this.policy.maxPerTarget !== 1) throw new Error("Invalid deliveryPolicy concurrency or ordering.");
    const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 24);
    this.store = store || new DeliveryStore(path.join(path.dirname(configPath), `delivery-${key}.sqlite`), { now, ...this.policy });
    this.stopped = false; this.paused = false; this.flight = null; this.active = new Map();
  }
  submit(input) {
    if (this.stopped || this.paused) throw new Error("DELIVERY_OWNER_UNAVAILABLE: intent was not accepted.");
    const { intentId, agentType, sessionId, request } = input || {};
    if (typeof intentId !== "string" || !intentId.trim() || intentId !== intentId.trim() || intentId.length > 100 || /[\x00-\x1f\x7f]/.test(intentId)) throw new Error("Delivery ID must contain 1–100 printable characters without surrounding whitespace.");
    if (!agentType || !sessionId || !request || request.action !== "send" || request.deliveryId !== intentId || request.sourceThreadId !== sessionId) throw new Error("Reliable delivery requires explicit sender and action=send with the same stable intent/delivery ID.");
    // Only the Agent delivery contract is queued; no arbitrary HTTP method/path.
    if (request.imagePaths?.length) throw new Error("Reliable delivery requires managed immutable attachments, not local image paths.");
    const normalized = { ...request, sourceAgentType: request.sourceAgentType || "agent", messageSource: request.messageSource || {
      type: "agent", agentAdapter: agentType === "codex-desktop" ? "codex" : agentType, sessionId, sessionName: sessionId } };
    const identity = this.readIdentity();
    const targetKey = contentHash(["agent-delivery", normalized.instanceBinding || null, normalized.agentAdapter || null, normalized.threadId]);
    const record = this.store.submit(intentId, "agent-delivery", { nodeId: this.config.nodeId, agentType, sessionId, request: normalized },
      { managerGuid: identity.managerGuid, managerOrigin: identity.managerUrl, managerHint: originHint(identity), targetKey });
    this.wake(); return { ok: true, accepted: true, acceptance: "local-durable", record };
  }
  enqueueResult(payload, managerGuid) {
    const eventId = contentHash({ nodeId: this.config.nodeId, taskId: payload.taskId, payload });
    const identity = this.readIdentity();
    const originalGuid = managerGuid === null ? this.store.taskManagerGuid(payload.taskId) : managerGuid || identity.managerGuid;
    this.store.submit(eventId, "task-result", { ...payload, nodeId: this.config.nodeId, eventId },
      { managerGuid: originalGuid, ...(managerGuid === null ? {} : { managerOrigin: identity.managerUrl, managerHint: originHint(identity) }), targetKey: "task-result:" + payload.taskId }); this.wake(); return eventId;
  }
  project(item) {
    if (!item) return null;
    const payload = this.store.raw(item.intentId).payload, request = payload.request || {};
    const storedReceipt = item.receipt;
    const receipt = storedReceipt && Object.fromEntries(["accepted", "deliveryId", "action", "transport", "state", "eventId", "taskId"]
      .filter(key => Object.hasOwn(storedReceipt, key)).map(key => [key, storedReceipt[key]]));
    if (receipt && storedReceipt.endpoint) receipt.endpoint = Object.fromEntries(["kind", "instanceId", "nodeId", "provider", "sessionId"]
      .filter(key => Object.hasOwn(storedReceipt.endpoint, key)).map(key => [key, storedReceipt.endpoint[key]]));
    return { id: item.intentId, deliveryId: storedReceipt?.deliveryId || item.intentId, intentId: item.intentId,
      state: PUBLIC_STATES[item.state], ownerScope: "node",
      source: { nodeId: payload.nodeId || this.config.nodeId, provider: payload.agentType, sessionId: payload.sessionId },
      target: { instanceId: request.instanceBinding?.instanceId, provider: request.agentAdapter, sessionId: request.threadId },
      createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
      attemptCount: item.attempts, ...(item.error ? { reason: item.error } : {}), ...(receipt ? { receipt } : {}) };
  }
  query(input = {}) {
    let page;
    if (input.action === "get") page = { item: this.project(this.store.get(input.intentId)) };
    else {
      const state = input.state === undefined ? undefined : Object.keys(PUBLIC_STATES).find(key => PUBLIC_STATES[key] === input.state);
      if (input.state !== undefined && !state) throw new Error("Invalid delivery state filter.");
      const result = this.store.list({ ...input, state });
      page = { items: result.items.map(item => this.project(item)), nextCursor: result.nextCursor,
        counts: Object.fromEntries(Object.entries(result.counts).map(([key, count]) => [PUBLIC_STATES[key], count])) };
    }
    return { ...page, coverage: { scope: "node", nodeId: this.config.nodeId, connected: true, includesDisconnectedNodeQueues: false,
      ...(this.lastError ? { message: this.lastError } : {}) }, observedAt: new Date(this.now()).toISOString() };
  }
  acknowledge(message, managerGuid) {
    const record = this.store.raw(message.eventId), identity = this.readIdentity();
    if (!record?.manager_guid || record.manager_guid !== identity.managerGuid || managerGuid !== undefined && record.manager_guid !== managerGuid) return false;
    return this.store.acknowledgeEvent(message.eventId, message.taskId);
  }
  start() { this.timer ||= setInterval(() => this.wake(), this.policy.pollMs); this.timer.unref?.(); this.wake(); }
  wake() {
    if (this.stopped || this.paused) return;
    const cycle = this.tick().catch(() => {
      this.lastError = "DELIVERY_QUEUE_STORAGE_ERROR";
      process.stderr.write("Delivery queue storage failed; accepted records retained for recovery.\n");
    }).finally(() => { if (this.flight === cycle) this.flight = null; });
    this.flight = cycle;
  }
  backoff(row) { return Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** Math.min(row.attempts, 16)) + Math.floor(this.random() * this.policy.baseDelayMs); }
  async tick() {
    const launched = [];
    const available = this.policy.maxConcurrency - this.active.size;
    if (available <= 0) return;
    const counts = new Map(); for (const item of this.active.values()) counts.set(item.targetKey, (counts.get(item.targetKey) || 0) + 1);
    for (const row of this.store.due(available, { ordered: this.policy.ordering === "target", perTarget: this.policy.maxPerTarget,
      excludeIds: [...this.active.keys()], activeTargets: [...counts].map(([targetKey, count]) => ({ targetKey, slots: this.policy.maxPerTarget - count })) })) {
      if (this.stopped || this.paused || this.active.size >= this.policy.maxConcurrency) break;
      if (this.active.has(row.id)) continue;
      const targetKey = row.target_key || row.id;
      if ([...this.active.values()].filter(item => item.targetKey === targetKey).length >= this.policy.maxPerTarget) continue;
      const promise = Promise.resolve().then(() => this.process(row)).finally(() => this.active.delete(row.id));
      this.active.set(row.id, { targetKey, promise }); launched.push(promise);
    }
    await Promise.all(launched);
  }
  async process(row) {
      try {
        if (row.payload.nodeId && row.payload.nodeId !== this.config.nodeId) {
          this.store.update(row.id, "blocked", { error: "DELIVERY_NODE_ID_CHANGED" }); return;
        }
        if (!await this.ensureManagerBinding(row)) return;
        if (row.kind === "task-result") {
          this.store.update(row.id, "unknown", { delayMs: this.backoff(row), attempt: true });
          this.sendEvent(row.payload, row.manager_guid); // Only the original Manager's durable receiver ACK completes it.
        } else await this.deliver(row);
      } catch (error) {
        if (!this.stopped) this.store.update(row.id, error instanceof EndpointAuthenticationError ? "blocked" : this.store.raw(row.id)?.state === "pending" ? "pending" : "unknown",
          { error: error instanceof EndpointAuthenticationError ? "DELIVERY_HTTP_401" : "DELIVERY_TRANSPORT_UNAVAILABLE", delayMs: this.backoff(row) });
      }
  }
  async ensureManagerBinding(row) {
    let identity = this.readIdentity();
    if (!row.manager_guid) {
      // Legacy unknown records have no trustworthy origin proof. Never adopt a
      // newly configured Manager and turn that absence into permission to send.
      if (row.state !== "pending" || row.attempts > 0 || !row.manager_origin || row.manager_origin !== identity.managerUrl
        || !row.manager_hint || row.manager_hint !== originHint(identity)) {
        this.store.update(row.id, "blocked", { error: "DELIVERY_ORIGINAL_MANAGER_UNKNOWN" }); return false;
      }
      if (!identity.managerGuid) {
        if (!this.resolveManagerIdentity) { this.store.update(row.id, "blocked", { error: "DELIVERY_MANAGER_IDENTITY_UNAVAILABLE", delayMs: this.backoff(row) }); return false; }
        const verified = await this.resolveManagerIdentity();
        identity = this.readIdentity();
        if (!verified?.guid || verified.guid !== identity.managerGuid) throw new Error("Verified Manager binding unavailable.");
      }
      // The resolver reads current configuration and may await discovery. Its
      // authenticated result must still belong to this pending intent's source.
      if (row.manager_origin !== identity.managerUrl || row.manager_hint !== originHint(identity)) {
        this.store.update(row.id, "pending", { error: "DELIVERY_MANAGER_CHANGED", delayMs: this.backoff(row) });
        return false;
      }
      this.store.bindManagerGuid(row.id, identity.managerGuid); row.manager_guid = identity.managerGuid;
    }
    if (!identity.managerGuid || row.manager_guid !== identity.managerGuid) {
      this.store.update(row.id, "blocked", { error: identity.managerGuid ? "DELIVERY_MANAGER_CHANGED" : "DELIVERY_MANAGER_IDENTITY_UNAVAILABLE", delayMs: this.backoff(row) }); return false;
    }
    return true;
  }
  async deliver(row) {
    const { agentType, sessionId, request } = row.payload;
    // Carry the immutable owner binding into the actual transport. A config
    // replacement between ensureManagerBinding and here must never choose B.
    const client = this.client(agentType, sessionId, row.manager_guid);
    if (row.state !== "pending") {
      const query = await client.request("GET", `/api/agent/deliveries/caller/${encodeURIComponent(row.id)}`, { replaySafe: false });
      const data = dataOf(query);
      if ([401, 403].includes(query.statusCode) && !query.uncertain && !query.identityChanged) {
        this.store.update(row.id, "blocked", { error: `DELIVERY_HTTP_${query.statusCode}`, delayMs: this.backoff(row), attempt: true }); return;
      }
      if (query.uncertain || query.identityChanged || query.statusCode === 0 || query.statusCode >= 500) {
        this.store.update(row.id, "unknown", { error: "DELIVERY_RECEIPT_UNAVAILABLE", delayMs: this.backoff(row), attempt: true }); return;
      }
      if (query.ok && data.state === "committed" && data.receipt?.accepted === true) {
        this.store.update(row.id, "delivered", { receipt: { deliveryId: data.deliveryId, state: data.state } }); return;
      }
      if (query.ok && data.state === "cancelled") {
        this.store.update(row.id, "cancelled", { error: "DELIVERY_CANCELLED", receipt: { deliveryId: data.deliveryId, state: "cancelled" } }); return;
      }
      const absent = query.statusCode === 404 && data.errorCode === "DELIVERY_NOT_RESERVED" && data.canSubmitSameIntent === true;
      const prepared = query.ok && data.state === "prepared" && data.canSubmitSameIntent === true;
      if (!absent && !prepared) {
        if (query.ok && data.deliveryId) {
          const reconciled = await client.request("POST", "/api/agent/threads", { body: { action: "reconcile_delivery", deliveryId: data.deliveryId,
            sourceThreadId: sessionId, sourceAgentType: request.sourceAgentType, messageSource: request.messageSource, agentAdapter: request.agentAdapter }, replaySafe: false });
          const proof = dataOf(reconciled);
          if (reconciled.ok && !reconciled.uncertain && !reconciled.identityChanged && proof.status === "delivered" && proof.delivery?.status === "accepted") {
            this.store.update(row.id, "delivered", { receipt: { deliveryId: data.deliveryId, state: "committed" } }); return;
          }
        }
        this.store.update(row.id, "unknown", { error: "DELIVERY_ACCEPTANCE_UNCONFIRMED", delayMs: this.backoff(row), attempt: true }); return;
      }
    }
    this.store.update(row.id, "sending", { attempt: true });
    const result = await client.request("POST", "/api/agent/threads", { body: request, replaySafe: false });
    const body = dataOf(result);
    if (result.ok && !result.uncertain && !result.identityChanged && body.status === "delivered" && body.delivery?.status === "accepted") {
      this.store.update(row.id, "delivered", { receipt: { deliveryId: body.delivery.deliveryId || row.id, state: "committed" } }); return;
    }
    const blocked = BLOCKED_HTTP.has(result.statusCode) && !result.uncertain && !result.identityChanged;
    this.store.update(row.id, blocked ? "blocked" : "unknown", { error: blocked ? `DELIVERY_HTTP_${result.statusCode}` : "DELIVERY_ACCEPTANCE_UNCONFIRMED", delayMs: this.backoff(row) });
  }
  async pause() { this.paused = true; await Promise.allSettled([...this.active.values()].map(item => item.promise)); }
  resume() { this.paused = false; this.start(); }
  async close() { this.stopped = true; clearInterval(this.timer); await Promise.allSettled([...this.active.values()].map(item => item.promise)); this.store.close(); }
}
