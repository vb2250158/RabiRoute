import { validateHeaderName, validateHeaderValue, type ServerResponse } from "node:http";
import { businessConnectionRequestUrl, hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { ApiContractError, apiContractFailure, compileApiContract, readApiRequestEnvelope,
  type ApiHttpProxyDefinition, type ApiOperationRegistration } from "./apiOperationContract.js";
import type { ManagerPluginRouteDeclaration } from "./managerPluginRouteRegistry.js";

/** Native HTTP exchanges keep their own streaming owner; registration owns admission and the lease. */
export function registerApiHttpProxies(definitions: readonly ApiHttpProxyDefinition[],
  register: (routes: ManagerPluginRouteDeclaration[]) => () => void): ApiOperationRegistration {
  const entries = definitions.map(definition => ({ definition, operation: compileApiContract(definition) }));
  if (entries.some(({ operation }) => !operation.contract.httpProxy)) throw new Error("HTTP proxy registration requires a passthrough contract.");
  const tracker = new ManagerPluginRequestTracker();
  const pending = new Map<AbortController, ServerResponse>();
  const declarations = entries.map(({ definition, operation }): ManagerPluginRouteDeclaration => ({
    routeId: operation.contract.operationId, operation,
    match: { kind: "dynamic", description: operation.contract.pathTemplate, methods: [operation.contract.method],
      test: (_request, url) => operation.pathPattern.test(url.pathname) },
    handler: tracker.wrap((request, suppliedUrl, response) => {
      const controller = new AbortController(); pending.set(controller, response);
      let started = false, prepared = false;
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        try { hasAuthenticatedConnectionRequest(request); }
        catch { throw new ApiContractError(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization", operation.contract.operationId, started); }
      };
      const disconnected = () => controller.abort(new Error("HTTP proxy caller disconnected."));
      request.once("aborted", disconnected); response.once("close", disconnected);
      const work = Promise.resolve().then(async () => {
        assertCurrent();
        const contractHeader = operation.contract.request.contractHeader ?? "x-rabiroute-api-contract";
        if (request.headers[contractHeader] !== undefined && request.headers[contractHeader] !== operation.digest) {
          throw new ApiContractError(409, "API_CONTRACT_CHANGED", contractHeader, operation.contract.operationId);
        }
        const url = businessConnectionRequestUrl(request, suppliedUrl);
        const envelope = readApiRequestEnvelope(operation, request, url);
        started = true;
        await definition.handler({ request, response, url, ...envelope, signal: controller.signal, assertCurrent,
          prepareResponse(status, headers) {
            assertCurrent();
            if (prepared || response.headersSent || !Number.isInteger(status) || status < 200 || status > 599) {
              throw new ApiContractError(500, "API_PROXY_RESPONSE_INVALID", "response.status", operation.contract.operationId, true);
            }
            for (const [name, value] of Object.entries(headers)) {
              validateHeaderName(name);
              for (const item of Array.isArray(value) ? value : [value]) {
                if (typeof item !== "string") throw new Error("Invalid HTTP proxy response header.");
                validateHeaderValue(name, item);
              }
            }
            prepared = true;
          } });
        if (!prepared && !response.destroyed) throw new Error("HTTP proxy owner returned without response metadata.");
      }).catch(error => {
        if (response.destroyed || response.writableEnded) return;
        if (response.headersSent) { response.destroy(); return; }
        const failure = apiContractFailure(operation, error);
        if (!request.complete) { response.setHeader("connection", "close"); request.on("error", () => {}); request.resume(); }
        response.writeHead(failure.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(failure.body));
      }).finally(() => { pending.delete(controller); request.off("aborted", disconnected); response.off("close", disconnected); });
      tracker.trackOperation(work); return true;
    })
  }));
  const unregister = register(declarations);
  return { activeOperationCount: () => tracker.activeOperationCount(), async dispose() {
    unregister();
    for (const [controller, response] of pending) { controller.abort(new Error("HTTP proxy registration retired.")); response.destroy(); }
    await tracker.stop();
  } };
}
