import { recoverDisabledAgentTask } from "@rabiroute/host-api/manager/lanAgentRegistry";
import type http from "node:http";
import { instanceAgentActionDefinition, BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, type ComputerSettingsDefinition } from "@rabiroute/host-api/shared/agentInteractiveProtocol";
import { LanAgentNodeNameConflictError, type LanAgentRegistry } from "@rabiroute/host-api/manager/lanAgentRegistry";
import type { LanAgentReleaseStore } from "@rabiroute/host-api/manager/lanAgentReleaseStore";
import type { InstanceAgent } from "@rabiroute/host-api/shared/agentInstance";
import type { LanAgentAuthority } from "@rabiroute/host-api/manager/lanAgentAuthority";
import type { AgentResourceCatalog } from "./agentResourceCatalog.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { LanAgentReleaseSelectionConflictError } from "@rabiroute/host-api/manager/lanAgentReleaseStore";
import { LAN_AGENT_MANAGEMENT_ROUTES, lanAgentManagementContract, lanAgentManagementTransportFailure, type ManagementRoute } from "@rabiroute/host-api/manager/lanAgentManagementContract";

export type LanAgentRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  isReleaseRequestAuthorized: (request: http.IncomingMessage) => boolean;
  isManagementRequestAuthorized: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  registry: LanAgentRegistry;
  computerSettingsDefinition?:ComputerSettingsDefinition;
  authority?: LanAgentAuthority;
  resources?: AgentResourceCatalog;
  enabled?: () => boolean;
  managerIdentity?: () => { guid?: string; applicationGenerationId: string; managerInstanceId: string; health: unknown };
  releases: LanAgentReleaseStore;
  localAgents?: () => InstanceAgent[];
  manageLocalAgent?: (agentId: string, operation: string, body: Record<string, unknown>, assertAuthorized?: () => void) => Promise<unknown>;
};


function computerSettingsContract(context:LanAgentRoutesContext,route:ManagementRoute):ApiOperationContract {
  const base=lanAgentManagementContract(route);
  if(!route.key.startsWith("computer-settings."))return base;
  const definition=context.computerSettingsDefinition??context.registry.getComputerSettingsDefinition?.()??BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION;
  const dataSchema = {
    type:"object",additionalProperties:true,
    required:["settings","defaults","schema","revision","definitionDigest","diagnostics","capabilities"],
    properties:{
      settings:{description:"Effective values. Diagnostics identify invalid explicit fields; this view does not replace them with defaults."},
      rawSettings:{description:"Original persisted overrides; omitted when no overrides exist."},
      defaults:{},schema:{type:"object",additionalProperties:true},
      revision:{type:"string"},definitionDigest:{type:"string"},
      diagnostics:{type:"array",items:{type:"object",required:["field","message"],properties:{field:{type:"string"},message:{type:"string"}}}},
      capabilities:{type:"array",items:{type:"string"}}
    }
  };
  const request = route.key.endsWith("patch") ? {
    ...base.request,
    headers:{type:"object",additionalProperties:true,properties:{"if-match":{type:"string",description:"Copy the complete ETag returned by GET computer-settings for this target."}},required:["if-match"]},
    body:{kind:"json" as const,allowAnyContentType:true,maxBytes:Number.MAX_SAFE_INTEGER,schema:definition.validationSchema}
  } : base.request;
  return {
    ...base,request,
    responses:{...base.responses,"200":{mediaType:"application/json",schema:{
      type:"object",required:["code","data"],properties:{code:{const:0},data:dataSchema}
    }}}
  };
}
type ComputerSettingsResetRoute = Readonly<{key:"computer-settings.reset";method:"POST";pathTemplate:string}>;

