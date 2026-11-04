import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentAdapterInvocation, AgentAdapterProvider } from "@rabiroute/plugin-sdk";

export type AgentManagerOperationInvoker = <T = unknown>(
  type: string, operation: string, payload: unknown, invocation?: AgentAdapterInvocation
) => Promise<T>;
type InvocationContext = {
  invokeAgentOperation?: AgentManagerOperationInvoker;
  getProviders?: () => readonly AgentAdapterProvider[];
  requestAuthority?: () => void;
};
type ProviderLease = ReturnType<AgentAdapterProvider["acquire"]>;
type RequestScope = {
  context: InvocationContext;
  providers?: ReadonlyMap<string, AgentAdapterProvider>;
  pins: Map<string, { provider: AgentAdapterProvider; lease: ProviderLease }>;
};
const scope = new AsyncLocalStorage<RequestScope>();

/** Capture one native generation; leases cover the original host request, including its ledger tail. */
export function withAgentManagerInvocation<T>(context: InvocationContext, operation: () => T): T {
  const parent = scope.getStore();
  if (parent) return scope.run({ ...parent, context: { ...parent.context, ...context } }, operation);
  const providers = context.getProviders?.();
  const current: RequestScope = {
    context,
    ...(providers ? { providers: new Map(providers.map(provider => [provider.type, provider])) } : {}),
    pins: new Map()
  };
  const release = () => { for (const pin of current.pins.values()) pin.lease.release(); };
  let result: T;
  try { result = scope.run(current, operation); }
  catch (error) { release(); throw error; }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result).finally(release) as T;
  }
  release();
  return result;
}

export function scopedAgentManagerProviders(fallback: () => readonly AgentAdapterProvider[]): readonly AgentAdapterProvider[] {
  const current = scope.getStore();
  return current?.providers ? [...current.providers.values()] : fallback();
}

/** Pure metadata ports and asynchronous primitives select the same original provider. */
export function scopedAgentManagerProvider(type: string, fallback: () => readonly AgentAdapterProvider[]): AgentAdapterProvider | undefined {
  return scope.getStore()?.providers?.get(type) ?? (scope.getStore()?.providers ? undefined : fallback().find(provider => provider.type === type));
}

export function invokeAgentProviderOperation<T = unknown>(
  provider: AgentAdapterProvider,
  operation: string,
  payload: unknown,
  invocation?: AgentAdapterInvocation
): Promise<T> {
  const current = scope.getStore();
  if (!current?.providers) return provider.invoke<T>(operation, payload, invocation);
  const original = current.providers.get(provider.type);
  if (!original) throw Object.assign(new Error(`Agent plugin is unavailable: ${provider.type}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
  let pin = current.pins.get(provider.type);
  if (!pin) {
    pin = { provider: original, lease: original.acquire(invocation?.snapshot ?? {}) };
    current.pins.set(provider.type, pin);
  }
  return pin.lease.call<T>(operation, payload, invocation);
}

export function invokeScopedAgentManagerOperation<T = unknown>(
  type: string, operation: string, payload: unknown, invocation?: AgentAdapterInvocation
): Promise<T> {
  const current = scope.getStore();
  const authority = { ...invocation, assertCurrent: invocation?.assertCurrent ?? current?.context.requestAuthority };
  if (current?.providers) {
    const provider = current.providers.get(type);
    if (!provider) throw Object.assign(new Error(`Agent plugin operation is unavailable: ${type}/${operation}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
    return invokeAgentProviderOperation<T>(provider, operation, payload, authority);
  }
  // Explicit isolated callers can supply their original invoker without creating a platform fallback.
  if (current?.context.invokeAgentOperation) return current.context.invokeAgentOperation<T>(type, operation, payload, authority);
  throw Object.assign(new Error(`Agent plugin operation is unavailable: ${type}/${operation}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
}

export type NativeAgentFunction<F extends (...args: any[]) => unknown> = (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>;
export function agentNativeFunction<F extends (...args: any[]) => unknown>(type: string, operation: string): NativeAgentFunction<F> {
  return (...nativeArgs) => invokeScopedAgentManagerOperation(type, `native.${operation}`, {}, { nativeArgs });
}
