import type http from "node:http";
import { LanAgentNodeNameConflictError, type LanAgentRegistry } from "./lanAgentRegistry.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import type { InstanceAgent } from "../shared/agentInstance.js";
import type { LanAgentAuthority } from "./lanAgentAuthority.js";
import type { AgentResourceCatalog } from "./agentResourceCatalog.js";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "./apiOperationContract.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentReleaseSelectionConflictError } from "./lanAgentReleaseStore.js";
import { LAN_AGENT_MANAGEMENT_ROUTES, lanAgentManagementContract, type ManagementRoute } from "./lanAgentManagementContract.js";

export type LanAgentRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  isReleaseRequestAuthorized: (request: http.IncomingMessage) => boolean;
  isManagementRequestAuthorized: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  registry: LanAgentRegistry;
  authority?: LanAgentAuthority;
  resources?: AgentResourceCatalog;
  enabled?: () => boolean;
  managerIdentity?: () => { guid?: string; applicationGenerationId: string; managerInstanceId: string; health: unknown };
  releases: LanAgentReleaseStore;
  localAgents?: () => InstanceAgent[];
  manageLocalAgent?: (agentId: string, operation: string, body: Record<string, unknown>, assertAuthorized?: () => void) => Promise<unknown>;
};


export function createLanAgentManagementOperations(context: LanAgentRoutesContext): readonly ApiOperationDefinition[] {
  return LAN_AGENT_MANAGEMENT_ROUTES.map(route => ({ contract: lanAgentManagementContract(route), handler: input => run(context, route, input) }));
}

