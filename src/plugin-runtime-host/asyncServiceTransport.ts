import { types } from "node:util";
import type { PluginContext } from "../plugin-kernel/types.js";
import type { AsyncMethodEffect } from "./asyncOutcomeArchive.js";

export type AsyncServiceTransport = Readonly<{ kind: "async-methods"; methods: readonly string[] }>;
type ScopedTransport = AsyncServiceTransport & Readonly<{ effects: Readonly<Record<string, AsyncMethodEffect>> }>;
type ScopedFactory = Readonly<{ transport: ScopedTransport; createScope(context: PluginContext): object }>;
const transports = new WeakMap<object, ScopedTransport>();
const scopedFactories = new WeakMap<object, ScopedFactory>();

function transport(methods: readonly string[], effects: Readonly<Record<string, AsyncMethodEffect>>): ScopedTransport {
  const unique = new Set(methods);
  if (!methods.length || unique.size !== methods.length || methods.some(name => !name || ["then", "constructor", "prototype", "__proto__"].includes(name))) throw new Error("Invalid async plugin service transport methods.");
  if (Object.entries(effects).some(([method, effect]) => !unique.has(method) || !["read", "owned-resource", "mutation", "unknown"].includes(effect))) throw new Error("Invalid original-owner method effect semantics.");
  return Object.freeze({ kind: "async-methods", methods: Object.freeze([...methods]), effects: Object.freeze({ ...effects }) });
}

/** Transport semantics declared by the original service owner, never permissions. */
export function declareAsyncPluginService<T extends object>(value: T, methods: readonly string[], effects: Readonly<Record<string, AsyncMethodEffect>> = {}): T {
  if (types.isProxy(value)) throw new Error("A proxy service needs an explicit transport adapter.");
  const contract = transport(methods, effects);
  for (const name of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") throw new Error(`Async service method must be an own function: ${name}.`);
  }
  const old = transports.get(value);
  if (old && JSON.stringify(old) !== JSON.stringify(contract)) throw new Error("An existing service transport cannot be reinterpreted.");
  transports.set(value, contract);
  return value;
}

/** Explicit new async contract. The original parent's native API is unchanged. */
export function declareScopedAsyncPluginService(methods: readonly string[], effects: Readonly<Record<string, AsyncMethodEffect>>, createScope: (context: PluginContext) => object): object {
  if (typeof createScope !== "function") throw new Error("Original service owner must supply a synchronous scope factory.");
  const token: object = Object.freeze(Object.create(null));
  scopedFactories.set(token, Object.freeze({ transport: transport(methods, effects), createScope }));
  return token;
}

/** Parent-only scope setup: it must adopt any native owners before returning. */
export function scopedAsyncPluginService(value: unknown): ScopedFactory | undefined {
  return value && typeof value === "object" ? scopedFactories.get(value) : undefined;
}

export function asyncPluginServiceTransport(value: unknown): ScopedTransport | undefined {
  return value && typeof value === "object" ? transports.get(value) ?? scopedFactories.get(value)?.transport : undefined;
}
