import type { KnowledgeInvokeOptions, KnowledgeManagerReceipt } from '../../../packages/rabi-knowledge-contract/tools.mjs';
export type LocalManagerEndpoint = { managerUrl: string; meta: Record<string, unknown> };
export type ManagerRequestOptions = KnowledgeInvokeOptions & {
  signal?: AbortSignal; timeoutMs?: number; responseMode?: "text" | "bytes" | "stream";
  bodyText?: string; bodyBytes?: Uint8Array; bodyStream?: AsyncIterable<Uint8Array>; outputPath?: string;
  onChunk?: (bytes: Uint8Array) => void | Promise<void>;
  onResponse?: (response: { statusCode: number; ok: boolean; headers: Record<string, string> }) => void | Promise<void>;
};
export type ManagerReceipt = KnowledgeManagerReceipt & {
  body?: string;
  identity?: { applicationGenerationId: string; managerInstanceId: string };
  bodyBytes?: Uint8Array; bytesReceived?: number; responseMode?: "text" | "bytes" | "stream";
  outputCommitted?: boolean; path?: string; sha256?: string;
  /** The external native owner or address changed after dispatch; never replay automatically. */
  bindingChanged?: boolean;
  noReplay?: boolean;
};
export type ManagerOperationOptions = ManagerRequestOptions & {
  /** Explicit original target credentials for the direct native connector; never defaults to node credentials. */
  nativeHeaders?: Record<string, string>;
  /** Required for a native wildcard proxy; cannot override a fixed operation's method. */
  method?: string;
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
};
export type ManagerWebSocketSession = Readonly<{
  readyState: number; bufferedAmount: number; protocol: string;
  closed: Promise<Readonly<{ code: number; reason: string; errorCode?: string }>>;
  send(data: string | Uint8Array): void;
  /** Resolves after the accepted native write callback, without acknowledging business completion. */
  sendAsync(data: string | Uint8Array): Promise<void>;
  sendJson(value: unknown): void;
  sendJsonAsync(value: unknown): Promise<void>;
  close(code?: number, reason?: string): void;
  addEventListener(type: "close", listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: "close", listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}>;
export type ManagerWebSocketOptions = Pick<ManagerOperationOptions, "path" | "query" | "headers" | "nativeHeaders" | "signal" | "timeoutMs"> & {
  onMessage(value: unknown, context: { signal: AbortSignal; binary: boolean }): void | Promise<void>;
  onOpen?(session: ManagerWebSocketSession, context: { signal: AbortSignal }): void | Promise<void>;
  onClose?(result: Readonly<{ code: number; reason: string; errorCode?: string }>): void | Promise<void>;
  /** Local consumer budgets for an opaque passthrough, not server message limits. */
  maxMessageBytes?: number; maxBufferedBytes?: number; protocols?: string[];
  /** Data-only consumers may drain accepted frames after normal remote EOF. Command owners retain disconnect cancellation by default. */
  drainOnRemoteClose?: boolean;
};
export type ManagerClient = {
  request(method: string, target: string, options?: ManagerRequestOptions): Promise<ManagerReceipt>;
  invoke(method: string, target: string, options?: ManagerRequestOptions): Promise<ManagerReceipt>;
  invokeOperation(operationId: string, options?: ManagerOperationOptions): Promise<ManagerReceipt>;
  openOperation(operationId: string, options: ManagerWebSocketOptions): Promise<ManagerWebSocketSession>;
  catalog: {
    invokeOperation(operationId: string, options?: ManagerOperationOptions): Promise<ManagerReceipt>;
    openOperation(operationId: string, options: ManagerWebSocketOptions): Promise<ManagerWebSocketSession>;
    refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>>;
    invalidate(): void;
    handleEvent(event: { type?: string; event?: string }): void;
    watch(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ManagerReceipt>;
  };
};
export function createManagerClient(options: {
  managerUrl: string; localHost: true; timeoutMs?: number; fetchImpl?: typeof fetch;
  endpointSession: { ensure(options?: { diagnostic?: boolean; forceDiscovery?: boolean }): Promise<LocalManagerEndpoint> };
} | {
  managerUrl?: string; credential?: string; agentType?: string; sessionId?: string; timeoutMs?: number; fetchImpl?: typeof fetch;
  configPath?: string; config?: { managerUrl: string; nodeCredential?: string; managerGuid?: string; [key: string]: unknown };
  discover?: (...args: unknown[]) => Promise<unknown>;
}): ManagerClient;
/** Internal delivery-owner network transport; public callers use createManagerClient. */
export function createManagerTransport(options: Parameters<typeof createManagerClient>[0]): ManagerClient;