async function run(context: LanAgentRoutesContext, route: ManagementRoute, input: ApiOperationInput): Promise<ApiOperationResult> {
  const headers = { "cache-control": "no-store" };
  const output = (status: number, body: unknown): ApiOperationResult => ({ status, headers, body });
  const unauthorized = (management = false): ApiOperationResult => ({ ...output(401, { code: -1,
    error: management ? "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED" : "LAN_AGENT_TOKEN_REQUIRED",
    message: "A verified connection identity is required." }), headers: { ...headers, "www-authenticate": 'Bearer realm="RabiRoute LAN Agent"' } });
  const principal = assertTrustedLanAgentPrincipal(input.request);
  const exchange = route.key === "enroll.exchange";
  const allowed = () => exchange ? context.enabled?.() === true
    : hasAuthenticatedConnectionRequest(input.request) || context.isManagementRequestAuthorized(input.request, input.url);
  if (!allowed()) return unauthorized(!exchange && route.key !== "self.read");
  const guard = () => {
    if (assertTrustedLanAgentPrincipal(input.request) !== principal || !allowed()) throw new Error("Connection identity changed; node request stopped.");
  };
  let mutated = false, releaseSelectionCommitted = false, taskId: string | undefined;
  const body = (input.body ?? {}) as Record<string, unknown>;
  try {
    guard();
    switch (route.key) {
      case "self.read": {
        const token = typeof input.request.headers.authorization === "string" ? input.request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "" : "";
        const identity = context.enabled?.() === true ? context.authority?.authenticate(token) : null;
        if (!identity) return unauthorized();
        const instance = context.registry.listInstances().find(row => row.instanceId === identity.nodeId);
        guard(); return output(200, { code: 0, data: { ...context.managerIdentity?.(), nodeId: identity.nodeId, connected: instance?.connected ?? false, agents: instance?.agents ?? [] } });
      }
      case "enrollments.create": {
        if (!context.authority) return output(404, { code: -1, message: "Node enrollment owner is unavailable." });
        // The original issuance endpoint ignores its body, including non-JSON input.
        input.request.resume(); guard(); mutated = true;
        const data = context.authority.issueBootstrapTicket();
        guard(); return output(201, { code: 0, data });
      }
      case "enroll.exchange": {
        if (!context.authority) return output(404, { code: -1, message: "Node enrollment owner is unavailable." });
        guard(); mutated = true;
        const data = context.authority.enroll(String(body.ticket ?? ""), String(body.nodeId ?? ""), body.enrollmentSecret as string | undefined);
        guard(); return output(201, { code: 0, data });
      }
      case "instances.list": {
        const instances = context.registry.listInstances(context.localAgents?.()).map(instance => ({ ...instance, enabled: instance.local || (context.authority?.isNodeEnabled(instance.instanceId) ?? true) }));
        guard(); return output(200, { code: 0, instances, credentialDiagnostics: context.authority?.getSnapshot().diagnostics ?? [] });
      }
      case "instances.enabled": {
        if (!context.authority) return output(404, { code: -1, message: "Node enrollment owner is unavailable." });
        const nodeId = input.path.instanceId!;
        guard(); mutated = true; context.authority.setNodeEnabled(nodeId, body.enabled as boolean, body.expectedEnabled as boolean);
        // Disabling the caller's own node is an accepted mutation; its revoked lease prevents disclosure.
        guard(); return output(200, { code: 0, data: { nodeId, enabled: context.authority.isNodeEnabled(nodeId) } });
      }
      case "instances.name": {
        guard(); mutated = true;
        const result = context.registry.setNodeName(input.path.instanceId!, body.name, body.expectedName as string);
        guard(); return output(200, { code: 0, result });
      }
      case "nodes.list": {
        const release = context.releases.manifest();
        const currentNodes = context.registry.listNodes();
        const digests = context.releases.nodeReleaseDigests(currentNodes.map(node => node.nodeId), release);
        const nodes = currentNodes.map(node => ({ ...node, releaseDigest: digests.get(node.nodeId)! }));
        const result = { code: 0, nodes, tasks: context.registry.listTasks(100), releaseVersion: release.version, releasePublicKeySha256: release.publicKeySha256,
          credentialDiagnostics: context.authority?.getSnapshot().diagnostics ?? [] };
        guard(); return output(200, result);
      }
      case "nodes.update": {
        const nodeId = input.path.nodeId!;
        let version = typeof body.version === "string" && body.version.trim() ? body.version.trim() : undefined;
        if (Object.hasOwn(body, "releaseDigest")) {
          if (!context.registry.listNodes().some(node => node.nodeId === nodeId && node.connected)) throw new Error("Rabi Agent node is not connected.");
          const selection = body.releaseDigest;
          if (selection !== null && typeof selection !== "string" || typeof body.expectedReleaseDigest !== "string") throw new Error("releaseDigest and expectedReleaseDigest are required for node release selection.");
          // Validate an explicit version before committing a new selection.
          if (version) throw new Error("Use releaseDigest without version when selecting a node release.");
          guard();
          const publication = context.releases.assignRelease(nodeId, selection, body.expectedReleaseDigest);
          releaseSelectionCommitted = true;
          version = publication.version;
        }
        version ??= context.releases.manifest(nodeId).version;
        guard(); mutated = true;
        const result = context.registry.requestUpdate(nodeId, version, guard);
        guard(); return output(202, { code: 0, result });
      }
      case "nodes.tasks": {
        guard(); mutated = true;
        const task = context.registry.assignTask({ nodeId: input.path.nodeId!, targetAgent: typeof body.targetAgent === "string" ? body.targetAgent : "",
          agentId: typeof body.agentId === "string" ? body.agentId : undefined, threadId: typeof body.threadId === "string" ? body.threadId : "",
          message: String(body.message ?? ""), cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          taskId: typeof body.taskId === "string" ? body.taskId : undefined, idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined }, guard);
        taskId = task.taskId;
        const result = await context.registry.waitForTaskAcceptance(taskId); guard(); return output(202, { code: 0, result });
      }
      default: {
        const instanceId = input.path.instanceId!, agentId = route.key === "agents.create" ? undefined : input.path.agentId;
        const operation = route.key === "agents.create" ? "configure" : route.key.slice("agents.".length);
        guard(); let result: unknown;
        if (instanceId === context.registry.localInstanceId) {
          if (!agentId || !context.manageLocalAgent) throw new Error("Local Agent management is unavailable.");
          mutated = true; result = await context.manageLocalAgent(agentId, operation, body, guard);
        } else if (operation === "tasks") {
          const provider = typeof body.provider === "string" ? body.provider : "";
          if (!provider) throw new Error("Explicit provider is required.");
          mutated = true;
          const task = context.registry.assignTask({ nodeId: instanceId, targetAgent: provider, threadId: typeof body.threadId === "string" ? body.threadId : "",
            cwd: typeof body.cwd === "string" ? body.cwd : undefined, message: String(body.message || ""),
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined }, guard);
          taskId = task.taskId; result = await context.registry.waitForTaskAcceptance(taskId);
        } else {
          mutated = operation !== "scan";
          result = await context.registry.manageAgent(instanceId, operation, { ...body, agentId }, operation === "hooks" ? 90_000 : 30_000, guard);
        }
        guard(); return output(200, { code: 0, result });
      }
    }
  } catch (error) {
    try { guard(); }
    catch { return output(403, { code: -1, message: "Connection identity changed; node request stopped.", ...(mutated || releaseSelectionCommitted ? { uncertain: true } : {}), ...(taskId ? { taskId } : {}) }); }
    if (exchange) return output(400, { code: -1, message: "Enrollment could not be completed. Keep the local recovery record; if the ticket expired, copy a fresh connection prompt. No separate Agent approval is required." });
    const message = error instanceof Error ? error.message : String(error);
    return output(error instanceof LanAgentNodeNameConflictError || error instanceof LanAgentReleaseSelectionConflictError || route.key === "instances.enabled" && /conflict/.test(message) ? 409 : 400,
      { code: -1, message, ...(releaseSelectionCommitted ? { uncertain: true } : {}), ...(taskId ? { uncertain: true, taskId } : {}) });
  }
}
