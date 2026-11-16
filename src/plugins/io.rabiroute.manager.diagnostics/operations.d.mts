import type { ApiOperationDefinition } from "../../../contracts/plugin-sdk/api-operation-contract.js";
export function createDiagnosticsRoutes(context: { gatewayDiagnosticsPayload: () => unknown; callHistory?: {
  list(query: unknown): Promise<unknown>; detail(callId: string, spanId?: string, boundary?: string): Promise<unknown>; listStages(callId: string): Promise<unknown>; ingest(value: unknown): Promise<unknown>;
  configure(value: unknown): Promise<unknown>; events(): import("../../../contracts/plugin-sdk/api-operation-contract.js").ApiOperationStream;
} }): { operations: readonly ApiOperationDefinition[] };
