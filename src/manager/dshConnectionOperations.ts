import type { ApiOperationDefinition } from "./apiOperationContract.js";
import type { AgentOperationInvoker } from "../agentAdapters/managerNativeOperations.js";
import { AGENT_CATALOG_OPERATIONS, agentAdapterCatalogContract } from "./agentAdapterCatalogContract.js";
import { DshConnectionError } from "../dshConnectionStore.js";

/** All legacy DSH connection URLs have one owner, its native Agent package. */
export function createDshConnectionOperations(invoke: AgentOperationInvoker): ApiOperationDefinition[] {
  return AGENT_CATALOG_OPERATIONS.filter(definition => ["connection", "connections", "connect", "disconnect"].includes(definition.key)).map(definition => ({
    contract: agentAdapterCatalogContract(definition),
    async handler(input) {
      try {
        const body = await invoke("connection", { method: input.request.method, pathname: input.url.pathname }, {
          request: input.request,
          url: input.url,
          signal: input.signal,
          parsedBody: definition.method === "POST" || definition.method === "DELETE" ? { value: input.body, signal: input.signal } : undefined
        });
        return { status: 200, body };
      } catch (error) {
        return { status: error instanceof DshConnectionError ? error.status : 500,
          body: { ok: false, message: error instanceof DshConnectionError ? error.message : "DSH connection operation failed; refresh before retrying." } };
      }
    }
  }));
}
