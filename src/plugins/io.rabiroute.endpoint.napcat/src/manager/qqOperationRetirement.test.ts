import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { createAgentGroupFilesOperation, type AgentGroupFilesContext } from "./agentGroupFiles.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import type { GatewayDefinition } from "../../../../shared/gatewayConfigModel.js";
import { remoteAgentTargetKey } from "../../../../shared/routeAgentTargets.js";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function request(method: string) { return { method, headers: {} } as http.IncomingMessage; }
function response() { return new EventEmitter() as http.ServerResponse; }
function createGroupFileRoutes(context: AgentGroupFilesContext) {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("endpoint:napcat", [createAgentGroupFilesOperation(context)]);
  return { handler(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
    res.writeHead = ((status: number) => { (res as any).statusCode = status; return res; }) as http.ServerResponse["writeHead"];
    res.end = ((body: string) => { context.jsonResponse(res, res.statusCode, JSON.parse(body)); res.emit("finish"); return res; }) as http.ServerResponse["end"];
    return registry.handle(req, url, res);
  }, stopAcceptingAndDrain: () => registration.dispose() };
}
test("NapCat group-file dispatch denies untrusted sources before upstream access", async () => {
  let probes = 0;
  const received = deferred<{ status: number; body: unknown }>();
  const routes = createGroupFileRoutes({
      route: () => { throw new Error("untrusted lookup"); },
      readFiles: async () => { probes++; throw new Error("untrusted probe"); },
      jsonResponse: (_response, status, body) => received.resolve({ status, body })
  });
  const res = response();
  res.setHeader = () => res;
  assert.equal(routes.handler(request("GET"), new URL("http://localhost/api/agent/qq/group-files?routeId=one&groupId=123"), res), true);
  assert.deepEqual(await received.promise, { status: 403, body: { code: -1, errorCode: "QQ_GROUP_FILES_TRUSTED_SOURCE_REQUIRED" } });
  assert.equal(probes, 0);
  res.emit("finish");
  await routes.stopAcceptingAndDrain();
});

test("NapCat operation retirement waits for in-flight authorized group-file read", async () => {
  const page = deferred<{ files: []; folders: []; completenessUnknown: true; potentiallyTruncated: true; projectionTruncated: false }>();
  const started = deferred<void>();
  const responses: number[] = [];
  const sessionId = "session-11111111-1111-1111-1111-111111111111";
  const key = remoteAgentTargetKey({ instanceId: "node-one", agentId: "agent-one" });
  const definition = {
    id: "route-one", enabled: true, gatewayPort: 8789, messageAdapters: ["napcat"],
    agentAdapters: ["dsh"], primaryAgentAdapter: "dsh", dshSessionId: sessionId,
    remoteAgentTargets: [{ id: key, instanceId: "node-one", agentId: "agent-one", provider: "dsh" }],
    primaryAgentTarget: key,
    messageAdapterPolicies: { napcat: { readableGroupFileIds: ["123"] } },
    napcatInstances: [{ id: "qq-one", gatewayPort: 8789, enabled: true, httpUrl: "http://127.0.0.1:3000" }]
  } as GatewayDefinition;
  const routes = createGroupFileRoutes({
      route: id => id === definition.id ? definition : undefined,
      readFiles: async () => { started.resolve(); return page.promise; },
      jsonResponse: (_response, status) => { responses.push(status); }
  });
  const req = request("GET");
  req.headers = { host: "localhost" };
  req.socket = { remoteAddress: "127.0.0.1" } as http.IncomingMessage["socket"];
  const res = response();
  res.setHeader = () => res;
  assert.equal(routes.handler(req, new URL("http://localhost/api/agent/qq/group-files?routeId=route-one&groupId=123"), res), true);
  await started.promise;
  res.emit("close");
  let drained = false;
  const stopping = routes.stopAcceptingAndDrain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  page.resolve({ files: [], folders: [], completenessUnknown: true, potentiallyTruncated: true, projectionTruncated: false });
  await stopping;
  assert.equal(drained, true);
  assert.deepEqual(responses, [], "A closed HTTP response stays closed while its accepted operation still drains.");
});
