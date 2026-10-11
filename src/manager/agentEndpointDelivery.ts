import { createHash } from "node:crypto";
import { resolveEndpointExecutionOptions } from "../agentRequests/executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestOptions, AgentThreadRemoteSource, AgentThreadSummary } from "../agentThreads.js";
import type { AgentRequestStore, AgentRequestParty } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { sameAgentEndpoint } from "../agentRequests/endpoint.js";
import { EndpointDeliveryRecovery, type EndpointDeliveryOptions, type PreparedEndpointDelivery, type EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { executePreparedEndpointDelivery } from "../agentRequests/endpointExecution.js";
import { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
import { assertEndpointOwnerDirectory, executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import type { LanAgentAuthority } from "./lanAgentAuthority.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import { agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";

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
};
const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const rawId = (id: unknown): string => {
  if (typeof id !== "string" || !id || id !== id.trim() || id.length > 4096) throw new Error("Complete opaque session ID is required.");
  return id;
};

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
  async function refreshEndpoints(identities: Pick<PreparedEndpointDelivery, "source" | "target">): Promise<void> {
    for (const role of ["source", "target", "source"] as const) {
      const endpoint = identities[role];
      if (endpoint.kind === "device") {
        if (!context.device) throw new Error("Device endpoint owner is unavailable.");
        await context.device.refresh?.(Object.freeze({ ...endpoint }), role);
      }
      authorize(endpoint, role);
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
  function options(remoteSource?: AgentThreadRemoteSource, requestAuthority?: () => void, deviceSource?: RabiLinkAgentPrincipal): EndpointDeliveryOptions {
    if ((remoteSource || deviceSource) && !requestAuthority) throw new Error("Remote source requires original HTTP admission authority.");
    if (remoteSource && deviceSource) throw new Error("A request cannot assert two authenticated source owners.");
    const originalDeviceSource = deviceSource ? Object.freeze({ ...deviceSource }) : undefined;
    requestAuthority?.();
    // Capture once: a fresh catalog/credential must never replace the original caller.
    const originalSource = remoteSource ? remoteEndpoint(remoteSource.nodeId, remoteSource.agentId, remoteSource.sessionId) : undefined;
    const assertRequest = () => {
      requestAuthority?.();
      if (originalSource) authorize(originalSource);
    };
    return { store: context.store, managerInstanceId, authorize: (endpoint, role) => { assertRequest(); authorize(endpoint, role); },
      refreshEndpoints: async identities => { assertRequest(); await refreshEndpoints(identities); assertRequest(); },
      resolveExecutionOptions: (request, target) => {
        assertRequest();
        const exactRequest = { ...request, agentAdapter: target.agentAdapter, threadId: target.threadId };
        const defaults = target.endpoint?.kind === "local" ? context.localOptions(exactRequest).codexDefaults : undefined;
        return resolveEndpointExecutionOptions(exactRequest, target.workspace, defaults);
      },
      resolveSource: async request => {
        assertRequest();
        const id = rawId(request.sourceThreadId);
        if (!request.sourceAgentType) throw new Error("Source Agent type is required.");
        const device = await context.device?.resolveSource(request, originalDeviceSource);
        assertRequest();
        if (device) return device;
        if (originalDeviceSource) throw new Error("Authenticated device source has no exact native owner; source substitution is forbidden.");
        if (remoteSource) {
          if (id !== remoteSource.sessionId) throw new Error("Source does not match ingress-authenticated owner.");
          return remoteParty(remoteSource.nodeId, remoteSource.agentId, id, request.sourceAgentType);
        }
        const identity = request.messageSource ? agentIdentityForMessageSource(request.messageSource) : undefined;
        if (!identity || identity.sessionId !== id) throw new Error("Local source identity is required.");
        const party = await localParty(identity.agentAdapter, id, request.sourceAgentType, request);
        assertRequest();
        return party;
      },
      resolveTarget: async request => {
        assertRequest();
        const id = rawId(request.threadId);
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
