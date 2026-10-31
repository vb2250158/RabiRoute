import { getTimeoutMs, registerTimeoutCatalog } from "../shared/timeoutSettings.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { validateExternalListenerDefinition, type ApiExternalListenerBinding, type ApiExternalListenerDefinition, type ApiExternalListenerRegistration, type ApiExternalListenerSource } from "./apiExternalListenerBinding.js";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import { DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS, runPluginSynchronousWork } from "../plugin-kernel/synchronousExecution.js";
import { preparedApiJson } from "./apiPreparedJson.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import { businessConnectionRequestUrl, hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { writeApiOperationStream } from "./apiOperationStream.js";
import { ApiStreamRetirementOwner, type ApiStreamRetirementSnapshot } from "./apiStreamRetirementOwner.js";
import { registerApiHttpProxies } from "./apiHttpProxyBinding.js";
import { createExternalListenerHttpProxy, NATIVE_LISTENER_HTTP_PREFIX, type NativeHttpRequestFactory } from "./apiExternalListenerHttpProxy.js";
import {
  ApiContractError, apiContractFailure, apiDigest, freezeApiData, apiPathParameters, compileApiOperation, prepareApiOperation, compileApiContract, compiledApiPathsEquivalent, compiledApiTailPathsOverlap, readApiOperationInput, readApiRequestEnvelope, validateApiOperationResult,
  type ApiOperationDefinition, type ApiOperationResult, type ApiOperationRegistration, type ManagerApiOperationsService, type CompiledApiContract, type CompiledApiOperation, type ApiOperationStream,
  type ApiUpgradeDefinition, type ApiUpgradeRegistration, type ApiUpgradeSession, type ApiHttpProxyDefinition
} from "./apiOperationContract.js";
import {
  createApiCatalogSnapshot, type ApiCatalogIdentity, type ApiCatalogSnapshot, type ApiCoverageGap, type ApiPublishedOperation, type ApiPublishedListener
} from "./apiOperationCatalog.js";

export type ManagerPluginRouteHandler = (
  request: IncomingMessage,
  url: URL,
  response: ServerResponse
) => boolean;

export type ManagerPluginRouteMatch =
  | { kind: "exact"; path: string; methods?: readonly string[] }
  | { kind: "prefix"; pathPrefix: string; methods?: readonly string[] }
  | {
      kind: "dynamic";
      description: string;
      methods?: readonly string[];
      test(request: IncomingMessage, url: URL): boolean;
    };

export type ManagerPluginRouteDeclaration = {
  routeId: string;
  match: ManagerPluginRouteMatch;
  handler: ManagerPluginRouteHandler;
  /** Transitional wrappers may attach the same executable contract used by their handler. */
  operation?: CompiledApiContract;
  upgradeHandler?: (request: IncomingMessage, url: URL, socket: Duplex, head: Uint8Array) => boolean;
};

export type ManagerPluginRouteSnapshotEntry = {
  instanceId: string;
  routeCount: number;
  routes: Array<{
    routeId: string;
    match: {
      kind: ManagerPluginRouteMatch["kind"];
      methods: string[];
      path?: string;
      pathPrefix?: string;
      description?: string;
    };
  }>;
};

type NormalizedManagerPluginRoute = {
  instanceId: string;
  routeId: string;
  methods: string[];
  match: ManagerPluginRouteMatch;
  handler: ManagerPluginRouteHandler;
  operation?: CompiledApiContract;
  upgradeHandler?: (request: IncomingMessage, url: URL, socket: Duplex, head: Uint8Array) => boolean;
  finalFallback?: boolean;
};

type ManagerPluginRouteBatch = {
  instanceId: string;
  activationId?: string;
  routes: readonly NormalizedManagerPluginRoute[];
  revision?: string;
};
type ExternalListenerOwner = {
  instanceId: string; activationId?: string; revision?: string;
  binding: ApiExternalListenerBinding; registry: ManagerPluginRouteRegistry; accepting: boolean;
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeMethods(methods: readonly string[] | undefined): string[] {
  const normalized = (methods?.length ? methods : ["*"])
    .map(method => required(method, "Manager plugin route method").toUpperCase());
  return [...new Set(normalized)];
}

function normalizeMatch(match: ManagerPluginRouteMatch, routeId: string): ManagerPluginRouteMatch {
  const methods = normalizeMethods(match.methods);
  if (match.kind === "exact") {
    return {
      kind: "exact",
      path: required(match.path, `Manager plugin route path ${routeId}`),
      methods
    };
  }
  if (match.kind === "prefix") {
    return {
      kind: "prefix",
      pathPrefix: required(match.pathPrefix, `Manager plugin route pathPrefix ${routeId}`),
      methods
    };
  }
  return {
    kind: "dynamic",
    description: required(match.description, `Manager plugin dynamic route description ${routeId}`),
    methods,
    test: match.test
  };
}

function methodMatches(methods: readonly string[], method: string | undefined): boolean {
  return methods.includes("*") || methods.includes((method ?? "GET").toUpperCase());
}

function methodsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.includes("*") || right.includes("*") || left.some(method => right.includes(method));
}

function staticPathsOverlap(
  left: NormalizedManagerPluginRoute,
  right: NormalizedManagerPluginRoute
): boolean {
  if (left.match.kind === "dynamic" || right.match.kind === "dynamic") return false;
  if (left.match.kind === "exact" && right.match.kind === "exact") {
    return left.match.path === right.match.path;
  }
  if (left.match.kind === "exact" && right.match.kind === "prefix") {
    return left.match.path.startsWith(right.match.pathPrefix);
  }
  if (left.match.kind === "prefix" && right.match.kind === "exact") {
    return right.match.path.startsWith(left.match.pathPrefix);
  }
  if (left.match.kind === "prefix" && right.match.kind === "prefix") {
    return left.match.pathPrefix.startsWith(right.match.pathPrefix)
      || right.match.pathPrefix.startsWith(left.match.pathPrefix);
  }
  return false;
}

function routeDescription(route: NormalizedManagerPluginRoute): string {
  if (route.match.kind === "exact") return route.match.path;
  if (route.match.kind === "prefix") return `${route.match.pathPrefix}*`;
  return route.match.description;
}

function routeMatches(
  route: NormalizedManagerPluginRoute,
  request: IncomingMessage,
  url: URL
): boolean {
  if (!methodMatches(route.methods, request.method)) return false;
  if (route.match.kind === "exact") return url.pathname === route.match.path;
  if (route.match.kind === "prefix") return url.pathname.startsWith(route.match.pathPrefix);
  return route.match.test(request, url);
}

