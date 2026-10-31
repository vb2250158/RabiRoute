import type { ApiOperationDefinition } from "../../../contracts/plugin-sdk/api-operation-contract.js";
export function createDiagnosticsRoutes(context: { gatewayDiagnosticsPayload: () => unknown }): { operations: readonly ApiOperationDefinition[] };
