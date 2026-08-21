import type http from "node:http";
import type {
  RemoteAgentConnectRequest,
  RemoteAgentDeviceStatus,
  RemoteAgentTask,
  RemoteAgentTaskEvent,
  RemoteAgentTaskRequest
} from "../messageEndpoints/remoteAgentManager.js";

export type RemoteAgentRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  listDevices: () => RemoteAgentDeviceStatus[];
  listTasks: (limit?: number) => RemoteAgentTask[];
  scanLan: () => Promise<RemoteAgentDeviceStatus[]>;
  connectDevice: (request: RemoteAgentConnectRequest) => Promise<RemoteAgentDeviceStatus>;
  disconnectDevice: (deviceId: string) => RemoteAgentDeviceStatus;
  createTask: (request: RemoteAgentTaskRequest) => Promise<RemoteAgentTask>;
  receiveTaskEvent: (event: RemoteAgentTaskEvent) => RemoteAgentTask;
  applyTaskDefaults: (request: RemoteAgentTaskRequest) => RemoteAgentTaskRequest;
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function handleRemoteAgentApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: RemoteAgentRoutesContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/devices") {
    context.jsonResponse(response, 200, {
      code: 0,
      devices: context.listDevices(),
      tasks: context.listTasks(20)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/scan") {
    void context.trackOperation(context.scanLan()
      .then(devices => context.jsonResponse(response, 200, {
        code: 0,
        devices,
        tasks: context.listTasks(20)
      }))
      .catch(error => context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) })));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/connect") {
    void context.trackOperation(context.readJsonBody<RemoteAgentConnectRequest>(request)
      .then(body => context.connectDevice(body))
      .then(device => context.jsonResponse(response, 200, {
        code: 0,
        device,
        devices: context.listDevices()
      }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/disconnect") {
    void context.trackOperation(context.readJsonBody<{ deviceId?: string }>(request)
      .then(body => context.disconnectDevice(String(body.deviceId || "")))
      .then(device => context.jsonResponse(response, 200, {
        code: 0,
        device,
        devices: context.listDevices()
      }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/tasks") {
    context.jsonResponse(response, 200, { code: 0, tasks: context.listTasks(100) });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/tasks") {
    void context.trackOperation(context.readJsonBody<RemoteAgentTaskRequest>(request)
      .then(body => context.createTask(context.applyTaskDefaults(body)))
      .then(task => context.jsonResponse(response, 202, { code: 0, task }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/task-events") {
    void context.trackOperation(context.readJsonBody<RemoteAgentTaskEvent>(request)
      .then(event => context.receiveTaskEvent(event))
      .then(task => context.jsonResponse(response, 202, { code: 0, task }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) })));
    return true;
  }

  return false;
}
