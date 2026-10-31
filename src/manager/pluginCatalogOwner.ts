import path from "node:path";
import type { IncomingMessage } from "node:http";
import { ApiContractError, type ApiOperationResult } from "./apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import type { PluginCatalogApiContext, PluginCatalogInvocation } from "./pluginCatalogRoutes.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";

export type PluginCatalogAction = "catalog.read" | "reconciliation.read" | "reconciliation.run" | "modules.list" | "modules.read";
const noStore = { "cache-control": "no-store" };
function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiOperationResult {
  return { status, body: errorResponsePresentation(body, status), headers: { ...noStore, ...headers } };
}

/** Native catalog/reconciliation/module actions, independent of HTTP dispatch. */
export function createPluginCatalogOwner(context: PluginCatalogApiContext, readOnly = false) {
  return {
    prepare(request: IncomingMessage, action: PluginCatalogAction, signal?: AbortSignal) {
      const operationId = "manager.plugins." + action;
      let dispatched = false;
      const runtime = context.runtime, render = context.renderCatalog, reconciliation = context.reconciliation, modules = context.webModules;
      const reconcile = reconciliation?.reconcile, diagnostics = reconciliation?.diagnostics, readReadiness = reconciliation?.readiness;
      const list = modules?.list, read = modules?.read, rootReader = context.root;
      const originalGeneration = runtime.current();
      const root = rootReader?.();
      const mutation = action === "reconciliation.run";
      const fail = (status: number, code: string, field: string): never => {
        throw new ApiContractError(status, code, field, operationId, dispatched, mutation ? dispatched ? "unknown" : "not_started" : undefined);
      };
      const admitted = () => {
        try { return { principal: assertTrustedLanAgentPrincipal(request), source: getTrustedLanAgentSource(request), authenticated: hasAuthenticatedConnectionRequest(request) }; }
        catch { return fail(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization"); }
      };
      const { principal, source, authenticated } = admitted();
      const assertCurrent = () => {
        if (signal?.aborted) fail(408, "API_REQUEST_CANCELLED", "connection");
        try {
          if (assertTrustedLanAgentPrincipal(request) !== principal || getTrustedLanAgentSource(request) !== source
            || authenticated && !hasAuthenticatedConnectionRequest(request)) {
            fail(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization");
          }
          hasAuthenticatedConnectionRequest(request);
        } catch { fail(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization"); }
        const now = runtime.current();
        if (now.applicationGenerationId !== originalGeneration.applicationGenerationId || now.managerInstanceId !== originalGeneration.managerInstanceId) {
          fail(409, "API_REQUEST_IDENTITY_CHANGED", "identity");
        }
        if (context.runtime !== runtime || context.renderCatalog !== render || context.reconciliation !== reconciliation
          || context.webModules !== modules || reconciliation?.reconcile !== reconcile || reconciliation?.diagnostics !== diagnostics
          || reconciliation?.readiness !== readReadiness || modules?.list !== list || modules?.read !== read || context.root !== rootReader || rootReader?.() !== root) {
          fail(409, "API_PLUGIN_SOURCE_CHANGED", "source");
        }
      };
      const invocation: PluginCatalogInvocation = Object.freeze({ signal, assertCurrent });
      assertCurrent();
      const status = () => {
        assertCurrent();
        const generation = runtime.current();
        const diagnosticRecords = [...(diagnostics?.() ?? [])];
        const readiness = readReadiness?.call(reconciliation, generation) ?? generation.readiness;
        assertCurrent();
        return {
          schemaVersion: 1, state: readiness.state === "ready" ? "idle" : "degraded", readiness,
          active: generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId),
          waiting: generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId),
          failed: generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId), diagnostics: diagnosticRecords
        };
      };
      return {
        invocation,
        async execute(input: { host?: string | null; webRelease?: string | null; id?: string; rev?: string; relativePath?: string }): Promise<ApiOperationResult> {
          try {
            assertCurrent();
            if (mutation && readOnly) return { ...json(403, { code: -1, message: "Manager is running in read-only acceptance mode." }), mutationOutcome: "not_started" };
            if (action === "reconciliation.read") return json(200, { code: 0, data: status() });
            if (action === "reconciliation.run") {
              if (!reconcile) return { ...json(405, { code: -1, message: "Method not allowed." }), mutationOutcome: "not_started" };
              assertCurrent(); dispatched = true;
              // Join the native producer, including its queue, publication and cleanup.
              const published = await reconcile.call(reconciliation, invocation);
              assertCurrent();
              const current = runtime.current();
              if (published.id !== current.id || published.sequence !== current.sequence) fail(500, "API_PLUGIN_RECONCILIATION_UNCONFIRMED", "generation");
              return { ...json(200, { code: 0, data: status() }), mutationOutcome: "unknown" };
            }
            if (action === "modules.list") {
              const values = await (list?.call(modules, input.webRelease, invocation) ?? []);
              assertCurrent();
              return json(200, { code: 0, data: { schemaVersion: 1, modules: values } });
            }
            if (action === "modules.read") {
              // The old native route only matched a 64-hex revision; other revisions remain a 404.
              if (!/^[a-f0-9]{64}$/.test(input.rev ?? "")) return json(404, { code: -1, message: "Web plugin module was not found." });
              if (!read) return json(404, { code: -1, message: "Web plugin module was not found." });
              assertCurrent();
              const result = await read.call(modules, input.id!, input.rev!, input.relativePath!, invocation);
              assertCurrent();
              const extension = path.extname(result.path).toLowerCase();
              const contentType = extension === ".css" ? "text/css; charset=utf-8"
                : extension === ".js" || extension === ".mjs" ? "text/javascript; charset=utf-8" : "application/octet-stream";
              return { status: 200, body: result.source, headers: { "content-type": contentType,
                "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } };
            }
            if (input.host && input.host !== "web" && input.host !== "desktop") return json(400, { code: -1, message: "Plugin catalog host must be web or desktop." });
            const generation = runtime.current();
            const result = await render({ id: generation.id, sequence: generation.sequence, records: generation.records, contributions: generation.contributions },
              (input.host || undefined) as "web" | "desktop" | undefined, invocation);
            assertCurrent();
            return json(200, { code: 0, data: result.value }, { "x-rabiroute-source-revision": String(result.revision) });
          } catch (error) {
            // Source/authority failure takes precedence and cannot disclose the native error message.
            assertCurrent();
            if (error instanceof ApiContractError) throw error;
            const unavailable = action === "catalog.read";
            const statusCode = unavailable ? 503 : action === "modules.read" && (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 500;
            return { ...json(statusCode, { code: -1, message: unavailable ? "Plugin catalog presentation is unavailable."
              : error instanceof Error ? error.message : String(error) }), ...(mutation ? { mutationOutcome: dispatched ? "unknown" as const : "not_started" as const } : {}) };
          }
        }
      };
    }
  };
}
