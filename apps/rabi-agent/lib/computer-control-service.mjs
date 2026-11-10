import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_COMPUTER_SETTINGS, normalizeComputerSettings, assertComputerActionEnabled, computerActionDefinition } from "./computer-control-contract.mjs";

const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const fault = (code, reason, extra = {}) => Object.assign(new Error(reason), { code, errorCode: code, reason, nextAction: "Query the original computer request or control status.", ...extra });
const clone = value => structuredClone(value);
const recovery = action => /\.(?:status|end|cancel|clear|stop)$/.test(action);

/** Authoritative ephemeral input/layer ownership; the Manager supplies trusted settings and source. */
export class ComputerControlService {
  constructor({ native, onChange = () => {}, receiptRoot, instanceId, now = () => performance.now() } = {}) {
    Object.assign(this, { native, onChange, receiptRoot, instanceId, now });
    this.session = null; this.endedSessions = new Map(); this.receipts = new Map(); this.layers = new Map(); this.trackers = new Map();
    this.activeLayers = new Map(); this.activeTrackers = new Map(); this.notified = new WeakMap();
    this.inputQueue = Promise.resolve(); this.inflight = new Map(); this.stopped = false;
    native.on?.("control-ended", event => this.nativeEnded(event));
    native.on?.("tracking", event => { const item = this.trackers.get(event.trackingId); if (item) {
      Object.assign(item, event); const layer = this.layers.get(item.layerId);
      if (layer?.trackingId === event.trackingId && layer.state === "visible") { if (event.source) layer.source = clone(event.source); if (event.objects) layer.objects = clone(event.objects); }
      this.notifyTracker(item);
    } });
    native.on?.("annotation-ended", event => {
      const layer = this.layers.get(event.layerId); if (!layer || layer.version > event.version) return;
      clearTimeout(layer.timer); layer.version = event.version; layer.state = "cleared"; delete layer.objects; this.notifyLayer(layer);
    });
    native.on?.("annotation-source", event => { const layer = this.layers.get(event.layerId); if (layer?.version === event.version) layer.source = clone(event.source); });
    native.on?.("annotation-static", event => {
      const layer = this.layers.get(event.layerId); if (!layer || layer.version !== event.version || ["cleared", "clearing"].includes(layer.state)) return;
      Object.assign(layer, { source: clone(event.source), objects: clone(event.objects), expiresAt: event.expiresAt, trackingState: "stopped" });
      clearTimeout(layer.timer);
      if (event.expiresAt) { layer.timer = setTimeout(() => { void this.clearLayer(layer.layerId, { layer, version: layer.version }).catch(() => {}); }, Math.max(0, Date.parse(event.expiresAt) - Date.now())); layer.timer.unref?.(); }
      this.notifyLayer(layer);
    });
    native.on?.("retired", () => {
      for (const layer of [...this.activeLayers.values()]) { clearTimeout(layer.timer); layer.state = "cleared"; delete layer.objects; this.notifyLayer(layer); }
      for (const item of [...this.activeTrackers.values()]) { item.state = "stopped"; item.stopped = true; this.notifyTracker(item); }
    });
    native.on?.("closed", () => {
      if (this.session?.state === "active") { this.session.state = "uncertain"; this.session.reason = "native-helper-closed"; }
      for (const requestId of this.inflight.keys()) { const item = this.receipts.get(requestId); if (item && ["running", "submitted"].includes(item.state)) { item.state = "uncertain"; item.uncertain = true; void this.save(item).catch(() => {}); this.notifyItem(item, [item.state, Boolean(item.cancelled)]); } }
      this.notifyControl();
    });
  }
  notifyItem(item, tuple) {
    const signature = JSON.stringify(tuple);
    if (this.notified.get(item) === signature) return;
    this.notified.set(item, signature);
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => { this.notificationPending = false; this.onChange(); });
  }
  notifyControl() { if (this.session) this.notifyItem(this.session, [this.session.controlSessionId, this.session.state, this.session.reason]); }
  notifyLayer(layer) {
    if (layer.state === "cleared") { if (this.activeLayers.get(layer.layerId) === layer) this.activeLayers.delete(layer.layerId); }
    else this.activeLayers.set(layer.layerId, layer);
    this.notifyItem(layer, [layer.version, layer.state, layer.expiresAt, layer.trackingState]);
  }
  notifyTracker(item) {
    if (item.stopped || ["stopped", "paused", "absent"].includes(item.state)) this.activeTrackers.delete(item.trackingId);
    else this.activeTrackers.set(item.trackingId, item);
    this.notifyItem(item, [item.state, Boolean(item.stopped), item.effective?.reason, item.effective?.rateHz, item.effective?.maxAnalysisWidth, item.targets?.map(target => [target.id, target.state])]);
  }
  notifyIntent(entry, input) {
    this.notifyItem(entry, [entry.state, Boolean(entry.cancelled)]);
    if (input.action === "control.begin") this.notifyControl();
    const layer = this.layers.get(input.layerId); if (layer) this.notifyLayer(layer);
    const tracker = this.trackers.get(entry.result?.trackingId); if (tracker) this.notifyTracker(tracker);
  }
  get activeCount() { return Number(Boolean(this.session && this.session.state !== "ended")) + this.inflight.size + this.activeLayers.size + this.activeTrackers.size; }
  settings(context) { return normalizeComputerSettings(context.getSettings?.() ?? context.settings ?? DEFAULT_COMPUTER_SETTINGS); }
  source(context) { return { id: context.sourceId ?? "local-service", ...(context.sourceLabel ? { label: context.sourceLabel } : {}), ...(context.taskId ? { taskId: context.taskId } : {}), ...(context.connectionId ? { connectionId: context.connectionId } : {}) }; }
  target(context) { return (typeof this.instanceId === "function" ? this.instanceId() : this.instanceId) ?? context.instanceId; }
  check(action, context) {
    if (this.stopped && !recovery(action)) throw fault("COMPUTER_STOPPED", "Computer owner is stopping.");
    context.signal?.throwIfAborted(); context.guard?.();
    if (computerActionDefinition(action)?.recovery) return;
    assertComputerActionEnabled(this.settings(context), action, this.target(context));
  }
  async save(item) {
    if (!this.receiptRoot) return;
    await fs.mkdir(this.receiptRoot, { recursive: true });
    const destination = path.join(this.receiptRoot, hash(item.requestId) + ".json"), temporary = destination + "." + randomUUID() + ".tmp";
    const stored = Object.fromEntries(Object.entries(item).filter(([key]) => !["promise", "cancelled"].includes(key)));
    await fs.writeFile(temporary, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, destination); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  async receipt(requestId) {
    if (this.receipts.has(requestId)) return this.receipts.get(requestId);
    if (!this.receiptRoot || typeof requestId !== "string") return;
    let entry;
    try { entry = JSON.parse(await fs.readFile(path.join(this.receiptRoot, hash(requestId) + ".json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (entry.requestId !== requestId) throw fault("COMPUTER_RECEIPT_INVALID", "The original computer receipt cannot be read.");
    if (["submitted", "running"].includes(entry.state)) { entry.state = "uncertain"; entry.uncertain = true; }
    this.receipts.set(requestId, entry); return entry;
  }
  viewReceipt(entry) {
    if (!entry) return { state: "absent" };
    const { promise, bodyHash, sourceId, cancelled, ...value } = entry; return clone(value);
  }
  once(input, context, run) {
    if (typeof input.requestId !== "string" || !input.requestId) return Promise.reject(fault("COMPUTER_REQUEST_ID_REQUIRED", "A stable requestId is required."));
    const signature = hash({ input, sourceId: this.source(context).id });
    const current = this.inflight.get(input.requestId);
    if (current) return current.signature === signature ? current.promise : Promise.reject(fault("COMPUTER_REQUEST_CONFLICT", "The original requestId belongs to different content or source."));
    const claim = { signature, connectionId: context.connectionId, cancelled: false };
    const promise = Promise.resolve().then(() => this.runOnce(input, context, run, claim)); claim.promise = promise;
    this.inflight.set(input.requestId, claim);
    void promise.then(() => this.inflight.delete(input.requestId), () => this.inflight.delete(input.requestId));
    return promise;
  }
  async runOnce(input, context, run, claim) {
    if (typeof input.requestId !== "string" || !input.requestId) throw fault("COMPUTER_REQUEST_ID_REQUIRED", "A stable requestId is required.");
    const bodyHash = hash(input), sourceId = this.source(context).id;
    const old = await this.receipt(input.requestId);
    if (old) {
      if (old.bodyHash !== bodyHash || old.sourceId !== sourceId) throw fault("COMPUTER_REQUEST_CONFLICT", "The original requestId belongs to different content or source.");
      if (old.promise) return old.promise;
      if (input.action === "control.begin" && old.controlSessionId) {
        const current = this.controlStatus(old.controlSessionId);
        if (current.state !== "absent") return current;
        if (old.result?.state === "active") return { ...clone(old.result), state: "uncertain", reason: "The original control owner is not present in this runtime." };
      }
      return old.result ? clone(old.result) : this.viewReceipt(old);
    }
    if (claim.cancelled) throw fault("COMPUTER_SOURCE_CLOSED", "The original source connection ended before this work was admitted.");
    const entry = { requestId: input.requestId, action: input.action, bodyHash, sourceId, connectionId: context.connectionId, state: "submitted", createdAt: new Date().toISOString() };
    // Reserve synchronously before the first persistence await: concurrent same-ID calls join this owner.
    this.receipts.set(input.requestId, entry);
    entry.promise = (async () => {
      await this.save(entry);
      try {
        if (claim.cancelled || entry.cancelled) { entry.cancelled = true; throw fault("COMPUTER_SOURCE_CLOSED", "The original source connection ended before execution."); }
        this.check(input.action, context);
        const result = await run(entry);
        entry.result = clone(result);
        if (entry.result.capture?.data) { delete entry.result.capture.data; entry.result.capture.state = "not-retained"; }
        entry.state = result.state ?? "completed";
        await this.save(entry); this.notifyIntent(entry, input); return result;
      } catch (error) {
        const layer = input.layerId ? this.layers.get(input.layerId) : undefined;
        if (layer?.requestId === input.requestId && layer.state === "submitted") {
          try { await this.clearLayer(input.layerId, { layer, version: layer.version }); }
          catch (cleanup) { error.uncertain = true; entry.cleanupError = cleanup.message; }
        }
        entry.state = error.uncertain || error.code === "COMPUTER_RESULT_UNCERTAIN" ? "uncertain" : entry.cancelled ? "cancelled" : "failed";
        entry.uncertain = entry.state === "uncertain";
        entry.error = { code: error.code ?? "COMPUTER_ACTION_FAILED", reason: error.message };
        await this.save(entry); this.notifyIntent(entry, input); throw error;
      } finally { delete entry.promise; }
    })();
    return entry.promise;
  }
  controlStatus(id) {
    const session = this.session && (!id || this.session.controlSessionId === id) ? this.session : this.endedSessions.get(id);
    if (!session) return { state: "absent", ...(id ? { controlSessionId: id } : {}) };
    const { lastActivityMono, context, settingsSnapshot, ...value } = session;
    const settings = settingsSnapshot;
    return { ...clone(value), remainingMs: session.state !== "active" || !settings || !settings.control.idleExitEnabled ? null : Math.max(0, settings.control.idleTimeoutSeconds * 1000 - (this.now() - lastActivityMono)) };
  }
  ownedSession(id, context) {
    const item = this.session;
    if (!item || item.controlSessionId !== id || item.state !== "active") throw fault("COMPUTER_CONTROL_NOT_ACTIVE", "Enter control before submitting native input.");
    if (item.source.id !== this.source(context).id || item.source.connectionId && context.connectionId && item.source.connectionId !== context.connectionId) throw fault("COMPUTER_CONTROL_BUSY", "Another source currently controls this target.", { current: this.controlStatus() });
    return item;
  }
  touch(item) { item.lastActivityMono = this.now(); item.lastActivityAt = new Date().toISOString(); }
  nativeEnded(event) {
    if (this.session?.controlSessionId !== event.controlSessionId || this.session.state === "ended") return;
    this.session.state = "ended"; this.session.reason = event.reason ?? "user-exit";
    for (const requestId of this.inflight.keys()) { const item = this.receipts.get(requestId); if (item?.controlSessionId === event.controlSessionId) item.cancelled = true; }
    this.endedSessions.set(event.controlSessionId, { ...this.session }); this.notifyControl();
  }
  async end(id, reason = "requested") {
    const item = this.session;
    if (!item || item.controlSessionId !== id) return this.controlStatus(id);
    if (item.state === "ended" && (!this.native.child || this.native.stopping)) { this.session = null; return this.controlStatus(id); }
    for (const requestId of this.inflight.keys()) { const entry = this.receipts.get(requestId); if (entry?.controlSessionId === id) entry.cancelled = true; }
    item.state = "ending"; this.notifyControl();
    const result = await this.native.request("control.end", { controlSessionId: id, reason });
    this.nativeEnded({ controlSessionId: id, reason });
    for (const layer of [...this.activeLayers.values()]) if (layer.controlSessionId === id) await this.clearLayer(layer.layerId);
    item.presentation = result.presentation ?? item.presentation;
    if (this.session === item) this.session = null; return this.controlStatus(id);
  }
  async capture(input, context = {}) {
    this.check("screen.capture", context);
    const result = await this.native.request("screen.capture", { ...input, action: undefined, instanceId: this.target(context), settings: this.settings(context) });
    context.guard?.();
    if (input.controlSessionId && input.background !== true && this.session?.controlSessionId === input.controlSessionId && this.session.source.id === this.source(context).id) {
      this.touch(this.session); await this.native.request("control.activity", { controlSessionId: input.controlSessionId });
    }
    return result;
  }
  async withCapture(result, input, context) {
    if (!input.captureAfter) return result;
    try { return { ...result, capture: await this.capture({ ...(input.source ?? {}), controlSessionId: result.controlSessionId }, context) }; }
    catch (error) { return { ...result, capture: { state: "unavailable", reason: error.message } }; }
  }
  async clearLayer(id, expected) {
    let layer = this.layers.get(id);
    if (expected && (layer !== expected.layer || layer?.version !== expected.version)) return { layerId: id, state: "superseded" };
    if (layer?.state === "cleared") return { layerId: id, version: layer.version, state: "cleared" };
    if (!layer) { layer = { layerId: id, version: 1, state: "cleared" }; this.layers.set(id, layer); return { layerId: id, version: 1, state: "cleared" }; }
    const trackingId = layer.trackingId;
    layer.version++; layer.state = "clearing"; clearTimeout(layer.timer);
    const version = layer.version;
    try {
      if (trackingId) { const stopped = await this.native.request("annotation.track.stop", { trackingId, clear: true });
        const tracker = this.trackers.get(trackingId); if (tracker) { Object.assign(tracker, stopped, { stopped: stopped.state === "stopped" || stopped.state === "absent" }); this.notifyTracker(tracker); } }
      await this.native.request("annotation.clear", { layerId: id, version });
      if (this.layers.get(id) === layer && layer.version === version) { layer.state = "cleared"; delete layer.objects; }
      this.notifyLayer(layer); return { layerId: id, version, state: "cleared" };
    } catch (error) { if (this.layers.get(id) === layer && layer.version === version) { layer.state = "uncertain"; this.notifyLayer(layer); } throw error; }
  }
  async execute(input, context = {}) {
    const acceptedIntent = computerActionDefinition(input.action)?.receipt === true;
    if (acceptedIntent) { context.signal?.throwIfAborted(); context.guard?.(); }
    else this.check(input.action, context);
    const initialLayerVersion = this.layers.get(input.layerId)?.version ?? 0;
    if (input.action === "control.status") return this.controlStatus(input.controlSessionId);
    if (input.action === "control.end") return this.end(input.controlSessionId ?? this.session?.controlSessionId, "requested");
    if (input.action === "input.status") return this.viewReceipt(await this.receipt(input.requestId));
    if (input.action === "input.cancel") {
      const entry = await this.receipt(input.requestId); if (!entry) return { requestId: input.requestId, state: "absent" };
      entry.cancelled = true; this.notifyItem(entry, [entry.state, true]); await this.native.request("input.cancel", { requestId: input.requestId, controlSessionId: entry.controlSessionId });
      return this.viewReceipt(entry);
    }
    if (input.action === "annotation.status") {
      const layers = [...this.activeLayers.values()].map(({ timer, sourceId, ...layer }) => clone(layer));
      return input.layerId ? layers.find(layer => layer.layerId === input.layerId) ?? { layerId: input.layerId, state: "absent" } : { state: "ready", layers };
    }
    if (input.action === "annotation.clear") return input.layerId ? this.clearLayer(input.layerId) : { state: "cleared", layers: await Promise.all([...this.activeLayers.keys()].map(id => this.clearLayer(id))) };
    if (input.action === "annotation.track.status") return clone(this.trackers.get(input.trackingId) ?? { trackingId: input.trackingId, state: "absent" });
    if (input.action === "annotation.track.stop") {
      const item = this.trackers.get(input.trackingId); if (!item) return { trackingId: input.trackingId, state: "absent" };
      const result = await this.native.request(input.action, { trackingId: input.trackingId }); Object.assign(item, result); this.notifyTracker(item); return clone(item);
    }
    if (input.action === "annotation.update") {
      const layer = this.layers.get(input.layerId);
      if (!layer || layer.state === "cleared" || layer.state === "clearing" || layer.version !== input.expectedVersion) throw fault("COMPUTER_LAYER_CHANGED", "Read the current layer version; a cleared or newer layer cannot be overwritten.");
      const version = layer.version + 1;
      layer.version = version;
      const objects = clone(input.objects ?? layer.objects), source = clone(input.source ?? layer.source);
      await this.native.request(input.action, { ...input, objects, source, version, instanceId: this.target(context) });
      if (this.layers.get(layer.layerId) !== layer || layer.version !== version || layer.state === "clearing" || layer.state === "cleared") return { layerId: layer.layerId, version: layer.version, state: "cleared" };
      Object.assign(layer, { objects, source }); this.notifyLayer(layer); return this.execute({ action: "annotation.status", layerId: layer.layerId }, context);
    }
    return this.once(input, context, async entry => {
      if (input.action === "control.begin") {
        if (this.session && this.session.state !== "ended") throw fault("COMPUTER_CONTROL_BUSY", "This target already has a control source.", { current: this.controlStatus() });
        const id = randomUUID(), settings = this.settings(context); entry.controlSessionId = id;
        const item = { controlSessionId: id, requestId: input.requestId, source: this.source(context), state: "starting", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), lastActivityMono: this.now(), context, settingsSnapshot: settings };
        this.session = item;
        try { item.presentation = await this.native.request("control.begin", { controlSessionId: id, source: item.source, settings }, { beforeSend: () => { if (this.session !== item || item.state !== "starting" || entry.cancelled) throw fault("COMPUTER_SOURCE_CLOSED", "The original control intent ended before native admission."); this.check("control.begin", context); } }); }
        catch (error) { item.state = error.uncertain ? "uncertain" : "ended"; if (item.state === "ended") this.endedSessions.set(id, { ...item }); throw error; }
        if (item.presentation?.state === "ended") this.nativeEnded({ controlSessionId: id, reason: item.presentation.reason });
        else { item.state = "active"; this.touch(item); }
        return this.withCapture(this.controlStatus(id), input, context);
      }
      if (input.action === "input.execute") {
        const session = this.ownedSession(input.controlSessionId, context); entry.controlSessionId = session.controlSessionId;
        if (input.source?.instanceId && this.target(context) && input.source.instanceId !== this.target(context)) throw fault("COMPUTER_SOURCE_MISMATCH", "The coordinate source belongs to another computer instance.");
        const maximum = this.settings(context).input?.maxActions ?? 128;
        if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > maximum) throw fault("COMPUTER_INPUT_BATCH_INVALID", `Input actions must contain 1..${maximum} entries.`);
        entry.completedActions = 0; entry.totalActions = input.actions.length; entry.results = []; entry.releaseState = "released";
        const queued = this.inputQueue.then(async () => {
          entry.state = "running";
          for (let index = 0; index < input.actions.length; index++) {
            if (entry.cancelled) break;
            this.check("input.execute", context); this.ownedSession(input.controlSessionId, context);
            const result = await this.native.request("input.execute", { requestId: input.requestId, controlSessionId: input.controlSessionId, input: input.actions[index], source: input.source, instanceId: this.target(context), settings: this.settings(context) });
            if (result.state === "cancelled") { entry.cancelled = true; entry.results.push({ index, state: "cancelled", injectedEvents: result.injectedEvents }); break; }
            if (result.state !== "injected") {
              entry.results.push({ index, state: result.state, injectedEvents: result.injectedEvents, reason: result.reason });
              return { ...this.viewReceipt(entry), state: result.state, releaseState: result.releaseState };
            }
            entry.results.push({ index, state: "injected", injectedEvents: result.injectedEvents }); entry.completedActions++; this.touch(session);
          }
          const result = { ...this.viewReceipt(entry), state: entry.cancelled ? "cancelled" : "injected" };
          return this.withCapture(result, input, context);
        });
        this.inputQueue = queued.catch(() => {}); return queued;
      }
      if (input.action === "annotation.show") {
        const previous = this.layers.get(input.layerId);
        if ((previous?.version ?? 0) !== initialLayerVersion) return { layerId: input.layerId, version: previous?.version, state: "cleared" };
        if (previous && previous.state !== "cleared") throw fault("COMPUTER_LAYER_EXISTS", "Update the existing layer with its version.");
        const duration = input.durationMs === undefined ? this.settings(context).annotation.staticDurationMs : input.durationMs;
        const layer = { layerId: input.layerId, requestId: input.requestId, version: initialLayerVersion + 1, state: "submitted", connectionId: context.connectionId, taskId: context.taskId, sourceId: this.source(context).id, source: clone(input.source), objects: clone(input.objects), controlSessionId: input.controlSessionId,
          expiresAt: duration === null ? null : new Date(Date.now() + duration).toISOString() };
        this.layers.set(input.layerId, layer); this.activeLayers.set(input.layerId, layer);
        const version = layer.version;
        await this.native.request(input.action, { ...input, version, instanceId: this.target(context), durationMs: duration }, { beforeSend: () => { if (this.layers.get(input.layerId) !== layer || layer.version !== version || layer.state !== "submitted" || entry.cancelled) throw fault("COMPUTER_SOURCE_CLOSED", "The original annotation intent ended before native admission."); this.check("annotation.show", context); } });
        if (this.layers.get(input.layerId) !== layer || layer.version !== version || layer.state !== "submitted") {
          await this.native.request("annotation.clear", { layerId: input.layerId, version });
          return { layerId: input.layerId, version: layer.version, state: "cleared" };
        }
        layer.state = "visible";
        if (duration !== null) { layer.timer = setTimeout(() => { void this.clearLayer(layer.layerId).catch(error => this.onChange({ code: error.code, message: error.message })); }, duration); layer.timer.unref?.(); }
        return this.execute({ action: "annotation.status", layerId: layer.layerId }, context);
      }
      if (input.action === "annotation.track.start") {
        const settings = this.settings(context), trackingId = randomUUID();
        const previous = this.layers.get(input.layerId);
        if ((previous?.version ?? 0) !== initialLayerVersion) return { trackingId, layerId: input.layerId, state: "stopped" };
        if (previous && previous.state !== "cleared") throw fault("COMPUTER_LAYER_EXISTS", "Clear or stop the original tracking layer before replacing it.");
        const layer = { layerId: input.layerId, requestId: input.requestId, version: initialLayerVersion + 1, state: "submitted", connectionId: context.connectionId, sourceId: this.source(context).id, source: clone(input.source), objects: [], trackingId, taskId: context.taskId, expiresAt: input.expiresAt ?? null };
        this.layers.set(input.layerId, layer); this.activeLayers.set(input.layerId, layer); const version = layer.version;
        const result = await this.native.request(input.action, { ...input, version, trackingId, instanceId: this.target(context), overrides: { backend: input.backend !== undefined, rateHz: input.rateHz !== undefined }, backend: input.backend ?? settings.annotation.backend, rateHz: input.rateHz ?? settings.annotation.rateHz, settings }, { beforeSend: () => { if (this.layers.get(input.layerId) !== layer || layer.version !== version || layer.state !== "submitted" || entry.cancelled) throw fault("COMPUTER_SOURCE_CLOSED", "The original tracking intent ended before native admission."); this.check("annotation.track.start", context); } });
        if (this.layers.get(input.layerId) !== layer || layer.version !== version || layer.state !== "submitted") {
          await this.native.request("annotation.track.stop", { trackingId, clear: true });
          await this.native.request("annotation.clear", { layerId: input.layerId, version });
          return { trackingId, layerId: input.layerId, state: "stopped" };
        }
        const item = { ...result, trackingId, layerId: input.layerId, connectionId: context.connectionId, sourceId: this.source(context).id, taskId: context.taskId };
        this.trackers.set(trackingId, item); layer.state = "visible"; layer.source = clone(result.source ?? input.source); layer.objects = clone(result.objects ?? []);
        return clone(item);
      }
      throw fault("COMPUTER_ACTION_UNSUPPORTED", "Read the current computer action contract.");
    });
  }
  async reconcile(context = {}) {
    const settings = this.settings(context);
    if (!this.native.child && this.activeCount === 0) return;
    await this.native.request("settings.update", { settings });
    if (this.session) this.session.settingsSnapshot = settings;
    if (!settings.enabled || !settings.features.input) await this.end(this.session?.controlSessionId, "settings-disabled");
    if (!settings.enabled || !settings.features.annotation) await Promise.all([...this.activeLayers.keys()].map(id => this.clearLayer(id)));
    else if (!settings.features.observation || !settings.annotation.dynamicEnabled) {
      for (const item of [...this.activeTrackers.values()]) if (item.state !== "stopped") await this.execute({ action: "annotation.track.stop", trackingId: item.trackingId }, context);
    }
  }
  async endTask(taskId, sourceId) {
    if (!sourceId) return { state: "unknown", reason: "The original sourceId is needed to identify this task's resources without affecting another source." };
    if (this.session?.source.taskId === taskId && this.session.source.id === sourceId) await this.end(this.session.controlSessionId, "task-ended");
    for (const layer of [...this.activeLayers.values()]) if (layer.taskId === taskId && layer.sourceId === sourceId) await this.clearLayer(layer.layerId);
    return { state: "ended", taskId, sourceId };
  }
  async retireScope(session, layers, claims, reason) {
    for (const claim of claims) claim.cancelled = true;
    const selected = new Set(claims);
    for (const [requestId, claim] of this.inflight) if (selected.has(claim)) { const entry = this.receipts.get(requestId); if (entry) entry.cancelled = true; }
    const outcomes = await Promise.allSettled([
      ...(session ? [this.end(session.controlSessionId, reason)] : []),
      ...layers.map(original => this.clearLayer(original.id, original)),
      ...claims.map(claim => claim.promise)
    ]);
    // The original call retains its business cancellation; only cleanup failures affect retirement.
    const failures = outcomes.slice(0, Number(Boolean(session)) + layers.length).filter(item => item.status === "rejected").map(item => item.reason);
    if (failures.length) throw new AggregateError(failures, "Original computer source cleanup remains unconfirmed.");
    return { state: "ended" };
  }
  async connectionClosed() {
    const session = this.session;
    const layers = [...this.activeLayers.values()].map(layer => ({ id: layer.layerId, layer, version: layer.version }));
    return this.retireScope(session, layers, [...this.inflight.values()], "connection-closed");
  }
  async endSource(connectionId) {
    if (!connectionId) return { state: "absent" };
    const session = this.session?.source.connectionId === connectionId ? this.session : null;
    const layers = [...this.activeLayers.values()].filter(layer => layer.connectionId === connectionId).map(layer => ({ id: layer.layerId, layer, version: layer.version }));
    const claims = [...this.inflight.values()].filter(claim => claim.connectionId === connectionId);
    return this.retireScope(session, layers, claims, "source-connection-closed");
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      const failures = [];
      try { await this.end(this.session?.controlSessionId, "owner-stopped"); } catch (error) { failures.push(error); }
      for (const item of [...this.activeTrackers.values()]) if (item.state !== "stopped") {
        try { await this.native.request("annotation.track.stop", { trackingId: item.trackingId, clear: true }); } catch (error) { failures.push(error); }
      }
      for (const id of [...this.activeLayers.keys()]) { try { await this.clearLayer(id); } catch (error) { failures.push(error); } }
      await this.inputQueue;
      try { await this.native.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Computer control cleanup remains unconfirmed.");
    })(); return this.stopPromise;
  }
}
