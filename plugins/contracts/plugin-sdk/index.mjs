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
  add(starter, label = "plugin effect") {
    if (this.#closed || typeof starter !== "function") throw new Error("Plugin effect scope is closed or invalid.");
    this.#starters.push({ starter, label });
  }
  async commit() {
    if (this.#closed) throw new Error("Plugin effect scope is closed.");
    try {
      for (const effect of this.#starters) {
        const disposer = await effect.starter();
        if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
        this.#disposers.push(disposer);
      }
    } catch (error) {
      await this.dispose().catch(() => {});
      throw error;
    }
  }
  async dispose() {
    if (this.#closed) return;
    this.#closed = true;
    let firstError;
    for (const dispose of [...this.#disposers].reverse()) {
      try { await dispose(); } catch (error) { firstError ??= error; }
    }
    this.#starters.length = 0;
    this.#disposers.length = 0;
    if (firstError) throw firstError;
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
  const identity = Object.freeze(options.identity ?? {
    instanceId: "test:plugin", pluginId: "io.test.plugin", version: "1.0.0", revision: "test", host: "manager"
  });
  const context = Object.freeze({ identity, config: options.config ?? {}, services, contributions, permissions, effects });
  return Object.freeze({
    context,
    services,
    contributions,
    permissions,
    effects,
    async activate(module) { await definePlugin(module).activate(context); await effects.commit(); },
    async dispose() { await effects.dispose(); }
  });
}
