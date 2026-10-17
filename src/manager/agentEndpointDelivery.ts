import { createHash } from "node:crypto";
import { resolveEndpointExecutionOptions, type EndpointExecutionOptions } from "../agentRequests/executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestOptions, AgentThreadRemoteSource, AgentThreadSummary } from "../agentThreads.js";
import type { AgentRequestStore, AgentRequestParty } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { normalizeAgentRequestEndpoint, sameAgentEndpoint } from "../agentRequests/endpoint.js";
import { EndpointDeliveryRecovery, EndpointVerificationError, type EndpointDeliveryOptions, type PreparedEndpointDelivery, type EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { executePreparedEndpointDelivery } from "../agentRequests/endpointExecution.js";
import { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
import { assertEndpointOwnerDirectory, executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import type { LanAgentAuthority } from "./lanAgentAuthority.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import { agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { AgentThreadContractError, completeAgentSessionId, normalizeAgentThreadSourceType } from "../agentRequests/requestValidation.js";

export type AgentServiceSourcePrincipal = {
  provider: AgentAdapterType;
  agentId: string;
  sessionId: string;
  authorizationIncarnation: string;
};
export type AgentServiceEndpointBridge = {
  owns(endpoint: AgentRequestEndpoint): boolean;
  resolveSource(request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal): Promise<AgentRequestParty | undefined>;
  resolveTarget(request: AgentThreadRequest): Promise<AgentRequestParty | undefined>;
  authorize(endpoint: AgentRequestEndpoint, role?: "source" | "target"): void;
  refresh?(endpoint: AgentRequestEndpoint, role?: "source" | "target"): Promise<void>;
  resolveExecutionOptions(request: AgentThreadRequest, target: AgentRequestParty): EndpointExecutionOptions;
  transport(delivery: PreparedEndpointDelivery, guard: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined>;
};

export type AgentDeviceEndpointBridge = {
  resolveSource(request: AgentThreadRequest, principal?: RabiLinkAgentPrincipal): Promise<AgentRequestParty | undefined>;
  resolveTarget(request: AgentThreadRequest): Promise<AgentRequestParty | undefined>;
  authorize(endpoint: AgentRequestEndpoint, role?: "source" | "target"): void;
  refresh?(endpoint: AgentRequestEndpoint, role?: "source" | "target"): Promise<void>;
  transport(delivery: PreparedEndpointDelivery, guard: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined>;
};

export type AgentEndpointDeliveryContext = {
  store: AgentRequestStore;
  authority: LanAgentAuthority;
  registry: LanAgentRegistry;
  config: RabiGlobalConfigStore;
  receiptDirectory: string;
  readLocal: (provider: AgentAdapterType, sessionId: string, options: AgentThreadRequestOptions) => Promise<AgentThreadSummary>;
  localOptions: (request: AgentThreadRequest) => AgentThreadRequestOptions;
  device?: AgentDeviceEndpointBridge;
  service?: AgentServiceEndpointBridge;
};
const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Manager owns business records; registry/catalog is discovery, never authorization. */
export function createAgentEndpointDelivery(context: AgentEndpointDeliveryContext) {
  const managerInstanceId = context.registry.localInstanceId;
  const receipts = new EndpointTransportReceipts(context.receiptDirectory);
  function remoteEndpoint(nodeId: string, agentId: string, sessionId: string): AgentRequestEndpoint {
    const policy = context.config.getLanAgentDeliveryPolicy();
    const lease = context.authority.getEndpointAuthorization(nodeId, agentId);
    const binding = lease?.binding;
    if (!policy.enabled || !lease || !binding || !(binding.sessionId === sessionId || binding.managedSessionIds?.includes(sessionId))) {
      throw new Error("Original remote endpoint is disabled, revoked or unapproved.");
    }
    return { kind: "instance", managerInstanceId, instanceId: nodeId, nodeId, agentId,
      provider: binding.provider === "codex-desktop" ? "codex" : binding.provider, sessionId,
      authorizationIncarnation: digest([lease.incarnation, policy.incarnation]) };
  }
  function authorize(endpoint: AgentRequestEndpoint, role?: "source" | "target"): void {
    if (endpoint.managerInstanceId !== managerInstanceId) throw new Error("Endpoint belongs to another Manager authority.");
    if (context.service?.owns(endpoint)) {
      context.service.authorize(endpoint, role);
      return;
    }
    if (endpoint.kind === "device") {
      if (!context.device) throw new Error("Device endpoint owner is unavailable.");
      context.device.authorize(endpoint, role);
      return;
    }
    if (endpoint.kind === "instance") {
      if (endpoint.instanceId !== endpoint.nodeId || !sameAgentEndpoint(endpoint, remoteEndpoint(endpoint.nodeId!, endpoint.agentId, endpoint.sessionId))) {
        throw new Error("Original endpoint incarnation was revoked or rebound.");
      }
    } else if (endpoint.agentId !== `local:${endpoint.provider}` || endpoint.authorizationIncarnation !== digest([managerInstanceId, endpoint.agentId, endpoint.provider, endpoint.sessionId])) {
      throw new Error("Invalid local endpoint authority.");
    }
  }
  // A Grok Bot source proof is a remote owner read; reuse one that is at most 60s old instead of re-reading per hop.
  const sourceProofs = new Map<string, number>();
  const SOURCE_PROOF_TTL_MS = 60_000;
  async function refreshEndpoints(identities: Pick<PreparedEndpointDelivery, "source" | "target">): Promise<void> {
    // Target first, source last: a source unloaded while awaiting the target proof is still caught, with one visit each.
    for (const role of ["target", "source"] as const) {
      const endpoint = identities[role];
      try {
        if (context.service?.owns(endpoint)) {
          const cacheable = role === "source" && endpoint.provider === "grokBot";
          const key = cacheable ? JSON.stringify(normalizeAgentRequestEndpoint(endpoint)) : "";
          const checkedAt = cacheable ? sourceProofs.get(key) : undefined;
          if (checkedAt === undefined || Date.now() - checkedAt > SOURCE_PROOF_TTL_MS) {
            if (cacheable) sourceProofs.delete(key);
            await context.service.refresh?.(Object.freeze({ ...endpoint }), role);
            if (cacheable) sourceProofs.set(key, Date.now());
          }
        }
        if (endpoint.kind === "device") {
          if (!context.device) throw new Error("Device endpoint owner is unavailable.");
          await context.device.refresh?.(Object.freeze({ ...endpoint }), role);
        }
        authorize(endpoint, role);
      } catch (error) {
        if (role === "source") sourceProofs.delete(JSON.stringify(normalizeAgentRequestEndpoint(endpoint)));
        throw error instanceof EndpointVerificationError ? error : new EndpointVerificationError(role, error);
      }
    }
  }
  async function localParty(provider: AgentAdapterType, sessionId: string, type: string, request: AgentThreadRequest, requiresDirectory = false): Promise<AgentRequestParty> {
    const summary = await context.readLocal(provider, sessionId, context.localOptions({ ...request, threadId: sessionId, agentAdapter: provider }));
    if (summary.id !== sessionId || summary.archived) throw new Error("Exact local task owner is unavailable.");
    if (requiresDirectory) assertEndpointOwnerDirectory(summary.cwd);
    const agentId = `local:${provider}`;
    return { agentAdapter: provider, agentType: type, threadId: sessionId, threadName: summary.title, workspace: summary.cwd,
      endpoint: { kind: "local", managerInstanceId, agentId, provider, sessionId,
        authorizationIncarnation: digest([managerInstanceId, agentId, provider, sessionId]) } };
  }
  function remoteParty(nodeId: string, agentId: string, sessionId: string, type: string): AgentRequestParty {
    const endpoint = remoteEndpoint(nodeId, agentId, sessionId);
    const catalog = context.registry.getInstanceAgent(nodeId, agentId);
    if (!catalog || (catalog.provider === "codex-desktop" ? "codex" : catalog.provider) !== endpoint.provider) throw new Error("Exact remote Agent catalog is unavailable.");
    return { endpoint, agentAdapter: endpoint.provider as AgentAdapterType, agentType: type, threadId: sessionId,
      threadName: catalog.name || agentId, workspace: catalog.workspace };
  }
  async function transport(delivery: PreparedEndpointDelivery, assertAuthorized: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined> {
    assertAuthorized();
    if (context.service?.owns(delivery.target)) return context.service.transport(delivery, assertAuthorized, reconcile);
    if (delivery.target.kind === "device") {
      if (!context.device) throw new Error("Device endpoint owner is unavailable.");
      return context.device.transport(delivery, assertAuthorized, reconcile);
    }
    if (delivery.target.kind === "instance") {
      const receipt = await context.registry.manageAgent(delivery.target.instanceId!, reconcile ? "reconcile_prepared_delivery" : "prepared_delivery",
        { agentId: delivery.target.agentId, agentAdapter: delivery.target.provider, delivery }, 30_000, assertAuthorized);
      assertAuthorized();
      return receipt as EndpointDeliveryReceipt | undefined;
    }
    const options = context.localOptions({ threadId: delivery.target.sessionId, agentAdapter: delivery.target.provider as AgentAdapterType });
    return executePreparedEndpointDelivery(delivery, { endpoint: delivery.target, assertAuthorized,
      readReceipt: value => receipts.readReceipt(value), writeReceipt: (value, receipt) => receipts.writeReceipt(value, receipt),
      beginAttempt: value => receipts.beginAttempt(value), recoverReceipt: recoverEndpointOwnerReceipt,
      send: (value, guard) => executeEndpointOnOwner(value, options, guard) }, reconcile);
  }
  function options(remoteSource?: AgentThreadRemoteSource, requestAuthority?: () => void, deviceSource?: RabiLinkAgentPrincipal,
    serviceSource?: AgentServiceSourcePrincipal, callerExecutionOptions?: EndpointDeliveryOptions["callerExecutionOptions"]): EndpointDeliveryOptions {
    if ((remoteSource || deviceSource || serviceSource) && !requestAuthority) throw new Error("Remote source requires original HTTP admission authority.");
    if ([remoteSource, deviceSource, serviceSource].filter(Boolean).length > 1) throw new Error("A request cannot assert two authenticated source owners.");
    const originalDeviceSource = deviceSource ? Object.freeze({ ...deviceSource }) : undefined;
    const originalServiceSource = serviceSource ? Object.freeze({ ...serviceSource }) : undefined;
    const originalCallerExecutionOptions = callerExecutionOptions === undefined ? undefined : Object.freeze({ ...callerExecutionOptions });
    requestAuthority?.();
    // Capture once: a fresh catalog/credential must never replace the original caller.
    const originalSource = remoteSource ? remoteEndpoint(remoteSource.nodeId, remoteSource.agentId, remoteSource.sessionId) : undefined;
    const assertRequest = () => {
      requestAuthority?.();
      if (originalSource) authorize(originalSource);
    };
    return { store: context.store, managerInstanceId, callerExecutionOptions: originalCallerExecutionOptions,
      authorize: (endpoint, role) => { assertRequest(); authorize(endpoint, role); },
      refreshEndpoints: async identities => { assertRequest(); await refreshEndpoints(identities); assertRequest(); },
      resolveExecutionOptions: (request, target) => {
        assertRequest();
        const exactRequest = { ...request, agentAdapter: target.agentAdapter, threadId: target.threadId };
        if (target.endpoint && context.service?.owns(target.endpoint)) return context.service.resolveExecutionOptions(exactRequest, target);
        const defaults = target.endpoint?.kind === "local" ? context.localOptions(exactRequest).codexDefaults : undefined;
        return resolveEndpointExecutionOptions(exactRequest, target.workspace, defaults);
      },
      resolveSource: async request => {
        assertRequest();
        const id = completeAgentSessionId(request.sourceThreadId, "sourceThreadId");
        const sourceAgentType = normalizeAgentThreadSourceType(request.sourceAgentType, true);
        request = { ...request, sourceAgentType };
        const device = await context.device?.resolveSource(request, originalDeviceSource);
        assertRequest();
        if (device) return device;
        if (originalDeviceSource) throw new Error("Authenticated device source has no exact native owner; source substitution is forbidden.");
        if (remoteSource) {
          if (id !== remoteSource.sessionId) throw new Error("Source does not match ingress-authenticated owner.");
          return remoteParty(remoteSource.nodeId, remoteSource.agentId, id, sourceAgentType);
        }
        const service = await context.service?.resolveSource(request, originalServiceSource);
        assertRequest();
        if (service) {
          if (!service.endpoint || !context.service?.owns(service.endpoint)
            || (originalServiceSource && (originalServiceSource.provider !== service.agentAdapter || originalServiceSource.sessionId !== service.threadId
              || originalServiceSource.agentId !== service.endpoint.agentId || originalServiceSource.authorizationIncarnation !== service.endpoint.authorizationIncarnation))) {
            throw new AgentThreadContractError("Service source does not match the authenticated owner.", "messageSource", "source_verification",
              "Use the original registered service owner's adapter and session identity.");
          }
          return service;
        }
        if (originalServiceSource) throw new AgentThreadContractError("Authenticated service source has no exact owner; source substitution is forbidden.",
          "messageSource", "source_verification", "Restore the original service owner before retrying; do not substitute a Desktop session.");
        const identity = request.messageSource ? agentIdentityForMessageSource(request.messageSource) : undefined;
        if (!identity || identity.sessionId !== id) throw new AgentThreadContractError("Local source identity is required.", "messageSource", "source_verification",
          "Declare an existing Agent source or plan.sourceAgent matching sourceThreadId; system and message_adapter sources cannot establish Agent ownership.");
        const party = await localParty(identity.agentAdapter, id, sourceAgentType, request);
        assertRequest();
        return party;
      },
      resolveTarget: async request => {
        assertRequest();
        const id = completeAgentSessionId(request.threadId, "threadId");
        const service = await context.service?.resolveTarget(request);
        assertRequest();
        if (service) {
          if (!service.endpoint || !context.service?.owns(service.endpoint)) throw new Error("Service target has no registered owner.");
          return service;
        }
        const device = await context.device?.resolveTarget(request);
        assertRequest();
        if (device) return device;
        const binding = request.instanceBinding;
        if (binding && binding.instanceId !== managerInstanceId) {
          const party = remoteParty(binding.instanceId, binding.agentId, id, request.messageProcessing?.targetAgentType || "agent");
          if (request.agentAdapter && request.agentAdapter !== party.agentAdapter) throw new Error("Target provider does not match approved endpoint.");
          return party;
        }
        const provider = request.agentAdapter;
        if (!provider) throw new Error("Explicit target provider is required for endpoint delivery.");
        if (binding && binding.agentId !== `local:${provider}`) throw new Error("Local binding provider mismatch.");
        const collisions = context.registry.listInstances().filter(instance => !instance.local).flatMap(instance => instance.agents)
          .filter(agent => agent.sessionId === id || agent.managedSessionIds?.includes(id));
        if (!request.agentTargetId && !binding && collisions.length) throw new Error("Ambiguous instance identity; select an exact binding or local provider.");
        if (request.agentTargetId && request.agentTargetId !== `local:${provider}`) throw new Error("Explicit local provider mismatch.");
        const party = await localParty(provider, id, request.messageProcessing?.targetAgentType || "agent", request, true);
        assertRequest();
        return party;
      },
      dispatch: async (delivery, guard) => {
        const receipt = await transport(delivery, guard, false);
        if (!receipt) throw new Error("No exact owner receipt; original attempt must not be replayed.");
        return receipt;
      }, reconcile: (delivery, guard) => transport(delivery, guard, true) };
  }
  const recovery = new EndpointDeliveryRecovery(options());
  return { options, authorize, refreshEndpoints, recovery, remoteEndpoint };
}
