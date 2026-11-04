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

/** The endpoint activation owns exactly its transport, including a late start after cancellation. */
export function ownMessageEndpoint(context, endpoint) {
  if (!endpoint || typeof endpoint.start !== "function") throw new Error("Endpoint must define start().");
  let starting;
  let stop;
  let retiring;
  let stopped = false;
  const retire = () => retiring ??= (async () => {
    stopped = true;
    if (starting) await starting;
    if (stop) { const ownedStop = stop; stop = undefined; await ownedStop(); }
  })();
  context.effects.adopt(retire, `release endpoint ${endpoint.type}`);
  context.publication.add({
    publish() {},
    rollback() {},
    async afterPublish({ previousRetirement, signal }) {
      await previousRetirement;
      signal.throwIfAborted();
      if (stopped) throw new Error(`Endpoint ${endpoint.type} is retiring.`);
      starting = Promise.resolve().then(() => endpoint.start()).then(dispose => {
        stop = typeof dispose === "function" ? dispose : undefined;
      });
      await starting;
      signal.throwIfAborted();
    },
    retire
  }, `publish endpoint ${endpoint.type}`);
}
export function ownMessageEndpointScan(context, provider) {
  const host = context.services.require("host.message-endpoints@1");
  const registration = host.scanProviders.prepare(provider);
  context.effects.adopt(registration.dispose, `release endpoint scan ${provider.type}`);
  context.publication.add(registration.publication, `publish endpoint scan ${provider.type}`);
}

/** One native activation owns accepted work until its real completion. */
export function ownPluginAcceptedWork(context, label = "plugin accepted work", cleanup) {
  let accepting = false, retirement;
  const leases = new Set();
  const emptyWaiters = new Set();
  const acquire = snapshot => {
    if (!accepting || context.lifecycle.signal.aborted) throw Object.assign(new Error(`${label} is disabled or retiring.`), { code: "ENDPOINT_EGRESS_UNAVAILABLE" });
    const lease = { snapshot: Object.freeze(structuredClone(snapshot ?? {})), released: false, pending: 0 };
    leases.add(lease);
    const settle = () => {
      if (!lease.released || lease.pending) return;
      leases.delete(lease);
      if (!leases.size) for (const resolve of [...emptyWaiters]) { emptyWaiters.delete(resolve); resolve(); }
    };
    return Object.freeze({ snapshot: lease.snapshot,
      async run(operation) {
        if (lease.released) throw new Error(`${label} lease was released.`);
        lease.pending++;
        try { return await operation(); } finally { lease.pending--; settle(); }
      },
      release() { lease.released = true; settle(); }
    });
  };
  const retire = () => retirement ??= (async () => {
    accepting = false;
    if (leases.size) await new Promise(resolve => emptyWaiters.add(resolve));
    await cleanup?.();
  })();
  context.effects.adopt(retire, label);
  context.publication.add({ publish() { accepting = true; }, rollback() { accepting = false; }, retire }, label);
  return Object.freeze({ acquire,
    async runAcceptedWork(operation) { const lease = acquire({}); try { return await lease.run(operation); } finally { lease.release(); } },
    inspect: () => ({ accepting, activeLeases: leases.size })
  });
}

/** Native services, rather than a second active registry, publish the endpoint egress owner. */
export function ownMessageEndpointEgress(context, definition) {
  const work = ownPluginAcceptedWork(context, `endpoint ${definition.type} egress`, definition.dispose);
  const provider = Object.freeze({ identity: context.identity, runAcceptedWork: work.runAcceptedWork, inspect: work.inspect,
    acquire(snapshot) {
      const lease = work.acquire(snapshot);
      return Object.freeze({ snapshot: lease.snapshot,
        call(operation, args) {
          const execute = definition.operations[operation];
          if (typeof execute !== "function") throw new Error(`Endpoint ${definition.type} does not implement egress operation ${operation}.`);
          const ownedArguments = structuredClone(args);
          return lease.run(() => execute(...ownedArguments));
        }, release: lease.release
      });
    }
  });
  context.services.provide(`endpoint.${definition.type}.egress@1`, provider);
  return provider;
}

function immutableAgentMetadata(value) {
  const cloned = structuredClone(value);
  const freeze = value => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
  return freeze(cloned);
}

export function parseAgentAdapterDescriptor(descriptor) {
  const type = descriptor?.type;
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const nonempty = value => typeof value === "string" && Boolean(value.trim());
  if (typeof type !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(type) || !object(descriptor) || descriptor.type !== type
    || !nonempty(descriptor.label) || !["verified", "experimental", "stub"].includes(descriptor.maturity)
    || !object(descriptor.transport) || !nonempty(descriptor.transport.protocol) || !nonempty(descriptor.transport.mode)
    || descriptor.host !== undefined && (!object(descriptor.host) || !nonempty(descriptor.host.name) || typeof descriptor.host.required !== "boolean")
    || !object(descriptor.capabilities) || descriptor.capabilities.managedTasks !== undefined && (!object(descriptor.capabilities.managedTasks)
      || Object.values(descriptor.capabilities.managedTasks).some(value => typeof value !== "boolean"))) {
    throw new Error("Invalid Agent adapter descriptor.");
  }
  const normalized = structuredClone(descriptor);
  if (normalized.capabilities.managedTasks) normalized.capabilities.managedTasks = Object.fromEntries(Object.entries(normalized.capabilities.managedTasks).filter(([,value]) => value === true));
  return immutableAgentMetadata(normalized);
}

