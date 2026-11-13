import { webPluginModuleContentType } from "./webPluginModules.js";
import type { IncomingMessage } from "node:http";
import { ApiContractError, type ApiOperationResult } from "./apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import type { PluginCatalogApiContext, PluginCatalogInvocation } from "./pluginCatalogRoutes.js";
import { errorResponsePresentation } from "../shared/errorPresentation.js";

export type PluginCatalogAction = "catalog.read" | "reconciliation.read" | "reconciliation.run" | "modules.list" | "modules.read" | "instances.read" | "instances.update"
  | "packages.list" | "packages.import" | "instances.install" | "instances.remove";
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
      const management = context.management, listInstances = management?.list, updateInstance = management?.update;
      const packages = management?.packages, importPackage = management?.importPackage, install = management?.install, uninstall = management?.uninstall;
      const root = rootReader?.();
      const mutation = ["reconciliation.run", "instances.update", "packages.import", "instances.install", "instances.remove"].includes(action);
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
        if (context.management !== management || management?.list !== listInstances || management?.update !== updateInstance
          || management?.packages !== packages || management?.importPackage !== importPackage || management?.install !== install || management?.uninstall !== uninstall
          || context.runtime !== runtime || context.renderCatalog !== render || context.reconciliation !== reconciliation
          || context.webModules !== modules || reconciliation?.reconcile !== reconcile || reconciliation?.diagnostics !== diagnostics
          || reconciliation?.readiness !== readReadiness || modules?.list !== list || modules?.read !== read || context.root !== rootReader || rootReader?.() !== root) {
          fail(409, "API_PLUGIN_SOURCE_CHANGED", "source");
        }
      };
      const invocation: PluginCatalogInvocation = Object.freeze({ signal, assertCurrent });
      const help = (errorCode: string, field: string, repair: string) => ({ errorCode, field, retryable: false,
        help: { method: "GET", path: `/api/agent/help?operationId=${encodeURIComponent(operationId)}` },
        repair: repair + " A failed lookup does not prove absence; handle 401/403 as connection access failures and 503 as service failures. Keep the original operation and do not automatically replay a change." });
      const moduleMissing = (field = "path") => json(404, { code: -1, message: "Web plugin module was not found.",
        ...help("PLUGIN_WEB_MODULE_NOT_FOUND", field, "Read GET /api/plugins/modules for data.modules[].id, rev and entryPath. Query GET /api/plugins/modules/:id/:rev/:relativePath with that same module's id, rev and entryPath as relativePath, URL-encoding path values. Do not guess a revision or file.") });
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
        async execute(input: { host?: string | null; webRelease?: string | null; id?: string; rev?: string; relativePath?: string; expectedRevision?: string; enabled?: boolean;
          sourceDirectory?: string; pluginId?: string; version?: string; instanceId?: string }): Promise<ApiOperationResult> {
          try {
            assertCurrent();
            if (mutation && readOnly) return { ...json(403, { code: -1, message: "Manager is running in read-only acceptance mode." }), mutationOutcome: "not_started" };
            if (["packages.list", "packages.import", "instances.install", "instances.remove"].includes(action)) {
              if (!management) return json(503, { code: -1, message: "Plugin management is unavailable." });
              let value: unknown;
              if (action === "packages.list" && packages) value = await packages.call(management, invocation);
              else if (action === "packages.import" && importPackage) { dispatched = true; value = await importPackage.call(management, input.sourceDirectory!, invocation); }
              else if (action === "instances.install" && install) { dispatched = true; value = await install.call(management, {
                expectedRevision: input.expectedRevision!, pluginId: input.pluginId!, version: input.version!, instanceId: input.instanceId
              }, invocation); }
              else if (action === "instances.remove" && uninstall) { dispatched = true; value = await uninstall.call(management, input.id!, input.expectedRevision!, invocation); }
              else return json(503, { code: -1, message: "Plugin package management is unavailable." });
              assertCurrent();
              return { ...json(200, { code: 0, data: value }), ...(mutation ? { mutationOutcome: "unknown" as const } : {}) };
            }
            if (action === "instances.read" || action === "instances.update") {
              if (!management || !listInstances || !updateInstance) return json(503, { code: -1, message: "Plugin management is unavailable." });
              let value: unknown;
              if (action === "instances.update") {
                assertCurrent(); dispatched = true;
                value = await updateInstance.call(management, input.id!, { expectedRevision: input.expectedRevision!, enabled: input.enabled! }, invocation);
              } else value = await listInstances.call(management, invocation);
              assertCurrent();
              return { ...json(200, { code: 0, data: value }), ...(mutation ? { mutationOutcome: "unknown" as const } : {}) };
            }
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
              if (!/^[a-f0-9]{64}$/.test(input.rev ?? "")) return moduleMissing("path.rev");
              if (!read) return moduleMissing("path.id");
              assertCurrent();
              const result = await read.call(modules, input.id!, input.rev!, input.relativePath!, invocation);
              assertCurrent();
              const contentType = result.contentType ?? webPluginModuleContentType(result.path);
              return { status: 200, body: result.source, headers: { "content-type": contentType,
                "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } };
            }
            if (input.host && input.host !== "web" && input.host !== "desktop") return json(400, { code: -1, message: "Plugin catalog host must be web or desktop.",
              ...help("PLUGIN_CATALOG_HOST_INVALID", "query.host", "Use host=web or host=desktop, or omit host to read all hosts. Read GET /api/plugins/catalog without host for the current catalog.") });
            const generation = runtime.current();
            const result = await render({ id: generation.id, sequence: generation.sequence, records: generation.records, contributions: generation.contributions },
              (input.host || undefined) as "web" | "desktop" | undefined, invocation);
            assertCurrent();
            return json(200, { code: 0, data: result.value }, { "x-rabiroute-source-revision": String(result.revision) });
          } catch (error) {
            // Source/authority failure takes precedence and cannot disclose the native error message.
            assertCurrent();
            if (error instanceof ApiContractError) throw error;
            const nativeCode = (error as { code?: unknown })?.code;
            const instanceMutation = action === "instances.update" || action === "instances.install" || action === "instances.remove";
            const packageMutation = action === "packages.import" || action === "instances.install";
            const hint = instanceMutation && nativeCode === "PLUGIN_SETTINGS_REVISION_CONFLICT"
              ? help(nativeCode, "body.expectedRevision", "Read GET /api/plugins/instances for data.revision and instances[].instanceId. Merge the intended change with the current state before submitting its exact revision.")
              : instanceMutation && nativeCode === "PLUGIN_INSTANCE_NOT_FOUND"
                ? help(nativeCode, "path.id", "Read GET /api/plugins/instances for currently visible data.instances[].instanceId, including disabled and failed instances. Use the complete instance ID from the original target, not a package ID. Fully retired instances may be absent; an empty listing does not authorize replacing their identity.")
                : instanceMutation && nativeCode === "PLUGIN_INSTANCE_SETTINGS_INVALID"
                  ? help(nativeCode, "instance.settings", "Read GET /api/plugins/instances for available instance diagnostics. This is a saved-settings failure, not invalid caller parameters or evidence that other instances are unusable. Absence from the list does not prove saved data is absent.")
                  : action === "instances.install" && nativeCode === "PLUGIN_INSTANCE_ID_CONFLICT"
                    ? help(nativeCode, "body.instanceId", "Read GET /api/plugins/instances for the original instanceId/pluginId/version and data.revision, and GET /api/plugins/packages for available pluginId/version values. The original instance belongs to another plugin; inspect the intended target instead of changing a frozen instance ID or overwriting its data.")
                    : packageMutation && nativeCode === "PLUGIN_PACKAGE_VERSION_CONFLICT"
                      ? help(nativeCode, action === "packages.import" ? "body.sourceDirectory" : "body.version", "Read GET /api/plugins/packages for data.packages[].pluginId/version/source. This version already owns different immutable bytes; do not overwrite it, alter its digest or automatically substitute a version. GET /api/plugins/instances separately supplies the settings revision and current instances.")
                      : packageMutation && nativeCode === "PLUGIN_PACKAGE_IDENTITY_CHANGED"
                        ? help(nativeCode, action === "packages.import" ? "body.sourceDirectory" : "body", "Read GET /api/plugins/packages for the selected pluginId/version. The package identity changed during the original import; preserve its original source and target and inspect that package before another action. This is not proof that the original attempt had no effects.")
                        : action === "packages.import" && nativeCode === "PLUGIN_PACKAGE_ENTRY_MISSING"
                          ? help(nativeCode, "body.sourceDirectory", "Read the current import operation contract and use the intended SDK-built runtime package directory on this Manager host. GET /api/plugins/packages lists packages already available, with pluginId/version/manifest; it cannot discover an arbitrary not-yet-imported directory. Keep the original source and inspect its manifest entries without guessing a replacement directory.") : undefined;
            if (action === "modules.read" && nativeCode === "ENOENT") return moduleMissing();
            const unavailable = action === "catalog.read";
            const managementStatus = action.startsWith("instances.") || action.startsWith("packages.") ? (error as { status?: number }).status : undefined;
            const statusCode = managementStatus && [400, 404, 409].includes(managementStatus) ? managementStatus
              : unavailable ? 503 : action === "modules.read" && (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 500;
            return { ...json(statusCode, { code: -1, message: unavailable ? "Plugin catalog presentation is unavailable."
              : error instanceof Error ? error.message : String(error), ...hint }), ...(mutation ? { mutationOutcome: dispatched ? "unknown" as const : "not_started" as const } : {}) };
          }
        }
      };
    }
  };
}
