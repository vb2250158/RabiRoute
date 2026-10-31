import type { RemoteAgentConnectRequest, RemoteAgentDeviceStatus, RemoteAgentTask, RemoteAgentTaskEvent, RemoteAgentTaskRequest } from "../messageEndpoints/remoteAgentManager.js";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "./apiOperationContract.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { REMOTE_AGENT_ROUTES, remoteAgentContract, type RemoteAgentRoute } from "./remoteAgentContract.js";

export type RemoteAgentOperationsContext = {
  listDevices(): RemoteAgentDeviceStatus[];
  listTasks(limit?: number): RemoteAgentTask[];
  scanLan(assertAuthorized: () => void): Promise<RemoteAgentDeviceStatus[]>;
  connectDevice(request: RemoteAgentConnectRequest, assertAuthorized: () => void): Promise<RemoteAgentDeviceStatus>;
  disconnectDevice(deviceId: string, assertAuthorized: () => void): RemoteAgentDeviceStatus;
  createTask(request: RemoteAgentTaskRequest, assertAuthorized: () => void): Promise<RemoteAgentTask>;
  receiveTaskEvent(event: RemoteAgentTaskEvent, assertAuthorized: () => void): RemoteAgentTask;
  applyTaskDefaults(request: RemoteAgentTaskRequest): RemoteAgentTaskRequest;
};

export function createRemoteAgentOperations(context: RemoteAgentOperationsContext): readonly ApiOperationDefinition[] {
  return REMOTE_AGENT_ROUTES.map(route => ({ contract: remoteAgentContract(route), handler: input => run(context, route, input) }));
}
async function run(context: RemoteAgentOperationsContext, route: RemoteAgentRoute, input: ApiOperationInput): Promise<ApiOperationResult> {
  const principal = assertTrustedLanAgentPrincipal(input.request);
  const guard = () => {
    if (assertTrustedLanAgentPrincipal(input.request) !== principal) throw new Error("Original Remote Agent request admission changed.");
    // Global ingress already admitted the existing local/browser/RabiLink/node identity.
    // A false marker is not a new permission requirement for its existing local path.
    hasAuthenticatedConnectionRequest(input.request);
  };
  const result = (status: number, body: unknown): ApiOperationResult => ({ status, headers: { "cache-control": "no-store" },
    // Preserve the previous JSON wire representation, including native NaN -> null.
    body: JSON.parse(JSON.stringify(body)) });
  try {
    guard(); let body: unknown, status = 200;
    switch (route.key) {
      case "devices.list": body = { code: 0, devices: context.listDevices(), tasks: context.listTasks(20) }; break;
      case "scan": input.request.resume(); body = { code: 0, devices: await context.scanLan(guard), tasks: context.listTasks(20) }; break;
      case "connect": body = { code: 0, device: await context.connectDevice(input.body as RemoteAgentConnectRequest, guard), devices: context.listDevices() }; break;
      case "disconnect": body = { code: 0, device: context.disconnectDevice(String((input.body as { deviceId?: unknown }).deviceId || ""), guard), devices: context.listDevices() }; break;
      case "tasks.list": body = { code: 0, tasks: context.listTasks(100) }; break;
      case "tasks.create": status = 202; body = { code: 0, task: await context.createTask(context.applyTaskDefaults(input.body as RemoteAgentTaskRequest), guard) }; break;
      case "task-events.receive": status = 202; body = { code: 0, task: context.receiveTaskEvent(input.body as RemoteAgentTaskEvent, guard) }; break;
    }
    guard(); return result(status, body);
  } catch (error) {
    try { guard(); } catch { return result(403, { code: -1, message: "Original Remote Agent request admission changed.", ...(route.method === "POST" ? { uncertain: true } : {}) }); }
    return result(route.key === "scan" ? 500 : 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
  }
}
