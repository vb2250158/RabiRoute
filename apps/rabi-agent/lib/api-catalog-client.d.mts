import type { ManagerOperationOptions, ManagerRequestOptions, ManagerReceipt, ManagerWebSocketOptions, ManagerWebSocketSession } from "./manager-client.mjs";

export type ExternalListenerBinding = Readonly<{
  kind: "external-listener"; listenerId: string; leaseId: string;
  address: Readonly<{ protocol: "http" | "https"; hostname?: string; port: number }>;
  protocol: string; invocation: "native" | "discovery-only";
  authentication: Readonly<{ kind: "none" | "native"; description: string }>;
}>;
export type ApiCatalogEntry = Readonly<{
  id: string; contractDigest: string; contract: Readonly<Record<string, unknown>>; binding?: ExternalListenerBinding;
  access?: Readonly<{ kind: "manager-native-http"; pathPrefix: string; contractHeader: string; contractDigest: string }>;
}>;
export type ApiCatalogClient = Readonly<{
  refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  invokeOperation(operationId: string, options?: ManagerOperationOptions): Promise<ManagerReceipt>;
  openOperation(operationId: string, options: ManagerWebSocketOptions): Promise<ManagerWebSocketSession>;
  invalidate(): void;
  handleEvent(event: { type?: string; event?: string }): void;
  watch(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ManagerReceipt>;
}>;
export function createApiCatalogClient(options: {
  request(method: string, target: string, options?: ManagerRequestOptions): Promise<ManagerReceipt>;
  openWebSocket?(target: string, options: ManagerWebSocketOptions, contract: Record<string, unknown>, catalog: Record<string, unknown>): Promise<ManagerWebSocketSession>;
  requestExternal?(method: string, target: string, options: ManagerOperationOptions, entry: ApiCatalogEntry, catalog: Record<string, unknown>): Promise<ManagerReceipt>;
  openExternalWebSocket?(target: string, options: ManagerWebSocketOptions, contract: Record<string, unknown>, catalog: Record<string, unknown>, entry: ApiCatalogEntry): Promise<ManagerWebSocketSession>;
}): ApiCatalogClient;
