import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayListenerAccess, GatewayListenerDescriptor } from "@rabiroute/plugin-sdk";
import { napcatListenerLocalName } from "@rabiroute/host-api/adapters/platformNativeOperations";

type Binding = Readonly<{ gatewayId?: string; instanceId?: string }>;

/** Carries the original listener proof through the existing binding operation, never a saved port override. */
export function createNapcatWsEndpointAccess(options: {
  listeners: GatewayListenerAccess;
  signal: AbortSignal;
  timeoutMs: number;
  assertBound(request: Binding): void;
}) {
  const scope = new AsyncLocalStorage<{ key: string; descriptor: GatewayListenerDescriptor }>();
  const key = (request: Binding) => JSON.stringify([request.gatewayId, request.instanceId]);
  const validate = (descriptor: GatewayListenerDescriptor) => {
    options.signal.throwIfAborted(); descriptor.assertCurrent();
    if (descriptor.protocol !== "onebot-v11-reverse-websocket" || descriptor.address.protocol !== "http"
      || descriptor.address.hostname !== "127.0.0.1" || !Number.isInteger(descriptor.address.port)
      || descriptor.address.port < 1 || descriptor.address.port > 65535) throw new Error("The original NapCat WebSocket listener is invalid.");
    return descriptor;
  };
  return Object.freeze({
    async run<T>(request: Binding, operation: () => Promise<T>): Promise<T> {
      options.assertBound(request);
      if (!request.gatewayId || !request.instanceId) throw new Error("A bound NapCat instance is required.");
      const existing = scope.getStore();
      if (existing?.key === key(request)) { validate(existing.descriptor); return operation(); }
      const descriptor = await options.listeners.waitForListener(request.gatewayId, napcatListenerLocalName(request.instanceId), {
        signal: options.signal, timeoutMs: options.timeoutMs
      });
      options.assertBound(request); validate(descriptor);
      return scope.run({ key: key(request), descriptor }, async () => {
        const result = await operation(); validate(descriptor); return result;
      });
    },
    read(gatewayId: string, instanceId: string): GatewayListenerDescriptor | undefined {
      const existing = scope.getStore();
      if (existing?.key === key({ gatewayId, instanceId })) return validate(existing.descriptor);
      const descriptor = options.listeners.readListener(gatewayId, napcatListenerLocalName(instanceId));
      return descriptor ? validate(descriptor) : undefined;
    },
    assertCurrent() {
      const existing = scope.getStore();
      if (!existing) throw new Error("NapCat configuration requires the original WebSocket listener lease.");
      validate(existing.descriptor);
    }
  });
}