/** Validate package metadata before evaluating its platform implementation. */
export function parseAgentAdapterPackageDescriptor(value) {
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(value) || typeof value.type !== "string"
    || typeof value.capability !== "string" || !/^[a-z][a-z0-9._:-]*@[1-9][0-9]*$/.test(value.capability)
    || !object(value.sessionBinding) || Object.values(value.sessionBinding).some(field => typeof field !== "string")) {
    throw new Error("Invalid Agent package descriptor.");
  }
  const manifest = parseAgentAdapterDescriptor(value.manifest);
  if (manifest.type !== value.type) throw new Error("Agent package descriptor identity does not match its manifest.");
  for (const key of ["sessionId", "sessionName", "workspace"]) {
    if (value.sessionBinding[key] !== undefined && !value.sessionBinding[key].trim()) throw new Error("Agent session binding field must be non-empty.");
  }
  return immutableAgentMetadata({type:value.type,capability:value.capability,manifest,sessionBinding:value.sessionBinding});
}

/** One Agent package owns its operations and the original accepted-work lifetime. */
export function ownAgentAdapter(context, definition) {
  const type = required(definition?.type, "Agent adapter type");
  const capabilityRef = required(definition?.capability, "Agent adapter capability");
  const descriptor = parseAgentAdapterPackageDescriptor({ type, capability: capabilityRef, manifest: definition.manifest, sessionBinding: definition.sessionBinding ?? {} });
  const manifest = descriptor.manifest;
  if (!definition.operations || typeof definition.operations !== "object") {
    throw new Error("Agent adapter must declare its type, capability, manifest and owned operations.");
  }
  const operations = Object.freeze({ ...definition.operations });
  for (const operation of Object.values(operations)) if (typeof operation !== "function") throw new Error("Agent adapter operations must be functions.");
  const sessionBinding = descriptor.sessionBinding;
  const work = ownPluginAcceptedWork(context, `Agent adapter ${type}`, definition.dispose);
  let ready = false;
  context.publication.add({ publish() {}, rollback() { ready = false; },
    async afterPublish({ previousRetirement, signal }) {
      await previousRetirement;
      signal.throwIfAborted();
      ready = true;
    }, retire() { ready = false; }
  }, `join previous Agent adapter ${type}`);
  const acquire = snapshot => {
    if (!ready) throw Object.assign(new Error(`Agent adapter ${type} is not ready or is retiring.`), { code: "AGENT_ADAPTER_UNAVAILABLE" });
    let original;
    try { original = work.acquire(snapshot); }
    catch (error) {
      if (error?.code !== "ENDPOINT_EGRESS_UNAVAILABLE") throw error;
      throw Object.assign(new Error(`Agent adapter ${type} is disabled or retiring.`, { cause: error }), { code: "AGENT_ADAPTER_UNAVAILABLE" });
    }
    return Object.freeze({ snapshot: original.snapshot,
      call(operation, payload, invocation) {
        const handler = operations[operation];
        if (typeof handler !== "function") throw new Error(`Agent adapter ${type} does not implement ${operation}.`);
        const input = structuredClone(payload);
        return original.run(() => handler(input, invocation, original.snapshot));
      }, release: original.release });
  };
  const provider = Object.freeze({ type, capability: capabilityRef, manifest, sessionBinding, identity: context.identity,
    ...(definition.serviceEndpoint === undefined ? {} : { serviceEndpoint: definition.serviceEndpoint }),
    ...(definition.deviceEndpoint === undefined ? {} : { deviceEndpoint: definition.deviceEndpoint }),
    acquire, runAcceptedWork(operation) {
      if (!ready) throw Object.assign(new Error(`Agent adapter ${type} is not ready or is retiring.`), { code: "AGENT_ADAPTER_UNAVAILABLE" });
      return work.runAcceptedWork(operation);
    }, inspect: () => ({ ...work.inspect(), accepting: ready && work.inspect().accepting }),
    async invoke(operation, payload, invocation) {
      const lease = acquire(invocation?.snapshot ?? {});
      try { return await lease.call(operation, payload, invocation); }
      finally { lease.release(); }
    }
  });
  context.services.provide(capabilityRef, provider);
  context.contributions.register({ kind: "agent-adapter", id: `agent.${type}.provider`, value: { type, capability: capabilityRef, manifest, sessionBinding } });
  return provider;
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