export function createLanAgentManagementOperations(context: LanAgentRoutesContext): readonly ApiOperationDefinition[] {
  const operations:ApiOperationDefinition[] = LAN_AGENT_MANAGEMENT_ROUTES.map(route => ({ contract: computerSettingsContract(context,route),
    ...(route.key === "computers.list" || route.key.startsWith("computer-settings.") ? { discovery: {
      title: route.key === "computers.list" ? "电脑列表" : route.key.endsWith("patch") ? "修改电脑控制设置" : "读取电脑控制设置",
      summary: "本机、远端节点和完整主机的电脑功能、真实能力与可见设置。列表非空ownerDeviceId表示所属远端Manager；按目标声明经原Peer manager服务转接同一路径与正文，不把远端instanceId投到本机。",
      relatedOperations:["manager.rabilink.peer.http.get","manager.rabilink.peer.http.post","manager.rabilink.peer.http.patch"],
      category: {id:"devices",title:"设备与电脑"}, keywords:["电脑","电脑控制","computer","computer control","settings"],
      ...(route.key !== "computers.list" ? { inputSources:[{field:"path.instanceId",operationId:"manager.lan-agent.instances.list",resultPath:"instances",valuePath:"instanceId"}] } : {})
    } } : {}), handler: input => run(context, route, input) }));
  const readRoute=LAN_AGENT_MANAGEMENT_ROUTES.find(route=>route.key==="computer-settings.read")!;
  const resetRoute:ComputerSettingsResetRoute={key:"computer-settings.reset",method:"POST",pathTemplate:readRoute.pathTemplate+"/reset"};
  const readContract=computerSettingsContract(context,readRoute);
  operations.push({contract:{...readContract,operationId:"manager.lan-agent.computer-settings.reset",method:"POST",pathTemplate:resetRoute.pathTemplate,
    description:"Explicitly restore selected schema-defined settings to their current plugin defaults. Other raw overrides remain unchanged.",
    request:{...readContract.request,headers:{type:"object",additionalProperties:true,required:["if-match"],properties:{"if-match":{type:"string",description:"Use the exact ETag from GET computer-settings for this instance."}}},body:{kind:"json",maxBytes:Number.MAX_SAFE_INTEGER,schema:{type:"object",additionalProperties:false,required:["paths"],properties:{paths:{type:"array",items:{type:"string",minLength:1},minItems:1}}}}},
    effects:{mode:"existing-owner-mutation",description:"One original settings-owner CAS deletes only the explicitly selected override paths. No task/input is replayed."}},
    discovery:{title:"恢复电脑设置默认值",summary:"先读同目标computer-settings的schema；paths使用属性的点分路径。仅移除明确选中的覆盖值，保留其他原值及自定义扩展。",category:{id:"devices",title:"设备与电脑"},keywords:["恢复默认","电脑设置","restore defaults","computer settings"],
      inputSources:[{field:"path.instanceId",operationId:"manager.lan-agent.instances.list",resultPath:"instances",valuePath:"instanceId"}]},
    handler:input=>run(context,resetRoute,input)});
  return operations;
}

async function run(context: LanAgentRoutesContext, route: ManagementRoute | ComputerSettingsResetRoute, input: ApiOperationInput): Promise<ApiOperationResult> {
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
        const instances = context.registry.listInstances(context.localAgents?.());
        guard(); return output(200, { code: 0, instances, credentialDiagnostics: context.authority?.getSnapshot().diagnostics ?? [] });
      }
      case "computers.list": {
        const data = await context.registry.listComputers(); guard(); return output(200, {code:0,data});
      }
      case "computer-settings.read":
      case "computer-settings.reset":
      case "computer-settings.patch": {
        const instanceId = input.path.instanceId!;
        const data = route.key === "computer-settings.reset"
          ? await context.registry.updateComputerSettings(instanceId,{},String(input.request.headers["if-match"]??""),body.paths as string[])
          : route.key === "computer-settings.patch"
            ? await context.registry.updateComputerSettings(instanceId, body, String(input.request.headers["if-match"] ?? ""))
            : context.registry.getComputerSettings(instanceId, true);
        guard(); return { status: 200, headers: { ...headers, etag: data.revision }, body: { code:0, data:{...data, capabilities:context.registry.computerCapabilities(instanceId)} } };
      }
      case "instances.enabled": {
        const nodeId = input.path.instanceId!;
        guard(); mutated = true;
        const applied = await context.registry.setComputerEnabled(nodeId, body.enabled as boolean, body.expectedEnabled as boolean);
        guard(); return output(200, { code: 0, data: { nodeId, enabled: (applied.settings as Record<string,unknown>).enabled, execution:applied.execution, ...(applied.executionIssue ? {executionIssue:applied.executionIssue} : {}) } });
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
          const taskDefinition = instanceAgentActionDefinition(operation,body);
          if (taskDefinition?.newWork) {
            try { context.registry.assertComputerFeature(instanceId,"agentTasks"); }
            catch (error) {
              const recovered = await recoverDisabledAgentTask(taskDefinition, body, error, original => context.manageLocalAgent!(agentId, operation, original, guard));
              guard(); return output(200,{code:0,result:recovered});
            }
          }
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
    const readOnly = route.method === "GET" || route.key === "agents.scan" || instanceAgentActionDefinition(route.key.slice("agents.".length),body)?.readOnly === true;
    const transport = lanAgentManagementTransportFailure(error, "manager.lan-agent."+route.key, readOnly);
    if (transport) return transport;
    if ((error as {code?:string})?.code === "COMPUTER_FEATURE_DISABLED") return output(403,{code:-1,errorCode:"COMPUTER_FEATURE_DISABLED",field:(error as {field?:string}).field ?? "features.agentTasks",message:(error as Error).message,repair:"Open RabiLink → 电脑控制 and update the target computer settings.",retryable:false});
    const message = error instanceof Error ? error.message : String(error);
    return output((error as {code?:string})?.code === "COMPUTER_SETTINGS_CONFLICT" || error instanceof LanAgentNodeNameConflictError || error instanceof LanAgentReleaseSelectionConflictError || route.key === "instances.enabled" && /conflict/.test(message) ? 409 : 400,
      { code: -1, message, ...(releaseSelectionCommitted ? { uncertain: true } : {}), ...(taskId ? { uncertain: true, taskId } : {}) });
  }
}