function rejectApiUpgrade(socket: Duplex, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body));
  const safeHeaders = { ...headers, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close", "content-length": String(payload.length) };
  if (Object.entries(safeHeaders).some(([key, value]) => !/^[a-z0-9-]+$/i.test(key) || /[\r\n]/.test(value))) { socket.destroy(); return; }
  const timer = setTimeout(() => socket.destroy(), getTimeoutMs("deadline.manager.managerPluginRouteRegistry.rejectApiUpgrade", 2000)); timer.unref?.(); socket.once("close", () => clearTimeout(timer));
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Upgrade Rejected\r\n${Object.entries(safeHeaders).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`), payload]));
}

export class ManagerPluginRouteRegistry {
  private readonly batches: ManagerPluginRouteBatch[] = [];
  private readonly externalListeners: ExternalListenerOwner[] = [];
  private readonly externalSources: Array<{ instanceId: string; activationId?: string; revision?: string; source: ApiExternalListenerSource }> = [];
  private readonly externalSourceCache = new WeakMap<object, { digest: string; operations: readonly ApiPublishedOperation[]; listeners: readonly ApiPublishedListener[]; gaps: readonly ApiCoverageGap[] }>();
  private catalogRevision = 0;
  private catalogCache?: { batches: readonly ManagerPluginRouteBatch[]; identity: string; externalKey: string; snapshot: ApiCatalogSnapshot };
  private readonly requestCatalog = new AsyncLocalStorage<ApiCatalogSnapshot>();
  private nativeHttpProxy?: { key: string; proxy: ReturnType<typeof createExternalListenerHttpProxy> };
  private nativeHttpDisposal?: Promise<void>;
  private readonly operationAdmissions = new Map<string, { active: number }>();
  private readonly streamRetirements = new Set<ApiStreamRetirementOwner>();
  private readonly maximumActiveOperationsPerOperation: number;

  constructor(private readonly publishedActivations?: () => ReadonlySet<string>, private readonly catalogOptions?: {
    identity(): ApiCatalogIdentity;
    changed?(snapshot: ApiCatalogSnapshot): void;
    nativeHttpRequestFactory?: NativeHttpRequestFactory;
  }, requestLimits: Readonly<{ maximumActiveOperationsPerOperation?: number }> = {}) {
    const maximum = requestLimits.maximumActiveOperationsPerOperation ?? 64;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("API operation admission limit must be a positive safe integer.");
    this.maximumActiveOperationsPerOperation = maximum;
  }

  registerExternalListener(instanceId: string, definition: ApiExternalListenerDefinition): ApiExternalListenerRegistration {
    validateExternalListenerDefinition(definition);
    const activation = currentPluginActivation();
    if (this.publishedActivations && !activation) throw new Error("Managed listeners require a plugin activation context.");
    instanceId = required(instanceId, "External listener instanceId");
    if (this.externalListeners.some(owner => owner.accepting && owner.binding.listenerId === definition.listenerId
      && !(owner.instanceId === instanceId && owner.activationId && activation && owner.activationId !== activation.activationId))) {
      throw new Error("External listenerId already registered.");
    }
    const binding = Object.freeze({ ...definition, address: Object.freeze({ ...definition.address }),
      authentication: Object.freeze({ ...definition.authentication }), kind: "external-listener" as const, leaseId: randomUUID() });
    const registry = new ManagerPluginRouteRegistry();
    const owner: ExternalListenerOwner = { instanceId, activationId: activation?.activationId, revision: activation?.revision, binding, registry, accepting: true };
    const registrations: ApiOperationRegistration[] = [];
    this.externalListeners.push(owner);
    const ensureAccepting = () => { if (!owner.accepting) throw new Error("External listener registration retired."); };
    const validateIdentifiers = (definitions: readonly { contract: ApiOperationDefinition["contract"] }[]) => {
      ensureAccepting();
      const identifiers = new Set(definitions.flatMap(value => [value.contract.operationId, ...(value.contract.aliases ?? [])]));
      const others = [...this.batches.filter(batch => !(batch.instanceId === instanceId && batch.activationId && activation && batch.activationId !== activation.activationId))
        .flatMap(batch => batch.routes.flatMap(route => route.operation ? [route.operation.contract] : [])),
        ...this.externalListeners.filter(value => value !== owner && value.accepting
          && !(value.instanceId === instanceId && value.activationId && activation && value.activationId !== activation.activationId))
          .flatMap(value => value.registry.catalogSnapshot().operations.map(operation => operation.contract))];
      if (others.some(value => [value.operationId, ...(value.aliases ?? [])].some(id => identifiers.has(id)))) throw new Error("API operationId already registered in another address space.");
    };
    const admitted = (request: IncomingMessage) => owner.accepting && this.activeExternalListeners().includes(owner)
      && (request.headers["x-rabiroute-listener-lease"] === undefined || request.headers["x-rabiroute-listener-lease"] === binding.leaseId);
    const stopAccepting = () => {
      owner.accepting = false;
      for (const registration of registrations) if ("stopAccepting" in registration) (registration as ApiUpgradeRegistration).stopAccepting();
    };
    let disposing: Promise<void> | undefined;
    return Object.freeze({ binding,
      registerOperations: (definitions: readonly ApiOperationDefinition[]) => { validateIdentifiers(definitions); const registration = registry.registerOperations(instanceId, definitions); registrations.push(registration); return registration; },
      registerUpgrades: (definitions: readonly ApiUpgradeDefinition[]) => { validateIdentifiers(definitions); const registration = registry.registerUpgrades(instanceId, definitions); registrations.push(registration); return registration; },
      registerHttpProxies: (definitions: readonly ApiHttpProxyDefinition[]) => { validateIdentifiers(definitions); const registration = registry.registerHttpProxies(instanceId, definitions); registrations.push(registration); return registration; },
      handle: (request: IncomingMessage, url: URL, response: ServerResponse) => {
        if (!admitted(request)) {
          response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ code: -1, errorCode: "API_LISTENER_BINDING_CHANGED" })); request.resume(); return true;
        }
        return registry.handle(request, url, response);
      },
      handleUpgrade: (request: IncomingMessage, url: URL, socket: Duplex, head: Uint8Array) => {
        if (!admitted(request)) { rejectApiUpgrade(socket, 409, { code: -1, errorCode: "API_LISTENER_BINDING_CHANGED" }); return true; }
        return registry.handleUpgrade(request, url, socket, head);
      },
      stopAccepting,
      publication: () => ({ active: owner.accepting, binding, operations: owner.accepting ? registry.catalogSnapshot().operations.map(({ contract, contractDigest }) => ({ contract, contractDigest })) : [] }),
      activeOperationCount: () => registrations.reduce((total, registration) => total + registration.activeOperationCount(), 0),
      dispose: () => disposing ??= (async () => {
        stopAccepting();
        const cleaned = await Promise.allSettled(registrations.map(registration => registration.dispose()));
        const index = this.externalListeners.indexOf(owner); if (index >= 0) this.externalListeners.splice(index, 1);
        const failures = cleaned.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native listener cleanup failed.");
      })()
    });
  }

  /** Existing gateway host/IPC lifecycle owns source authenticity and retirement; this never installs a Manager handler. */
  registerExternalListenerSource(instanceId: string, source: ApiExternalListenerSource): () => void {
    const activation = currentPluginActivation();
    if (this.publishedActivations && !activation) throw new Error("Managed listener sources require a plugin activation context.");
    const entry = { instanceId: required(instanceId, "External source instanceId"), activationId: activation?.activationId, revision: activation?.revision, source };
    this.externalSources.push(entry);
    return () => { const index = this.externalSources.indexOf(entry); if (index >= 0) this.externalSources.splice(index, 1); };
  }

  private activeExternalListeners(): readonly ExternalListenerOwner[] {
    const published = this.publishedActivations?.();
    const latest = new Map<string, string | undefined>();
    for (const owner of this.externalListeners) if (owner.accepting && (!published || !!owner.activationId && published.has(owner.activationId))) latest.set(owner.instanceId, owner.activationId);
    return this.externalListeners.filter(owner => owner.accepting && latest.has(owner.instanceId) && latest.get(owner.instanceId) === owner.activationId
      && (!published || !!owner.activationId && published.has(owner.activationId)));
  }

  registerOperations(instanceId: string, definitions: readonly ApiOperationDefinition[]): ApiOperationRegistration {
    return this.registerCompiledOperations(instanceId, definitions.map(compileApiOperation));
  }

  async registerOperationsAsync(instanceId: string, definitions: readonly ApiOperationDefinition[], signal: AbortSignal): Promise<ApiOperationRegistration> {
    signal.throwIfAborted();
    // Capture all caller-owned contracts/callbacks before the first yield.
    const preparation = definitions.map(prepareApiOperation);
    const compiled: CompiledApiOperation[] = [];
    for (const prepare of preparation) {
      await yieldImmediate(undefined, { signal });
      signal.throwIfAborted();
      compiled.push(runPluginSynchronousWork(prepare, "API operation contract compilation", getTimeoutMs("api.contractCompile", 1000)));
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const registration = this.registerCompiledOperations(instanceId, compiled);
    try { signal.throwIfAborted(); }
    catch (error) { await registration.dispose(); throw error; }
    return registration;
  }

  streamRetirementDiagnostics(): readonly ApiStreamRetirementSnapshot[] {
    return [...this.streamRetirements].map(owner => owner.snapshot());
  }

  private admitOperation(instanceId: string, operationId: string): (() => void) | undefined {
    // A retired activation may still own an unknown operation. Keep its quota
    // on the stable endpoint identity, so a new activation cannot erase it.
    const key = JSON.stringify([instanceId.trim(), operationId]);
    const slot = this.operationAdmissions.get(key) ?? { active: 0 };
    if (slot.active >= this.maximumActiveOperationsPerOperation) return undefined;
    this.operationAdmissions.set(key, slot);
    slot.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--slot.active === 0) this.operationAdmissions.delete(key);
    };
  }

  private registerCompiledOperations(instanceId: string, compiled: readonly CompiledApiOperation[]): ApiOperationRegistration {
    if (compiled.some(operation => operation.contract.transport === "websocket")) throw new Error("WebSocket contracts require an upgrade transport binding; HTTP registration cannot publish them.");
    if (compiled.some(operation => operation.contract.httpProxy)) throw new Error("HTTP proxy contracts require their native transport binding.");
    const activationId = currentPluginActivation()?.activationId;
    const tracker = new ManagerPluginRequestTracker();
    const streams = new Map<AbortController, ServerResponse>();
    let closing = false;
    const declarations = compiled.map(operation => ({
      routeId: operation.contract.operationId,
      operation,
      match: { kind: "dynamic" as const, description: operation.contract.pathTemplate, methods: [operation.contract.method],
        test: (_request: IncomingMessage, url: URL) => operation.pathPattern.test(url.pathname) },
      handler: tracker.wrap((request, url, response) => {
        // Capture the published contract once. Its async work retains the original activation until completion.
        response.setHeader("x-rabiroute-api-contract", operation.digest);
        let executionStarted = false;
        let mutationOutcome: "not_started" | "unknown" | undefined;
        const captureMutationOutcome = (result: ApiOperationResult) => {
          if (result.mutationOutcome === undefined) return;
          if (result.mutationOutcome !== "not_started" && result.mutationOutcome !== "unknown") throw new ApiContractError(500, "API_OPERATION_OUTCOME_INVALID", "mutationOutcome", operation.contract.operationId, true);
          mutationOutcome = result.mutationOutcome;
        };
        let pendingStream: ApiOperationStream | undefined;
        let streamCaptureUnconfirmed = false;
        const capturePendingStream = async (result: ApiOperationResult) => {
          // Primitive results cannot own a stream; ordinary response validation reports the invalid result.
          if (result === null || (typeof result !== "object" && typeof result !== "function")) return;
          let remaining = deadlineAt === undefined ? Infinity : Math.floor(deadlineAt - performance.now());
          if (deadline && performance.now() >= deadlineAt! && !deadline.signal.aborted) deadline.abort(deadlineError());
          // A VM budget is an integer. If less than one millisecond remains,
          // yield to the original deadline instead of granting a fresh budget.
          if (deadline && remaining < 1 && !signal.aborted) {
            await new Promise<void>(resolve => {
              const aborted = () => { signal.removeEventListener("abort", aborted); resolve(); };
              signal.addEventListener("abort", aborted, { once: true });
              if (signal.aborted) aborted();
            });
          }
          if (signal.aborted || response.writableEnded || response.destroyed) {
            failResponse(signal.reason);
            // Let the framework's already-ended response reach its transport
            // before invoking any cleanup-only getter that may be faulty.
            await yieldImmediate();
          }
          remaining = deadlineAt === undefined ? Infinity : Math.floor(deadlineAt - performance.now());
          let budget = signal.aborted || response.writableEnded || response.destroyed ? getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS)
            : Math.min(getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS), remaining);
          if (budget < 1) {
            if (!signal.aborted) await new Promise<void>(resolve => {
              const aborted = () => { signal.removeEventListener("abort", aborted); resolve(); };
              signal.addEventListener("abort", aborted, { once: true });
              if (signal.aborted) aborted();
            });
            failResponse(signal.reason);
            await yieldImmediate();
            budget = getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS);
          }
          try {
            runPluginSynchronousWork(() => { pendingStream = result.stream; }, "API stream ownership " + operation.contract.operationId,
              budget);
          } catch (error) {
            streamCaptureUnconfirmed = true;
            if (deadlineAt !== undefined && performance.now() >= deadlineAt && !deadline!.signal.aborted) deadline!.abort(deadlineError());
            throw error;
          }
        };
        const configuredDeadlineMs = operation.contract.request.deadlineMs === undefined ? undefined : getTimeoutMs(`api.${operation.contract.operationId}.deadline`, operation.contract.request.deadlineMs);
        const deadline = configuredDeadlineMs === undefined ? undefined : new AbortController();
        const deadlineAt = deadline ? performance.now() + configuredDeadlineMs! : undefined;
        const deadlineError = () => new ApiContractError(408, "API_REQUEST_DEADLINE_EXCEEDED", "deadlineMs", operation.contract.operationId,
          mutationOutcome === "not_started" ? false : mutationOutcome === "unknown" || executionStarted, mutationOutcome);
        const deadlineTimer = deadline && setTimeout(() => deadline.abort(deadlineError()), configuredDeadlineMs);
        const lifetime = new AbortController();
        const disconnected = () => lifetime.abort(new ApiContractError(499, "API_RESPONSE_CONNECTION_CLOSED", "connection", operation.contract.operationId, executionStarted));
        const signal = deadline ? AbortSignal.any([lifetime.signal, deadline.signal]) : lifetime.signal;
        response.once("close", disconnected);
        if (response.destroyed || response.writableEnded) disconnected();
        const assertAuthority = () => {
          try { hasAuthenticatedConnectionRequest(request); }
          catch { throw new ApiContractError(403, "API_REQUEST_AUTHORITY_REVOKED", "authorization", operation.contract.operationId,
            mutationOutcome === "not_started" ? false : mutationOutcome === "unknown" || executionStarted, mutationOutcome); }
        };
        const failResponse = (error: unknown) => {
          if (response.writableEnded || response.destroyed) return;
          if (response.headersSent) { response.destroy(); return; }
          const failure = apiContractFailure(operation, executionStarted && !(error instanceof ApiContractError)
            ? new ApiContractError(500, "API_OPERATION_FAILED", "operation", operation.contract.operationId, true) : error);
          if (!request.complete) {
            response.setHeader("connection", "close");
            request.on("error", () => undefined);
            request.resume();
          }
          response.statusCode = failure.status;
          for (const header of ["content-length", "content-encoding", "content-range", "content-disposition"]) response.removeHeader(header);
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify(failure.body));
        };
        // The transport deadline does not release the actual owner's operation lease.
        // Uncooperative work remains tracked until it and any late stream cleanup finish.
        const deadlineAborted = () => {
          try { failResponse(deadline!.signal.reason); }
          catch (error) { response.destroy(error instanceof Error ? error : new Error("API deadline response failed.")); }
        };
        deadline?.signal.addEventListener("abort", deadlineAborted, { once: true });
        const assertDeadline = () => {
          if (deadlineAt !== undefined && performance.now() >= deadlineAt && !deadline!.signal.aborted) deadline!.abort(deadlineError());
          signal.throwIfAborted();
        };
        // in_process owners are trusted local business code. A VM wall-clock abort
        // can interrupt a committed write before finally; process plugins own hard isolation.
        const invokeOwner = <T>(callback: () => T, _label: string): T => {
          assertDeadline();
          return callback();
        };
        const invokeCalculation = <T>(callback: () => T, label: string): T => {
          assertDeadline();
          const budgetMs = deadlineAt === undefined ? getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS)
            : Math.min(getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS), Math.max(1, Math.ceil(deadlineAt - performance.now())));
          try { return runPluginSynchronousWork(callback, label, budgetMs); }
          catch (error) { assertDeadline(); throw error; }
        };
        const releaseTransport = () => {
          response.off("close", disconnected);
          deadline?.signal.removeEventListener("abort", deadlineAborted);
          if (deadlineTimer) clearTimeout(deadlineTimer);
        };
        const releaseAdmission = this.admitOperation(instanceId, operation.contract.operationId);
        if (!releaseAdmission) {
          try { failResponse(new ApiContractError(409, "API_OPERATION_CAPACITY_EXCEEDED", "operation", operation.contract.operationId, false, "not_started")); }
          finally { releaseTransport(); }
          return true;
        }
        const work = Promise.resolve().then(async () => {
          assertDeadline();
          assertAuthority();
          const contractHeader = operation.contract.request.contractHeader ?? "x-rabiroute-api-contract";
          const expectedContract = request.headers[contractHeader];
          if (expectedContract !== undefined && expectedContract !== operation.digest) {
            throw new ApiContractError(409, "API_CONTRACT_CHANGED", contractHeader, operation.contract.operationId);
          }
          const businessUrl = businessConnectionRequestUrl(request, url);
          const prepared = operation.prepare ? await invokeOwner(() => operation.prepare!({ request, response, url: businessUrl,
            ...readApiRequestEnvelope(operation, request, businessUrl), signal }), `API prepare ${operation.contract.operationId}`) : operation.handler;
          if (typeof prepared !== "function") {
            await capturePendingStream(prepared);
            invokeCalculation(() => captureMutationOutcome(prepared), "API preparation outcome " + operation.contract.operationId);
          }
          assertAuthority();
          assertDeadline();
          let result;
          if (typeof prepared === "function") {
            const input = await readApiOperationInput(operation, request, businessUrl, response, signal);
            assertAuthority();
            if (operation.contract.request.body.kind === "json") {
              try { validateLanAgentRequestBody(request, input.body); }
              catch { throw new ApiContractError(400, "API_REQUEST_SOURCE_INVALID", "body", operation.contract.operationId); }
            }
            assertAuthority();
            assertDeadline();
            result = await invokeOwner(() => {
              executionStarted = true;
              return prepared(input);
            }, `API execute ${operation.contract.operationId}`);
            await capturePendingStream(result);
          } else {
            result = prepared;
          }
          const output = invokeCalculation(() => {
            const snapshot: ApiOperationResult = { stream: pendingStream, status: result.status, body: result.body,
              headers: result.headers, mutationOutcome: result.mutationOutcome };
            captureMutationOutcome(snapshot);
            let descriptor;
            try { descriptor = validateApiOperationResult(operation, snapshot); }
            catch (error) {
              if (executionStarted && error instanceof ApiContractError) throw new ApiContractError(error.status, error.code, error.field, error.operationId, true);
              throw error;
            }
            const payload = snapshot.stream || request.method === "HEAD" || snapshot.body === undefined ? undefined
              : descriptor.binary ? snapshot.body : descriptor.mediaType.includes("json") ? preparedApiJson(snapshot.body) ?? JSON.stringify(snapshot.body) : snapshot.body;
            return { descriptor, stream: snapshot.stream, status: snapshot.status, headers: Object.entries(snapshot.headers ?? {}), payload };
          }, `API response ${operation.contract.operationId}`);
          const { descriptor, stream } = output;
          // Validation/serialization can call owner getters. Finish them before
          // checking the same deadline and authority at the disclosure boundary.
          assertDeadline();
          assertAuthority();
          if (!response.writableEnded && !response.destroyed) {
            for (const [key, value] of output.headers) response.setHeader(key, value);
            if (descriptor.mediaType !== "*/*" || !descriptor.binary) response.setHeader("content-type", descriptor.mediaType);
            response.statusCode = output.status;
          }
          if (stream) {
            const controller = new AbortController();
            const disconnected = () => controller.abort(new Error("API stream connection closed."));
            const ownerAborted = () => { controller.abort(stream.signal!.reason); if (!response.destroyed) response.destroy(); };
            const deadlineAborted = () => { controller.abort(deadline!.signal.reason); if (!response.destroyed) response.destroy(); };
            streams.set(controller, response); response.once("close", disconnected);
            stream.signal?.addEventListener("abort", ownerAborted, { once: true });
            deadline?.signal.addEventListener("abort", deadlineAborted, { once: true });
            if (deadline?.signal.aborted) deadlineAborted();
            if (stream.signal?.aborted) ownerAborted();
            if (closing || response.destroyed || response.writableEnded) disconnected();
            pendingStream = undefined; // The driver now owns cancellation and iterator cleanup.
            try { await writeApiOperationStream(operation, descriptor, stream, response, { signal: controller.signal, assertAuthority }); }
            finally { response.off("close", disconnected); stream.signal?.removeEventListener("abort", ownerAborted); deadline?.signal.removeEventListener("abort", deadlineAborted); streams.delete(controller); }
          }
          if (response.writableEnded || response.destroyed) return;
          assertDeadline();
          response.end(output.payload);
        }).catch(async error => {
          try { failResponse(error); }
          finally {
            if (pendingStream || streamCaptureUnconfirmed) {
              await yieldImmediate();
              const retirement = new ApiStreamRetirementOwner(pendingStream, { instanceId, operationId: operation.contract.operationId, activationId },
                { captureUnconfirmed: streamCaptureUnconfirmed, synchronousTimeoutMs: getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS) });
              this.streamRetirements.add(retirement);
              pendingStream = undefined; // Transfer only after the owned coordinator exists.
              const cleanup = retirement.retire(error);
              const retired = () => { this.streamRetirements.delete(retirement); };
              void cleanup.then(retired, retired);
              // Rejection is published only after cancellation and terminal
              // proof settled. Unknown owners keep this actual resource join,
              // tracker/version lease and endpoint admission slot intact.
              await cleanup.catch(() => undefined);
            }
          }
        }).finally(() => {
          try { releaseTransport(); }
          finally { releaseAdmission(); }
        });
        tracker.trackOperation(work);
        return true;
      })
    }));
    const unregister = this.register(instanceId, declarations);
    const unregisterTimeouts = registerTimeoutCatalog(compiled.flatMap(operation => operation.contract.request.deadlineMs === undefined ? [] : [{ key: `api.${operation.contract.operationId}.deadline`, defaultMs: operation.contract.request.deadlineMs, label: `接口总等待 · ${operation.contract.operationId}`, scope: operation.contract.pathTemplate, effect: "next-request" }]));
    return { dispose: async () => { closing = true; unregister(); unregisterTimeouts();
      for (const [controller, response] of streams) {
        controller.abort(new Error("API stream registration retired."));
        if (!response.destroyed && !response.writableEnded) response.destroy();
      }
      await tracker.stop(); }, activeOperationCount: () => tracker.activeOperationCount() };
  }

  registerHttpProxies(instanceId: string, definitions: readonly ApiHttpProxyDefinition[]): ApiOperationRegistration {
    return registerApiHttpProxies(definitions, declarations => this.register(instanceId, declarations));
  }

  registerUpgrades(instanceId: string, definitions: readonly ApiUpgradeDefinition[]): ApiUpgradeRegistration {
    const entries = definitions.map(definition => ({ definition, operation: compileApiContract(definition) }));
    if (entries.some(({ operation }) => operation.contract.transport !== "websocket")) throw new Error("Upgrade registration requires WebSocket contracts.");
    type Pending = { socket: Duplex; socketClosed: Promise<void>; controller: AbortController; session?: ApiUpgradeSession; work: Promise<void>; closing?: Promise<void> };
    const pending = new Set<Pending>(); let accepting = true;
    const closeOwned = (item: Pending, reason: string): Promise<void> => {
      if (!item.session) return Promise.resolve();
      return item.closing ??= Promise.resolve().then(async () => {
        try { await item.session!.close(reason); } catch { item.socket.destroy(); }
        try { await item.session!.closed; } catch { item.socket.destroy(); await item.socketClosed; }
      });
    };
    const declarations = entries.map(({ definition, operation }): ManagerPluginRouteDeclaration => ({
      routeId: operation.contract.operationId, operation,
      match: { kind: "dynamic", description: operation.contract.pathTemplate, methods: [operation.contract.method],
        test: (_request, url) => operation.pathPattern.test(url.pathname) },
      // A normal HTTP request may have a separate owner at the same URL.
      // Emit 426 only after all HTTP owners have declined the request.
      handler: () => false,
      upgradeHandler: (request, url, socket, head) => {
        if (!accepting) return false;
        const controller = new AbortController();
        let closed!: () => void; const socketClosed = new Promise<void>(resolve => { closed = resolve; });
        const disconnected = () => { controller.abort(new Error("Upgrade socket closed.")); closed(); };
        const failed = (error: Error) => { controller.abort(error); socket.destroy(); };
        socket.once("close", disconnected);
        socket.on("error", failed);
        if (socket.destroyed) disconnected();
        const current: Pending = { socket, socketClosed, controller, work: Promise.resolve() }; pending.add(current);
        let decided = false, rejected = false, prepared = false;
        const assertCurrent = () => controller.signal.throwIfAborted();
        const frame = (direction: "incoming" | "outgoing", value: unknown, size: number) => {
          assertCurrent();
          if (operation.contract.websocket!.framing === "passthrough") throw new Error("Opaque upgrades retain their native byte-stream guard; they have no decoded frame validator.");
          const validator = direction === "incoming" ? operation.upgradeIncomingValidator : operation.upgradeOutgoingValidator;
          if (!Number.isSafeInteger(size) || size < 0 || size > operation.contract.websocket!.maxMessageBytes || validator && !validator(value)) {
            throw new ApiContractError(400, "API_WEBSOCKET_FRAME_INVALID", direction, operation.contract.operationId);
          }
        };
        current.work = Promise.resolve().then(async () => {
          assertCurrent();
          const contractHeader = operation.contract.request.contractHeader ?? "x-rabiroute-api-contract";
          const expected = request.headers[contractHeader];
          if (expected !== undefined && expected !== operation.digest) throw new ApiContractError(409, "API_CONTRACT_CHANGED", contractHeader, operation.contract.operationId);
          const { path, query } = readApiRequestEnvelope(operation, request, url);
          if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) throw new ApiContractError(400, "API_BODY_UNEXPECTED", "body", operation.contract.operationId);
          await definition.handler({ request, url, socket, head, path, query, signal: controller.signal, assertCurrent,
            validateIncoming: (value, size) => frame("incoming", value, size), validateOutgoing: (value, size) => frame("outgoing", value, size),
            accept: session => {
              if (!prepared || decided || !session || typeof session.close !== "function" || typeof session.closed?.then !== "function") throw new Error("Upgrade owner returned an unprepared, invalid or duplicate session.");
              decided = true; current.session = session;
            },
            prepareHandshake: headers => {
              assertCurrent();
              if (prepared || decided || Object.entries(headers).some(([key, value]) => !/^[a-z0-9-]+$/i.test(key)
                || (typeof value !== "string" && !Array.isArray(value)) || (Array.isArray(value) ? value : [value]).some(item => typeof item !== "string" || /[\r\n]/.test(item)))) throw new Error("Invalid upgrade handshake headers.");
              const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
              const validator = operation.responseValidators.get("101")![0]!.headers;
              if (validator && !validator(normalized)) throw new ApiContractError(500, "API_RESPONSE_SCHEMA_INVALID", "upgrade.headers", operation.contract.operationId);
              prepared = true;
            },
            reject: (status, body, headers = {}) => {
              if (decided || status === 101) throw new Error("Upgrade owner already decided its handshake.");
              validateApiOperationResult(operation, { status, body, headers }); decided = true; rejected = true;
              rejectApiUpgrade(socket, status, body, { ...headers, "x-rabiroute-api-contract": operation.digest });
            }
          });
          if (current.session) {
            if (controller.signal.aborted) await closeOwned(current, "Upgrade registration stopped or caller disconnected.");
            await current.session.closed;
            if (current.closing) await current.closing;
          } else if (!decided && !socket.destroyed) throw new Error("Upgrade owner did not accept or reject the handshake.");
          if (rejected || socket.destroyed) await socketClosed;
        }).catch(async error => {
          controller.abort(error);
          if (current.session) await closeOwned(current, "Upgrade failed.");
          else if (!socket.destroyed && !rejected) { const failure = apiContractFailure(operation, error); rejectApiUpgrade(socket, failure.status, failure.body, { "x-rabiroute-api-contract": operation.digest }); await socketClosed; }
        }).finally(() => { socket.off("close", disconnected); socket.off("error", failed); pending.delete(current); });
        // Transport lifetime is an activation lease, not an automatic-code business
        // operation: an idle connection must not block unrelated source publication.
        return true;
      }
    }));
    const unregister = this.register(instanceId, declarations);
    const stopAccepting = () => {
      if (!accepting) return; accepting = false; unregister();
      for (const item of pending) if (!item.session) { item.controller.abort(new Error("Upgrade admission stopped.")); item.socket.destroy(); }
    };
    return { stopAccepting, activeOperationCount: () => pending.size, dispose: async () => {
      stopAccepting();
      const closing: Promise<void>[] = [];
      for (const item of pending) {
        item.controller.abort(new Error("Upgrade registration retired."));
        if (item.session) closing.push(closeOwned(item, "Upgrade registration retired."));
        else item.socket.destroy();
      }
      await Promise.allSettled(closing);
      while (pending.size) await Promise.allSettled([...pending].map(item => item.work));
    } };
  }

  handleUpgrade(request: IncomingMessage, url: URL, socket: Duplex, head: Uint8Array): boolean {
    const batches = this.activeBatches(), snapshot = this.liveCatalogSnapshot(batches);
    return this.requestCatalog.run(snapshot, () => {
      for (const batch of batches) for (const route of batch.routes) {
        if (route.upgradeHandler && routeMatches(route, request, url) && route.upgradeHandler(request, url, socket, head)) return true;
      }
      const route = batches.flatMap(batch => batch.routes).find(route => route.upgradeHandler && route.operation?.pathPattern.test(url.pathname));
      if (route?.operation) {
        const failure = apiContractFailure(route.operation, new ApiContractError(400, "API_UPGRADE_METHOD_INVALID", "method", route.operation.contract.operationId));
        rejectApiUpgrade(socket, failure.status, failure.body); return true;
      }
      return false;
    });
  }

  register(instanceId: string, declarations: readonly ManagerPluginRouteDeclaration[]): () => void {
    const activationId = currentPluginActivation()?.activationId;
    if (this.publishedActivations && !activationId) throw new Error("Managed plugin routes require a plugin activation context.");
    const normalizedInstanceId = required(instanceId, "Manager plugin route instanceId");
    const existingRoutes = this.batches.flatMap(batch => batch.routes);
    const routes = declarations.map(declaration => {
      const routeId = required(declaration.routeId, "Manager plugin routeId");
      const match = normalizeMatch(declaration.match, routeId);
      return {
        instanceId: normalizedInstanceId,
        routeId,
        methods: normalizeMethods(match.methods),
        match,
        handler: declaration.handler,
        operation: declaration.operation,
        upgradeHandler: declaration.upgradeHandler,
        finalFallback: declaration.operation?.contract.httpProxy?.dispatch === "final-fallback"
      };
    });
    const routeIds = new Map(existingRoutes.map(route => [route.routeId, route.instanceId]));
    for (const route of routes) {
      const routeOwner = routeIds.get(route.routeId);
      if (routeOwner && routeOwner !== normalizedInstanceId) {
        throw new Error(`Manager plugin routeId already registered: ${route.routeId}`);
      }
      routeIds.set(route.routeId, normalizedInstanceId);
    }
    const combined = [...existingRoutes, ...routes];
    for (const route of routes) {
      if (!route.operation) continue;
      const operation = route.operation.contract;
      if (operation.pathTemplate.startsWith(NATIVE_LISTENER_HTTP_PREFIX)) throw new Error("The native listener transport namespace is owned by verified listener bindings.");
      const identifiers = new Set([operation.operationId, ...(operation.aliases ?? [])]);
      if (this.externalListeners.some(owner => owner.accepting
        && !(owner.instanceId === normalizedInstanceId && owner.activationId && activationId && owner.activationId !== activationId)
        && owner.registry.catalogSnapshot().operations.some(value => [value.contract.operationId, ...(value.contract.aliases ?? [])].some(id => identifiers.has(id))))) {
        throw new Error("API operationId already registered in another address space.");
      }
      for (const other of combined) {
        const previousBatch = this.batches.find(batch => batch.routes.includes(other));
        const replacingActivation = activationId && previousBatch?.activationId && previousBatch.activationId !== activationId
          && other.instanceId === route.instanceId;
        if (other === route || !other.operation || replacingActivation) continue;
        const candidate = other.operation.contract;
        const identifiers = new Set([operation.operationId, ...(operation.aliases ?? [])]);
        if ([candidate.operationId, ...(candidate.aliases ?? [])].some(identifier => identifiers.has(identifier))) {
          throw new Error(`API operationId already registered: ${operation.operationId}`);
        }
        const finalDispatch = route.finalFallback || other.finalFallback;
        if (finalDispatch && route.finalFallback !== other.finalFallback) continue;
        if (route.finalFallback && other.finalFallback) throw new Error("Only one final HTTP fallback may be registered.");
        const equivalent = compiledApiPathsEquivalent(other.operation, route.operation);
        const sameDispatch = Boolean(route.upgradeHandler) === Boolean(other.upgradeHandler);
        if (!sameDispatch && candidate.method === operation.method && equivalent
          && candidate.pathTemplate !== operation.pathTemplate) throw new Error("HTTP and upgrade operations sharing a URL must use the same path parameter names.");
        const overlappingMethods = candidate.method === operation.method || candidate.method === "*" || operation.method === "*";
        const nativeFallback = (candidate.method === "*") !== (operation.method === "*") && route.instanceId === other.instanceId;
        if (sameDispatch && overlappingMethods && !nativeFallback && (equivalent
          || compiledApiTailPathsOverlap(other.operation, route.operation))) {
          throw new Error(`API operation routes overlap: ${operation.method} ${operation.pathTemplate}`);
        }
      }
    }
    for (let leftIndex = 0; leftIndex < combined.length; leftIndex += 1) {
      const left = combined[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < combined.length; rightIndex += 1) {
        const right = combined[rightIndex]!;
        if (left.instanceId === right.instanceId) continue;
        if (!methodsOverlap(left.methods, right.methods) || !staticPathsOverlap(left, right)) continue;
        throw new Error(
          `Manager plugin routes overlap: ${left.routeId} (${left.methods.join("|")} ${routeDescription(left)}) and ${right.routeId} (${right.methods.join("|")} ${routeDescription(right)})`
        );
      }
    }
    const batch = { instanceId: normalizedInstanceId, activationId, routes, revision: currentPluginActivation()?.revision };
    this.batches.push(batch);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.batches.indexOf(batch);
      if (index >= 0) this.batches.splice(index, 1);
    };
  }

  private activeBatches(): readonly ManagerPluginRouteBatch[] {
    const published = this.publishedActivations?.();
    const latestByInstance = new Map<string, string | undefined>();
    for (const batch of this.batches) {
      if (published && (!batch.activationId || !published.has(batch.activationId))) continue;
      latestByInstance.set(batch.instanceId, batch.activationId);
    }
    return this.batches.filter(batch =>
      latestByInstance.has(batch.instanceId)
      && latestByInstance.get(batch.instanceId) === batch.activationId
      && (!published || !!batch.activationId && published.has(batch.activationId))
    );
  }

  handle(request: IncomingMessage, url: URL, response: ServerResponse): boolean {
    const batches = this.activeBatches();
    const snapshot = this.liveCatalogSnapshot(batches);
    return this.requestCatalog.run(snapshot, () => {
      if (this.nativeHttpProxy?.proxy.handle(request, url, response)) return true;
      // Exact executable operations supersede broad transitional dispatch scopes.
      for (const fallback of [false, true]) for (const batch of batches) for (const route of batch.routes) {
        if (route.operation && !route.finalFallback && (route.operation.contract.method === "*") === fallback
          && routeMatches(route, request, url) && route.handler(request, url, response)) return true;
      }
      for (const batch of batches) {
        for (const route of batch.routes) {
          if (route.operation) continue;
          if (!routeMatches(route, request, url)) continue;
          if (route.handler(request, url, response)) return true;
        }
      }
      const upgrade = batches.flatMap(batch => batch.routes).find(route => route.upgradeHandler && routeMatches(route, request, url));
      if (upgrade?.operation) {
        const operation = upgrade.operation;
        const failure = apiContractFailure(operation, new ApiContractError(426, "API_UPGRADE_REQUIRED", "upgrade", operation.contract.operationId));
        response.writeHead(426, { upgrade: "websocket", "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-rabiroute-api-contract": operation.digest });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify(failure.body)); request.resume(); return true;
      }
      const allowed = [...new Set(batches.flatMap(batch => batch.routes)
        .filter(route => !route.finalFallback && route.operation?.pathPattern.test(url.pathname))
        .map(route => route.operation!.contract.method))].sort();
      if (allowed.length) {
        response.writeHead(405, { allow: allowed.join(", "), "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ code: -1, message: "Method not allowed" }));
        request.resume();
        return true;
      }
      for (const batch of batches) for (const route of batch.routes) {
        if (route.finalFallback && routeMatches(route, request, url) && route.handler(request, url, response)) return true;
      }
      return false;
    });
  }

  catalogSnapshot(): ApiCatalogSnapshot {
    return this.requestCatalog.getStore() ?? this.liveCatalogSnapshot();
  }

  refreshPublication(): ApiCatalogSnapshot {
    return this.liveCatalogSnapshot();
  }

  /** Gateway projection retirement waits only removed native bindings; unchanged original leases keep serving. */
  drainRetiredNativeListenerHttp(): Promise<void> {
    return this.nativeHttpProxy?.proxy.drainRetired() ?? Promise.resolve();
  }

  /** Called once by the Manager's lifetime owner after stopping ingress, never by a plugin replacement. */
  disposeNativeListenerHttp(): Promise<void> {
    if (!this.nativeHttpDisposal) {
      this.nativeHttpDisposal = this.nativeHttpProxy?.proxy.dispose() ?? Promise.resolve();
      this.catalogCache = undefined;
    }
    return this.nativeHttpDisposal;
  }

  private liveCatalogSnapshot(batches = this.activeBatches()): ApiCatalogSnapshot {
    const identity = this.catalogOptions?.identity() ?? { applicationGenerationId: "unmanaged", managerInstanceId: "unmanaged", pluginGenerationId: "unmanaged" };
    const identityKey = JSON.stringify(identity);
    const external = this.activeExternalListeners().map(owner => ({ owner, snapshot: owner.registry.catalogSnapshot() }));
    const sourced: ApiPublishedOperation[] = [], sourceGaps: ApiCoverageGap[] = [];
    const sourcedListeners: ApiPublishedListener[] = [];
    const published = this.publishedActivations?.();
    const latestSource = new Map<string, string | undefined>();
    for (const source of this.externalSources) if (!published || !!source.activationId && published.has(source.activationId)) latestSource.set(source.instanceId, source.activationId);
    for (const source of this.externalSources) {
      if (!latestSource.has(source.instanceId) || latestSource.get(source.instanceId) !== source.activationId
        || published && (!source.activationId || !published.has(source.activationId))) continue;
      try {
        if (!source.source.isCurrent()) continue;
        const publications = source.source.read();
        if (!Array.isArray(publications)) throw new Error("Native listener source must return publication records.");
        // Fingerprinting is also an item boundary: a cyclic/undefined neighbor
        // must not erase the valid native bindings from this source.
        const fingerprints = publications.map(publication => {
          try { return apiDigest(publication); } catch { return null; }
        });
        const identities = publications.map(publication => {
          try {
            if (publication?.active !== true) return null;
            const binding = publication.binding;
            return { leaseId: typeof binding?.leaseId === "string" ? binding.leaseId : null,
              listenerId: typeof binding?.listenerId === "string" ? binding.listenerId : null };
          } catch { return null; }
        });
        const digest = apiDigest(fingerprints.map((fingerprint, index) => [fingerprint, identities[index]]));
        const cached = this.externalSourceCache.get(source);
        if (cached?.digest === digest) { if (source.source.isCurrent()) { sourced.push(...cached.operations); sourcedListeners.push(...cached.listeners); sourceGaps.push(...cached.gaps); } continue; }
        const incoming: ApiPublishedOperation[] = [];
        const incomingListeners: ApiPublishedListener[] = [];
        const incomingGaps: ApiCoverageGap[] = [];
        const leases = new Map<string, number>(), listeners = new Map<string, number>();
        // Duplicate identity is ambiguous for both records, but unrelated listeners remain usable.
        for (const binding of identities) {
          if (binding?.leaseId !== null && binding?.leaseId !== undefined) leases.set(binding.leaseId, (leases.get(binding.leaseId) ?? 0) + 1);
          if (binding?.listenerId !== null && binding?.listenerId !== undefined) listeners.set(binding.listenerId, (listeners.get(binding.listenerId) ?? 0) + 1);
        }
        for (const [index, publication] of publications.entries()) {
          let routeId = `external-listener-item-${index}`;
          try {
          if (fingerprints[index] === null) throw new Error("Native listener publication is not serializable.");
          if (typeof publication.active !== "boolean") throw new Error("Native listener publication requires explicit admission state.");
          if (publication.active === false) continue;
          validateExternalListenerDefinition(publication.binding);
          routeId = publication.binding.listenerId;
          if (publication.binding.kind !== "external-listener" || !/^[a-f0-9-]{36}$/i.test(publication.binding.leaseId)) throw new Error("Invalid native listener lease.");
          if (leases.get(publication.binding.leaseId) !== 1 || listeners.get(publication.binding.listenerId) !== 1) throw new Error("Duplicate external listener publication.");
          const listenerOperations: ApiPublishedOperation[] = [];
          for (const operation of publication.operations) {
            const compiled = compileApiContract({ contract: operation.contract });
            if (compiled.digest !== operation.contractDigest) throw new Error("External owner contract digest disagrees with its executable contract.");
            if (compiled.contract.exposure === "public") listenerOperations.push({ contract: compiled.contract, contractDigest: compiled.digest,
              binding: freezeApiData(JSON.parse(JSON.stringify(publication.binding))), owner: { instanceId: source.instanceId, ...(source.activationId ? { activationId: source.activationId } : {}), ...(source.revision ? { revision: source.revision } : {}) } });
          }
          incomingListeners.push({ binding: freezeApiData(JSON.parse(JSON.stringify(publication.binding))),
            owner: { instanceId: source.instanceId, ...(source.activationId ? { activationId: source.activationId } : {}), ...(source.revision ? { revision: source.revision } : {}) } });
          incoming.push(...listenerOperations);
          } catch {
            incomingGaps.push({ instanceId: source.instanceId, routeId, kind: "external-listener", methods: [], reason: "native-owner-listener-publication-invalid" });
          }
        }
        if (source.source.isCurrent()) {
          this.externalSourceCache.set(source, { digest, operations: incoming, listeners: incomingListeners, gaps: incomingGaps });
          sourced.push(...incoming); sourcedListeners.push(...incomingListeners); sourceGaps.push(...incomingGaps);
        }
      } catch {
        sourceGaps.push({ instanceId: source.instanceId, routeId: "external-listener-source", kind: "external-listener", methods: [], reason: "native-owner-publication-unavailable-or-invalid" });
      }
    }
    const externalKey = JSON.stringify({ local: external.map(({ owner, snapshot }) => [owner.binding.leaseId, snapshot.etag]), sourced, sourcedListeners, sourceGaps });
    if (this.catalogCache?.identity === identityKey && externalKey === this.catalogCache.externalKey && batches.length === this.catalogCache.batches.length
      && batches.every((batch, index) => batch === this.catalogCache!.batches[index])) return this.catalogCache.snapshot;
    const operations: ApiPublishedOperation[] = [];
    const gaps: ApiCoverageGap[] = [];
    for (const batch of batches) for (const route of batch.routes) {
      if (route.operation) {
        if (route.operation.contract.exposure === "public") operations.push({ contract: route.operation.contract,
          contractDigest: route.operation.digest, owner: { instanceId: batch.instanceId,
            ...(batch.activationId ? { activationId: batch.activationId } : {}), ...(batch.revision ? { revision: batch.revision } : {}) } });
      } else gaps.push({ instanceId: batch.instanceId, routeId: route.routeId, kind: route.match.kind, methods: [...route.methods],
        ...(route.match.kind === "exact" ? { path: route.match.path } : {}),
        ...(route.match.kind === "prefix" ? { pathPrefix: route.match.pathPrefix } : {}), reason: "executable-contract-missing" });
    }
    for (const { owner, snapshot: child } of external) {
      for (const operation of child.operations) operations.push({ ...operation, binding: owner.binding,
        owner: { instanceId: owner.instanceId, ...(owner.activationId ? { activationId: owner.activationId } : {}), ...(owner.revision ? { revision: owner.revision } : {}) } });
      for (const gap of child.coverage.gaps) gaps.push({ ...gap, reason: `external-listener:${owner.binding.listenerId}:${gap.reason}` });
    }
    const identifiers = new Set(operations.flatMap(value => [value.contract.operationId, ...(value.contract.aliases ?? [])]));
    for (const operation of sourced) {
      const ids = [operation.contract.operationId, ...(operation.contract.aliases ?? [])];
      if (ids.some(id => identifiers.has(id))) {
        sourceGaps.push({ instanceId: operation.owner.instanceId, routeId: operation.contract.operationId, kind: "external-listener", methods: [operation.contract.method], reason: "native-owner-operation-identifier-conflict" });
        continue;
      }
      ids.forEach(id => identifiers.add(id)); operations.push(operation);
    }
    gaps.push(...sourceGaps);
    const listeners: ApiPublishedListener[] = [...external.map(({ owner }) => ({ binding: owner.binding,
      owner: { instanceId: owner.instanceId, ...(owner.activationId ? { activationId: owner.activationId } : {}), ...(owner.revision ? { revision: owner.revision } : {}) } })), ...sourcedListeners];
    const nativeKey = apiDigest(operations.map(operation => ({ contract: operation.contractDigest, binding: operation.binding ?? null, owner: operation.owner })));
    if (!this.nativeHttpDisposal && this.nativeHttpProxy?.key !== nativeKey) {
      if (this.nativeHttpProxy) { this.nativeHttpProxy.proxy.update(operations); this.nativeHttpProxy.key = nativeKey; }
      else this.nativeHttpProxy = { key: nativeKey, proxy: createExternalListenerHttpProxy(operations, (expected, started) => {
        const current = this.liveCatalogSnapshot().operations.find(operation => operation.contract.operationId === expected.contract.operationId);
        if (!current || current.contractDigest !== expected.contractDigest || current.binding?.leaseId !== expected.binding?.leaseId
          || JSON.stringify(current.binding) !== JSON.stringify(expected.binding)) throw new ApiContractError(409, "API_LISTENER_BINDING_CHANGED", "binding", expected.contract.operationId, started);
      }, this.catalogOptions?.nativeHttpRequestFactory, () => this.catalogOptions?.identity() ?? { applicationGenerationId: "unmanaged", managerInstanceId: "unmanaged" }) };
    }
    const snapshot = createApiCatalogSnapshot(identity, ++this.catalogRevision, this.nativeHttpDisposal ? operations : this.nativeHttpProxy!.proxy.operations, gaps, listeners);
    this.catalogCache = { batches, identity: identityKey, externalKey, snapshot };
    this.catalogOptions?.changed?.(snapshot);
    return snapshot;
  }

  snapshot(): ManagerPluginRouteSnapshotEntry[] {
    const entries = new Map<string, ManagerPluginRouteSnapshotEntry>();
    for (const batch of this.activeBatches()) {
      const current = entries.get(batch.instanceId) ?? {
        instanceId: batch.instanceId,
        routeCount: 0,
        routes: []
      };
      for (const route of batch.routes) {
        current.routeCount += 1;
        current.routes.push({
          routeId: route.routeId,
          match: {
            kind: route.match.kind,
            methods: [...route.methods],
            ...(route.match.kind === "exact" ? { path: route.match.path } : {}),
            ...(route.match.kind === "prefix" ? { pathPrefix: route.match.pathPrefix } : {}),
            ...(route.match.kind === "dynamic" ? { description: route.match.description } : {})
          }
        });
      }
      entries.set(batch.instanceId, current);
    }
    return [...entries.values()].map(entry => ({
      instanceId: entry.instanceId,
      routeCount: entry.routeCount,
      routes: entry.routes.map(route => ({
        routeId: route.routeId,
        match: { ...route.match, methods: [...route.match.methods] }
      }))
    }));
  }
}

/** Stable host port: plugin identity comes from its activation, never from a caller-supplied owner field. */
export function createManagerApiOperationsService(registry: ManagerPluginRouteRegistry): ManagerApiOperationsService {
  return Object.freeze({ registerExternalListener(definition) {
    const owner = currentPluginActivation();
    if (!owner || owner.host !== "manager") throw new Error("External listeners require an active Manager plugin context.");
    return registry.registerExternalListener(owner.instanceId, definition);
  }, registerOperations(definitions) {
    const owner = currentPluginActivation();
    if (!owner || owner.host !== "manager") throw new Error("API operations require an active Manager plugin context.");
    return registry.registerOperations(owner.instanceId, definitions);
  }, registerOperationsAsync(definitions, signal) {
    const owner = currentPluginActivation();
    if (!owner || owner.host !== "manager") throw new Error("API operations require an active Manager plugin context.");
    return registry.registerOperationsAsync(owner.instanceId, definitions, signal);
  }, registerHttpProxies(definitions) {
    const owner = currentPluginActivation();
    if (!owner || owner.host !== "manager") throw new Error("HTTP proxies require an active Manager plugin context.");
    return registry.registerHttpProxies(owner.instanceId, definitions);
  }, registerUpgrades(definitions) {
    const owner = currentPluginActivation();
    if (!owner || owner.host !== "manager") throw new Error("API upgrades require an active Manager plugin context.");
    return registry.registerUpgrades(owner.instanceId, definitions);
  } });
}
