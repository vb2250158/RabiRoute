import { PublicationScope } from "./publication.mjs";
export { PublicationScope } from "./publication.mjs";

function required(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}
function permission(value) {
  const normalized = required(value, "Plugin permission");
  if (!/^[a-z][a-z0-9._:-]*$/.test(normalized)) throw new Error(`Plugin permission is invalid: ${normalized}.`);
  return normalized;
}
export function capability(name, major) {
  const normalized = required(name, "Capability name");
  if (!/^[a-z][a-z0-9._:-]*$/.test(normalized) || !Number.isSafeInteger(major) || major < 1) {
    throw new Error("Capability must use a valid name and positive major version.");
  }
  return `${normalized}@${major}`;
}
export function definePlugin(module) {
  if (!module || typeof module.activate !== "function") throw new Error("Plugin module must define activate(context).");
  return Object.freeze({ activate: module.activate });
}
export class ServiceResolver {
  #services;
  constructor(services = []) { this.#services = new Map(services); }
  require(capabilityRef) {
    const key = required(capabilityRef, "Service capability");
    if (!this.#services.has(key)) throw new Error(`Required plugin service is unavailable: ${key}.`);
    return this.#services.get(key);
  }
  optional(capabilityRef) { return this.#services.get(required(capabilityRef, "Service capability")); }
  provide(capabilityRef, value) {
    const key = required(capabilityRef, "Service capability");
    if (this.#services.has(key)) throw new Error(`Plugin service is already registered: ${key}.`);
    this.#services.set(key, value);
  }
  entries() { return Object.freeze([...this.#services.entries()]); }
}
export class GrantedPermissions {
  #permissions;
  constructor(values = []) { this.#permissions = new Set(values.map(permission)); }
  has(value) { return this.#permissions.has(permission(value)); }
  require(value) {
    const normalized = permission(value);
    if (!this.#permissions.has(normalized)) throw new Error(`Plugin permission is required: ${normalized}.`);
  }
  list() { return Object.freeze([...this.#permissions].sort()); }
}
export class ContributionRegistrar {
  #values = [];
  #keys = new Set();
  register(value) {
    if (!value || typeof value !== "object") throw new Error("Plugin contribution must be an object.");
    const kind = required(value.kind, "Plugin contribution kind");
    const id = required(value.id, "Plugin contribution id");
    const key = `${kind}\0${id}`;
    if (this.#keys.has(key)) throw new Error(`Plugin contribution is already registered: ${kind}/${id}.`);
    this.#keys.add(key);
    this.#values.push(Object.freeze({ kind, id, value: value.value }));
  }
  list() { return Object.freeze([...this.#values]); }
}
export class EffectScope {
  #starters = [];
  #disposers = [];
  #closed = false;
  #committed = false;
  #commitFlight;
  #controller = new AbortController();
  #disposal;
  add(starter, label = "plugin effect") {
    if (this.#closed || this.#committed || typeof starter !== "function") throw new Error("Plugin effect scope is closed or invalid.");
    this.#starters.push({ starter, label });
  }
  signal() { return this.#controller.signal; }
  adopt(disposer, label = "adopted plugin resource") {
    if (this.#closed || typeof disposer !== "function") throw new Error("Plugin effect scope is closed or invalid.");
    this.#disposers.push(disposer);
  }
  commit() {
    if (this.#closed) return Promise.reject(new Error("Plugin effect scope is closed."));
    if (this.#committed) return Promise.resolve();
    // Record the flight before entering user code, including synchronous disposal.
    this.#commitFlight ??= Promise.resolve().then(async () => {
      for (const effect of this.#starters) {
        if (this.#closed) throw new Error("Plugin effect scope is closed.");
        const disposer = await effect.starter();
        if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
        this.#disposers.push(disposer);
        if (this.#closed) throw new Error("Plugin effect scope is closed.");
      }
      this.#committed = true;
    });
    return this.#commitFlight.catch(async error => {
      await this.dispose().catch(() => {});
      throw error;
    });
  }
  dispose() {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#disposal = Promise.resolve().then(() => this.#disposeNow());
    this.#controller.abort();
    return this.#disposal;
  }
  async #disposeNow() {
    // Join the actual starter, then release even resources returned after cancellation.
    await this.#commitFlight?.catch(() => {});
    let firstError;
    let failed = false;
    for (const dispose of [...this.#disposers].reverse()) {
      try { await dispose(); } catch (error) { if (!failed) firstError = error; failed = true; }
    }
    this.#starters.length = 0;
    this.#disposers.length = 0;
    if (failed) throw firstError;
  }
}
export class ScopedEventBus {
  #listeners = new Map();
  on(name, listener) {
    const eventName = required(name, "Event name");
    if (typeof listener !== "function") throw new Error("Event listener must be a function.");
    const listeners = this.#listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, value) {
    for (const listener of this.#listeners.get(required(name, "Event name")) ?? []) listener(value);
  }
  clear() { this.#listeners.clear(); }
}
export class ScopedStorage {
  #namespace;
  #values;
  constructor(namespace, values = new Map()) { this.#namespace = required(namespace, "Storage namespace"); this.#values = values; }
  #key(key) { return `${this.#namespace}:${required(key, "Storage key")}`; }
  get(key) { return this.#values.get(this.#key(key)); }
  set(key, value) { this.#values.set(this.#key(key), value); }
  delete(key) { return this.#values.delete(this.#key(key)); }
  entries() {
    const prefix = `${this.#namespace}:`;
    return Object.freeze([...this.#values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  }
}
export function createPluginTestHarness(options = {}) {
  const services = new ServiceResolver(options.services ?? []);
  const contributions = new ContributionRegistrar();
  const permissions = new GrantedPermissions(options.permissions ?? []);
  const effects = new EffectScope();
  const publication = new PublicationScope(effects);
  const identity = Object.freeze({
    applicationGenerationId: "test-application", managerInstanceId: "test-manager", activationId: "test-activation",
    instanceId: "test:plugin", pluginId: "io.test.plugin", version: "1.0.0", revision: "test", host: "manager",
    ...options.identity
  });
  const context = Object.freeze({ identity, config: options.config ?? {}, services, contributions, permissions, effects,
    publication, lifecycle: Object.freeze({ signal: effects.signal(), fail(error) { throw error; } }) });
  return Object.freeze({
    context,
    services,
    contributions,
    permissions,
    effects,
    async activate(module) {
      let finalize;
      try {
        await definePlugin(module).activate(context);
        await effects.commit();
        publication.publish();
        finalize = publication.seal();
      } catch (error) {
        try { publication.rollback(); } finally { await effects.dispose(); }
        throw error;
      }
      finalize();
      try { await publication.afterPublish(Promise.resolve()); }
      catch (error) { await effects.dispose(); throw error; }
    },
    async dispose() { await effects.dispose(); }
  });
}
