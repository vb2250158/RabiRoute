import { withAgentManagerInvocation } from "../agentAdapters/managerInvocation.js";
import { createHash } from "node:crypto";
import { resolveEndpointExecutionOptions, type EndpointExecutionOptions } from "../agentRequests/executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestOptions, AgentThreadRemoteSource, AgentThreadSummary } from "../agentThreads.js";
import type { AgentRequestStore, AgentRequestParty } from "../agentRequests/store.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { sameAgentEndpoint } from "../agentRequests/endpoint.js";
import { EndpointDeliveryRecovery, EndpointVerificationError, reconcileEndpointDelivery, type EndpointDeliveryOptions, type PreparedEndpointDelivery, type EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import { executePreparedEndpointDelivery } from "../agentRequests/endpointExecution.js";
import { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
import { assertEndpointOwnerDirectory, executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import type { LanAgentAuthority } from "./lanAgentAuthority.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import { agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { parseAgentAdapterType } from "../agentAdapters/types.js";
import { agentWorkspaceMismatch, completeAgentSessionId, normalizeAgentThreadSourceType } from "../agentRequests/requestValidation.js";
import { EndpointDeliveryNotSentError, validateEndpointDeliveryNoFrameProof } from "../agentRequests/deliveryFailure.js";
import type { PeerAgentEndpointBridge } from "./peerAgentEndpointBridge.js";

export type AgentServiceSourcePrincipal = {
  provider: AgentAdapterType;
  agentId: string;
  sessionId: string;
  authorizationIncarnation: string;
};
export type AgentServiceEndpointBridge = {
  handlesSource?(request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal): boolean;
  handlesTarget?(request: AgentThreadRequest): boolean;
  owns(endpoint: AgentRequestEndpoint): boolean;
  resolveSource(request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal): Promise<AgentRequestParty | undefined>;
  resolveTarget(request: AgentThreadRequest): Promise<AgentRequestParty | undefined>;
  authorize(endpoint: AgentRequestEndpoint, role?: "source" | "target"): void;
  refresh?(endpoint: AgentRequestEndpoint, role?: "source" | "target"): Promise<void>;
  resolveExecutionOptions(request: AgentThreadRequest, target: AgentRequestParty): EndpointExecutionOptions;
  transport(delivery: PreparedEndpointDelivery, guard: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined>;
};

export type AgentDeviceEndpointBridge = {
  handlesThreadRequest?(request: AgentThreadRequest): boolean;
  handlesSource?(request: AgentThreadRequest, principal?: RabiLinkAgentPrincipal): boolean;
  handlesTarget?(request: AgentThreadRequest): boolean;
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
  peer?: PeerAgentEndpointBridge;
};
const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Manager owns business records; registry/catalog is discovery, never authorization. */
export function createAgentEndpointDelivery(context: AgentEndpointDeliveryContext) {
  const managerInstanceId = context.registry.localInstanceId;
  const receipts = new EndpointTransportReceipts(context.receiptDirectory);
  function remoteEndpoint(nodeId: string, agentId: string, sessionId: string, explicitProvider?: string, authorizationIncarnation?: string): AgentRequestEndpoint {
    return { kind: "instance", managerInstanceId, instanceId: nodeId, nodeId, agentId,
      provider: explicitProvider === "codex-desktop" ? "codex" : explicitProvider!, sessionId,
      authorizationIncarnation: authorizationIncarnation! };
  }
  function remoteTargetEndpoint(nodeId: string, agentId: string, sessionId: string, explicitProvider?: string): AgentRequestEndpoint {
    const policy = context.config.getLanAgentDeliveryPolicy();
    const lease = context.authority.getNodeAuthorization(nodeId);
    const provider = explicitProvider;
    if (!policy.enabled || !lease || !provider) {
      throw new Error("Original remote endpoint is disabled, revoked or unapproved.");
    }
    return { kind: "instance", managerInstanceId, instanceId: nodeId, nodeId, agentId,
      provider: provider === "codex-desktop" ? "codex" : provider, sessionId,
      authorizationIncarnation: digest([lease.incarnation, policy.incarnation]) };
  }
  function authorize(endpoint: AgentRequestEndpoint, role?: "source" | "target"): void {
    if (role === "source") return;
    if (endpoint.managerInstanceId !== managerInstanceId) throw new Error("Endpoint belongs to another Manager authority.");
    if (context.peer?.owns(endpoint)) { context.peer.authorize(endpoint); return; }
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
      if (endpoint.instanceId !== endpoint.nodeId || !sameAgentEndpoint(endpoint, remoteTargetEndpoint(endpoint.nodeId!, endpoint.agentId, endpoint.sessionId, endpoint.provider))) {
        throw new Error("Original endpoint incarnation was revoked or rebound.");
      }
    } else if (endpoint.agentId !== `local:${endpoint.provider}` || endpoint.authorizationIncarnation !== digest([managerInstanceId, endpoint.agentId, endpoint.provider, endpoint.sessionId])) {
      throw new Error("Invalid local endpoint authority.");
    }
  }
  async function refreshEndpoints(identities: Pick<PreparedEndpointDelivery, "source" | "target">, phase: "prepare" | "dispatch" | "reconcile" = "dispatch"): Promise<void> {
    const endpoint = identities.target;
    try {
      if (context.peer?.owns(endpoint)) {
        if (phase === "dispatch") await context.peer.refresh(endpoint);
        context.peer.authorize(endpoint);
        return;
      }
      if (phase !== "prepare" && endpoint.kind === "instance"
        && !context.registry.listNodes().some(node => node.nodeId === endpoint.nodeId && node.connected)) {
        throw new Error("The original computer is offline. Its prepared delivery will resume when it reconnects.");
      }
      if (context.service?.owns(endpoint)) await context.service.refresh?.(Object.freeze({ ...endpoint }), "target");
      if (endpoint.kind === "device") {
        if (!context.device) throw new Error("Device endpoint owner is unavailable.");
        await context.device.refresh?.(Object.freeze({ ...endpoint }), "target");
      }
      authorize(endpoint, "target");
    } catch (error) {
      throw error instanceof EndpointVerificationError ? error : new EndpointVerificationError("target", error);
    }
  }
  async function localTargetParty(provider: AgentAdapterType, sessionId: string, type: string, request: AgentThreadRequest): Promise<AgentRequestParty> {
    const summary = await context.readLocal(provider, sessionId, context.localOptions({ ...request, threadId: sessionId, agentAdapter: provider }));
    if (summary.id !== sessionId || summary.archived) throw new Error("Exact local task owner is unavailable.");
    assertEndpointOwnerDirectory(summary.cwd);
    const agentId = `local:${provider}`;
    return { agentAdapter: provider, agentType: type, threadId: sessionId, threadName: summary.title, workspace: summary.cwd,
      endpoint: { kind: "local", managerInstanceId, agentId, provider, sessionId,
        ...((request.instanceBinding?.ownerDeviceId || request.ledgerOwnerDeviceId) && context.peer ? { ownerDeviceId: context.peer.localDeviceId() } : {}),
        authorizationIncarnation: digest([managerInstanceId, agentId, provider, sessionId]) } };
  }
  function remoteTargetParty(nodeId: string, agentId: string, sessionId: string, type: string, provider?: string): AgentRequestParty {
    const endpoint = remoteTargetEndpoint(nodeId, agentId, sessionId, provider);
    const catalog = context.registry.getInstanceAgent(nodeId, agentId);
    if (catalog && (catalog.provider === "codex-desktop" ? "codex" : catalog.provider) !== endpoint.provider) throw new Error("Requested backend type does not match the explicit target.");
    return { endpoint, agentAdapter: endpoint.provider as AgentAdapterType, agentType: type, threadId: sessionId,
      threadName: catalog?.name || sessionId, workspace: catalog?.workspace };
  }
  async function connectorTargetParty(request: AgentThreadRequest, nodeId: string, agentId: string, sessionId: string,
    type: string, provider: string | undefined, assertCurrent: () => void): Promise<AgentRequestParty> {
    const party = remoteTargetParty(nodeId, agentId, sessionId, type, provider);
    // The reply sender describes this delivery's explicit workspace instead of the Agent profile default.
    party.workspace = request.cwd || party.workspace;
    if (!party.workspace && !request.cwd) {
      const result = await context.registry.manageAgent(nodeId, "threads", {
        agentId, agentAdapter: party.agentAdapter, action: "read", threadId: sessionId
      }, 30_000, assertCurrent) as { statusCode?: number; data?: { thread?: AgentThreadSummary } };
      assertCurrent();
      if (result.statusCode !== 200 || result.data?.thread?.id !== sessionId || result.data.thread.archived) throw new Error("Exact connector target owner is unavailable.");
      party.workspace = result.data.thread.cwd;
    }
    return party;
  }
  async function transport(delivery: PreparedEndpointDelivery, assertAuthorized: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined> {
    assertAuthorized();
    if (context.peer?.owns(delivery.target)) return context.peer.transport(delivery, assertAuthorized, reconcile);
    if (context.service?.owns(delivery.target)) return context.service.transport(delivery, assertAuthorized, reconcile);
    if (delivery.target.kind === "device") {
      if (!context.device) throw new Error("Device endpoint owner is unavailable.");
      return context.device.transport(delivery, assertAuthorized, reconcile);
    }
    if (delivery.target.kind === "instance") {
      let receipt: unknown;
      try {
        receipt = await context.registry.manageAgent(delivery.target.instanceId!, reconcile ? "reconcile_prepared_delivery" : "prepared_delivery",
          { agentId: delivery.target.agentId, agentAdapter: delivery.target.provider, delivery }, 30_000, assertAuthorized);
      } catch (error) {
        // Rebuild guidance from the admitted original target, never from remote paths or arbitrary error properties.
        if ((error as { code?: unknown })?.code === "AGENT_WORKSPACE_MISMATCH") throw agentWorkspaceMismatch(delivery.target);
        if (!reconcile && error && typeof error === "object"
          && (error as { code?: unknown }).code === "LAN_AGENT_MANAGEMENT_NOT_SENT"
          && (error as { deliveryFrameSent?: unknown }).deliveryFrameSent === false) throw new EndpointDeliveryNotSentError(error);
        throw error;
      }
      assertAuthorized();
      if (receipt && typeof receipt === "object" && (receipt as { status?: unknown }).status === "in_progress") return undefined;
      if (receipt && typeof receipt === "object" && (receipt as { status?: unknown }).status === "not_sent") {
        const proof = (receipt as { proof?: unknown }).proof;
        validateEndpointDeliveryNoFrameProof(delivery, proof);
        throw new EndpointDeliveryNotSentError("Authenticated endpoint owner proved that its original attempt wrote no prompt frame.", proof);
      }
      return receipt as EndpointDeliveryReceipt | undefined;
    }
    const options = context.localOptions({ threadId: delivery.target.sessionId, agentAdapter: delivery.target.provider as AgentAdapterType });
    return withAgentManagerInvocation(options, () => executePreparedEndpointDelivery(delivery, { endpoint: delivery.target, assertAuthorized,
      readReceipt: value => receipts.readReceipt(value), writeReceipt: (value, receipt) => receipts.writeReceipt(value, receipt),
      readNotSent: value => receipts.readNotSentProof(value), writeNotSent: (value, proof) => receipts.writeNotSent(value, proof),
      beginAttempt: value => receipts.beginAttempt(value), recoverReceipt: (value, guard) => withAgentManagerInvocation(options, () => recoverEndpointOwnerReceipt(value, guard)),
      send: (value, guard) => {
        // The original receipt/reconcile branches above stay readable after a
        // user disables new tasks. Check only at this target's new-send boundary.
        try { context.registry.assertComputerFeature(context.registry.localInstanceId, "agentTasks"); }
        catch (error) { throw new EndpointDeliveryNotSentError(error); }
        return executeEndpointOnOwner(value, options, guard);
      } }, reconcile));
  }
  function options(remoteSource?: AgentThreadRemoteSource, requestAuthority?: () => void, deviceSource?: RabiLinkAgentPrincipal,
    serviceSource?: AgentServiceSourcePrincipal, callerExecutionOptions?: EndpointDeliveryOptions["callerExecutionOptions"]): EndpointDeliveryOptions {
    if ((remoteSource || deviceSource || serviceSource) && !requestAuthority) throw new Error("Remote source requires original HTTP admission authority.");
    if ([remoteSource, deviceSource, serviceSource].filter(Boolean).length > 1) throw new Error("A request cannot assert two authenticated source owners.");
    const originalDeviceSource = deviceSource ? Object.freeze({ ...deviceSource }) : undefined;
    const originalServiceSource = serviceSource ? Object.freeze({ ...serviceSource }) : undefined;
    const originalCallerExecutionOptions = callerExecutionOptions === undefined ? undefined : Object.freeze({ ...callerExecutionOptions });
    requestAuthority?.();
    const originalRemoteSource = remoteSource ? Object.freeze({ ...remoteSource }) : undefined;
    const assertRequest = () => { requestAuthority?.(); };
    const withLedgerAddress = (source: AgentRequestParty, request: AgentThreadRequest): AgentRequestParty => {
      if (source.endpoint && context.peer && (request.instanceBinding?.ownerDeviceId || request.ledgerOwnerDeviceId || source.endpoint.ownerDeviceId)) {
        return { ...source, endpoint: { ...source.endpoint, ledgerOwnerDeviceId: context.peer.localDeviceId() } };
      }
      if (source.connection && context.peer && (request.instanceBinding?.ownerDeviceId || request.ledgerOwnerDeviceId)) {
        return { ...source, connection: { ...source.connection, ledgerOwnerDeviceId: context.peer.localDeviceId() } };
      }
      return source;
    };
    const deliveryOptions: EndpointDeliveryOptions = { store: context.store, managerInstanceId, callerExecutionOptions: originalCallerExecutionOptions,
      assertRequestCurrent: requestAuthority,
      authorize: (endpoint, role) => { assertRequest(); authorize(endpoint, role); },
      refreshEndpoints: async (identities, phase) => { assertRequest(); await refreshEndpoints(identities, phase); assertRequest(); },
      resolveExecutionOptions: (request, target) => {
        assertRequest();
        const exactRequest = { ...request, agentAdapter: target.agentAdapter, threadId: target.threadId };
        if (target.endpoint && context.service?.owns(target.endpoint)) return context.service.resolveExecutionOptions(exactRequest, target);
        const defaults = target.endpoint?.kind === "local" ? context.localOptions(exactRequest).codexDefaults : undefined;
        return resolveEndpointExecutionOptions(exactRequest, target.workspace, defaults);
      },
      resolveSource: async request => {
        assertRequest();
        const sourceAgentType = normalizeAgentThreadSourceType(request.sourceAgentType);
        const metadata = request.messageSource ? agentIdentityForMessageSource(request.messageSource) : undefined;
        const provider = parseAgentAdapterType(metadata?.agentAdapter);
        const sessionId = request.sourceThreadId || metadata?.sessionId;
        const connection = (transport: "lan-agent" | "rabilink" | "local" | "service", id: string, authorizationIncarnation?: string): AgentRequestParty => ({
          threadId: "", agentType: sourceAgentType, connection: { kind: "connection", managerInstanceId, transport, id,
            ...(authorizationIncarnation ? { authorizationIncarnation } : {}) }
        });
        if (originalRemoteSource) {
          const source = originalRemoteSource, sourceProvider = provider ?? source.provider, sourceSession = sessionId || source.sessionId;
          if (!sourceProvider || !sourceSession) return connection("lan-agent", source.nodeId, source.authorizationIncarnation);
          return { agentAdapter: sourceProvider, agentType: sourceAgentType, threadId: sourceSession,
            threadName: metadata?.sessionName || source.sessionName || sourceSession, workspace: metadata?.workspace ?? source.workspace,
            endpoint: remoteEndpoint(source.nodeId, source.agentId ?? sourceProvider, sourceSession, sourceProvider, source.authorizationIncarnation) };
        }
        if (originalDeviceSource && (!provider || !sessionId)) return connection("rabilink", originalDeviceSource.sourceDeviceId);
        if (originalServiceSource && !sessionId) return connection("service", originalServiceSource.agentId, originalServiceSource.authorizationIncarnation);
        if (!originalDeviceSource && !originalServiceSource && (!provider || !sessionId)) return connection("local", managerInstanceId);
        const peerSource = await context.peer?.resolveSource(request, originalDeviceSource);
        assertRequest();
        if (peerSource) return peerSource;
        const device = await context.device?.resolveSource(request, originalDeviceSource);
        assertRequest();
        if (device) return device;
        const service = await context.service?.resolveSource(request, originalServiceSource);
        assertRequest();
        if (service) return service;
        if (!provider || !sessionId) return connection("local", managerInstanceId);
        const agentId = "local:" + provider;
        return { agentAdapter: provider, agentType: sourceAgentType, threadId: sessionId,
          threadName: metadata?.sessionName || sessionId, workspace: metadata?.workspace,
          endpoint: { kind: "local", managerInstanceId, agentId, provider, sessionId,
            ...((request.instanceBinding?.ownerDeviceId || request.ledgerOwnerDeviceId) && context.peer ? { ownerDeviceId: context.peer.localDeviceId() } : {}),
            authorizationIncarnation: digest([managerInstanceId, agentId, provider, sessionId]) } };
      },
      resolveTarget: async request => {
        assertRequest();
        const originalSource = request.inReplyToRequestId ? context.store.get(request.inReplyToRequestId)?.source : undefined;
        if (originalSource?.endpoint) {
          const endpoint = originalSource.endpoint;
          const exactTarget = { ...request, threadId: originalSource.threadId, agentAdapter: originalSource.agentAdapter,
            ...(endpoint.kind === "device" || endpoint.kind === "instance" ? {
              instanceBinding: { instanceId: endpoint.instanceId!, agentId: endpoint.agentId,
                ...(endpoint.ownerDeviceId ? { ownerDeviceId: endpoint.ownerDeviceId } : {}) }
            } : { instanceBinding: undefined, agentTargetId: `local:${endpoint.provider}` }) };
          if (context.peer?.owns(endpoint)) {
            const target = await context.peer.resolveStoredTarget(originalSource);
            assertRequest();
            return target;
          }
          if (context.service?.owns(endpoint)) {
            const target = await context.service.resolveTarget(exactTarget);
            assertRequest();
            if (target) return target;
          }
          if (endpoint.kind === "device" && context.device) {
            const target = await context.device.resolveTarget(exactTarget);
            assertRequest();
            if (target) return target;
          }
          if (endpoint.kind === "instance") return connectorTargetParty(exactTarget, endpoint.instanceId!, endpoint.agentId,
            endpoint.sessionId, originalSource.agentType, endpoint.provider, assertRequest);
          if (endpoint.kind === "local" && !originalSource.workspace && !request.cwd) {
            const target = await localTargetParty(endpoint.provider as AgentAdapterType, endpoint.sessionId, originalSource.agentType, exactTarget);
            assertRequest();
            return { ...target, endpoint };
          }
          return originalSource;
        }
        const id = completeAgentSessionId(request.threadId, "threadId");
        const peerTarget = await context.peer?.resolveTarget(request);
        assertRequest();
        if (peerTarget) return peerTarget;
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
          return connectorTargetParty(request, binding.instanceId, binding.agentId, id,
            request.messageProcessing?.targetAgentType || "agent", request.agentAdapter, assertRequest);
        }
        const provider = request.agentAdapter;
        if (!provider) throw new Error("Explicit target provider is required for endpoint delivery.");
        if (binding && binding.agentId !== `local:${provider}`) throw new Error("Local binding provider mismatch.");
        if (request.agentTargetId && request.agentTargetId !== `local:${provider}`) throw new Error("Explicit local provider mismatch.");
        const party = await localTargetParty(provider, id, request.messageProcessing?.targetAgentType || "agent",
          originalDeviceSource?.deviceOwner && context.peer ? { ...request, ledgerOwnerDeviceId: context.peer.localDeviceId() } : request);
        assertRequest();
        return party;
      },
      dispatch: async (delivery, guard) => {
        const receipt = await transport(delivery, guard, false);
        if (!receipt) throw new Error("No exact owner receipt; original attempt must not be replayed.");
        return receipt;
      }, reconcile: (delivery, guard) => transport(delivery, guard, true) };
    const resolveSource = deliveryOptions.resolveSource;
    deliveryOptions.resolveSource = async request => withLedgerAddress(await resolveSource(request), request);
    return deliveryOptions;
  }
  const recovery = new EndpointDeliveryRecovery(options());
  return { options, authorize, refreshEndpoints, recovery, remoteEndpoint,
    reconcileRecord: (deliveryId: string, assertCurrent: () => void) =>
      reconcileEndpointDelivery(deliveryId, options(undefined, assertCurrent), { receiptOnly: true }) };
}
