import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { EventEmitter } from "node:events";
import { handleXiaomiHomeManagerApi, type XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";
import type { XiaomiHomeAuthMutationReceipts } from "./authMutationReceipts.js";
import { XiaomiHomeManagerApiError, type XiaomiHomeActionRequest } from "./managerApi.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";

const lifecycleFence = {
  applicationGenerationId: "application-generation-current",
  managerInstanceId: "manager-instance-current"
};
test("shared remote dispatch rejects stale fences before reading bodies and keeps receipt queries read-only",async()=>{
 const responses:Array<{status:number;body:any}>=[],calls:unknown[]=[],ctx=context(()=>undefined,()=>undefined,responses);
 ctx.runtime={vacuumRemote:{capabilities:async(id:string)=>{calls.push(id);return {available:true};},status:(id:string)=>{calls.push(id);return {state:"ready"};},receipt:(key:string)=>{calls.push(key);return {state:"completed"};},command:async(...args:unknown[])=>{calls.push(args);return {state:"completed"};}}} as unknown as XiaomiHomeRuntimeController;
 ctx.readJsonBody=async()=>{calls.push("body");return {sessionId:"example"} as never;};const response={setHeader:()=>undefined} as unknown as http.ServerResponse;
 const fence={"x-rabiroute-expected-application-generation-id":lifecycleFence.applicationGenerationId,"x-rabiroute-expected-manager-instance-id":lifecycleFence.managerInstanceId,"idempotency-key":"remote-route-stable-key"};
 for(const [suffix,method,headers] of [["/capabilities?resourceId=vacuum","GET",{}],["/start","POST",{}],["/start","POST",fence],["/status?sessionId=session","GET",{}],["/status?sessionId=x&idempotencyKey=y","GET",{}],["/pulse?direction=left","POST",fence],["/status?idempotencyKey=key","GET",{}]] as Array<[string,string,Record<string,string>]>) {handleXiaomiHomeManagerApi(request(headers,method),new URL("http://localhost/api/agent/xiaomi-home/vacuum-remote"+suffix),response,ctx);await new Promise(resolve=>setImmediate(resolve));}
 assert.deepEqual(responses.map(r=>r.status),[200,400,200,200,400,400,200]);assert.deepEqual(calls,["vacuum","body",["start",{sessionId:"example"},"remote-route-stable-key"],"session","key"]);
});

test("vacuum cloud uses current identity and strict bodies and queries without exposing credentials", async () => {
  const responses: Array<{status: number; body: any}> = [];
  const calls: unknown[] = [];
  const ctx = context(() => undefined, () => undefined, responses);
  ctx.readJsonBody = async () => { calls.push("body"); return {} as never; };
  ctx.runtime = { vacuumCloud: {
    status: () => ({ connected: false, coordinateNavigation: false }),
    begin: async (key: string) => { calls.push(key); return { state: "waiting" }; },
    devices: async (region: string) => { calls.push(region); return []; },
    map: async (...args: string[]) => { calls.push(args); return { decoded: false }; },
    pluginInformation: async (...args: unknown[]) => { calls.push(args); return {latestInfo: []}; },
    pluginPackage: async (...args: unknown[]) => { calls.push(args); return {packageBase64: ""}; },
    trajectory: async (...args: string[]) => { calls.push(args); return {points:[]}; },
    feedback: async (...args: string[]) => { calls.push(args); return {map:{decoded:false},feedback:{state:"unavailable"}}; }
  } } as unknown as XiaomiHomeRuntimeController;
  const response = { setHeader: () => undefined } as unknown as http.ServerResponse;
  const root = "http://localhost/api/agent/xiaomi-home/vacuum-cloud";
  const fence = { "x-rabiroute-expected-application-generation-id": lifecycleFence.applicationGenerationId, "x-rabiroute-expected-manager-instance-id": lifecycleFence.managerInstanceId, "idempotency-key": "vacuum-cloud-login-test" };
  for (const [suffix, method, headers] of [
    ["/status", "GET", {}], ["/login", "POST", {}], ["/login", "POST", fence],
    ["/devices?region=cn", "GET", {}], ["/map?deviceId=123&region=cn&slot=0", "GET", {}],
    ["/map?deviceId=123&deviceId=456", "GET", {}], ["/status?token=secret", "GET", {}],
    ["/plugin-information?deviceId=123&sdkVersion=10080", "GET", {}], ["/plugin-package?deviceId=123", "GET", {}],
    ["/plugin-package?deviceId=123&url=https://untrusted.invalid", "GET", {}],
    ["/trajectory?deviceId=123&poseId=5", "GET", {}],
    ["/trajectory?deviceId=123&poseId=5&aiid=26", "GET", {}],
    ["/trajectory?deviceId=123&poseId=5&poseId=6", "GET", {}],
    ["/feedback?deviceId=123&scope="+"a".repeat(64)+"&poseId=5", "GET", {}],
    ["/feedback?deviceId=123&poseId=5&aiid=26", "GET", {}],
    ["/feedback?deviceId=123&scope=x&scope=y", "GET", {}]
  ] as Array<[string, string, Record<string, string>]>) {
    handleXiaomiHomeManagerApi(request(headers, method), new URL(root + suffix), response, ctx);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(responses.map(r => r.status), [200, 400, 200, 200, 200, 400, 400, 200, 200, 400, 200, 400, 400, 200, 400, 400]);
  assert.deepEqual(calls, ["body", "vacuum-cloud-login-test", "cn", ["123", "cn", "0"], ["123", "cn", 10080], ["123", "cn", 10112], ["123", "cn", "5"], ["123", "cn", "0", "a".repeat(64), "5"]]);
});

test("position query permits only owned device and region reads", async () => {
  const responses: Array<{status: number; body: any}> = [];
  const calls: string[][] = [];
  const ctx = context(() => undefined, () => undefined, responses);
  ctx.runtime = {vacuumCloud: {position: async (...args: string[]) => {
    calls.push(args);
    return {state: "unavailable", coordinateNavigation: false};
  }}} as unknown as XiaomiHomeRuntimeController;
  const response = {setHeader: () => undefined} as unknown as http.ServerResponse;
  for (const suffix of ["?deviceId=123", "?deviceId=123&region=de", "?deviceId=123&deviceId=456", "?deviceId=123&piid=4", "?deviceId=123&token=private"]) {
    handleXiaomiHomeManagerApi(request({}, "GET"), new URL("http://localhost/api/agent/xiaomi-home/vacuum-cloud/position" + suffix), response, ctx);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(responses.map(r => r.status), [200, 200, 400, 400, 400]);
  assert.deepEqual(calls, [["123", "cn"], ["123", "de"]]);
});

test("telemetry route rejects arbitrary properties, duplicates and credentials",async()=>{
 const responses:Array<{status:number;body:any}>=[],calls:string[][]=[],ctx=context(()=>undefined,()=>undefined,responses);
 ctx.runtime={vacuumCloud:{telemetry:async(...args:string[])=>{calls.push(args);return {statusCode:8};}}} as unknown as XiaomiHomeRuntimeController;
 const response={setHeader:()=>undefined} as unknown as http.ServerResponse;
 for(const suffix of ["?deviceId=123","?deviceId=123&region=de","?deviceId=123&deviceId=456","?deviceId=123&siid=2","?deviceId=123&datasource=1","?deviceId=123&token=private"]){handleXiaomiHomeManagerApi(request({},"GET"),new URL("http://localhost/api/agent/xiaomi-home/vacuum-cloud/telemetry"+suffix),response,ctx);await new Promise(resolve=>setImmediate(resolve));}
 assert.deepEqual(responses.map(r=>r.status),[200,200,400,400,400,400]);assert.deepEqual(calls,[["123","cn"],["123","de"]]);
});

test("path query has fixed read-only parameters and rejects duplicate or arbitrary action fields",async()=>{
 const responses:Array<{status:number;body:any}>=[],calls:unknown[][]=[],ctx=context(()=>undefined,()=>undefined,responses);
 ctx.runtime={vacuumCloud:{path:async(...args:string[])=>{calls.push(args);return {movementCommandsSent:0};}}} as unknown as XiaomiHomeRuntimeController;
 const response={setHeader:()=>undefined} as unknown as http.ServerResponse;
 for(const suffix of ["?deviceId=123&mapHash=abc&targetX=5&targetY=-6","?deviceId=123&targetX=5&targetX=6","?deviceId=123&aiid=26"]){handleXiaomiHomeManagerApi(request({},"GET"),new URL("http://localhost/api/agent/xiaomi-home/vacuum-cloud/path"+suffix),response,ctx);await new Promise(resolve=>setImmediate(resolve));}
 assert.deepEqual(responses.map(r=>r.status),[200,400,400]);assert.deepEqual(calls,[["123","cn","0","abc","5","-6","250"]]);
});

test("all-device action discovery validates query shape and forwards one-resource and bulk reads", async () => {
  const responses: Array<{status:number;body:any}> = [];
  const calls: unknown[] = [];
  const ctx = context(() => undefined, () => undefined, responses);
  ctx.runtime = {client: {
    listResources: async (includeActions:boolean) => {calls.push(includeActions);return [];},
    getResourceActions: async (id:string) => {calls.push(id);return {resourceId:id,actions:[]};}
  }} as unknown as XiaomiHomeRuntimeController;
  for (const suffix of ["/resources?includeActions=1", "/entity-actions?resourceId=home%3Aha%3Anumber.example", "/resources?includeActions=true", "/resources?extra=x",
    "/entity-actions", "/entity-actions?resourceId=x&resourceId=y", "/entity-actions?resourceId=x&extra=y"]){
    handleXiaomiHomeManagerApi(request({},"GET"),new URL("http://localhost/api/agent/xiaomi-home"+suffix),{} as http.ServerResponse,ctx);
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.deepEqual(responses.map(r=>r.status),[200,200,400,400,400,400,400]);
  assert.deepEqual(calls,[true,"home:ha:number.example"]);
});

test("authenticated discovery and receipt lookup reuse connection auth and retain strict receipt keys", async () => {
  const responses: Array<{status: number; body: any}> = [];
  let reads = 0;
  let lookups = 0;
  const ctx = context(() => {reads++;}, () => undefined, responses);
  ctx.controlPlaneAccessAllowed = () => true;
  ctx.runtime = {client: {
    getCapabilities: () => ({schemaVersion: 1, actions: []}),
    getActionReceipt: (key: string) => {lookups++; return {idempotencyKey: key, state: "completed", retryAllowed: false};}
  }} as unknown as XiaomiHomeRuntimeController;
  for (const suffix of ["/capabilities", "/action-requests?idempotencyKey=demo:key", "/action-requests", "/action-requests?idempotencyKey=x&idempotencyKey=y", "/action-requests?idempotencyKey=x&other=y"]) {
    handleXiaomiHomeManagerApi(request({}, "GET"), new URL(`http://localhost/api/agent/xiaomi-home${suffix}`), {} as http.ServerResponse, ctx);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(responses.map(item => item.status), [200, 200, 400, 400, 400]);
  assert.equal(lookups, 1); assert.equal(reads, 0);
  for (const suffix of ["/capabilities", "/action-requests?idempotencyKey=x"]) handleXiaomiHomeManagerApi(request({}, "GET", "192.168.0.20"), new URL(`http://localhost/api/agent/xiaomi-home${suffix}`), {} as http.ServerResponse, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses.slice(-2).map(item => item.status), [200, 200]);
  ctx.controlPlaneAccessAllowed = () => false;
  handleXiaomiHomeManagerApi(request({}, "GET", "192.168.0.20"), new URL("http://localhost/api/agent/xiaomi-home/capabilities"), {} as http.ServerResponse, ctx);
  assert.equal(responses.at(-1)?.status, 403);
});

test("deployment SSE sends owner snapshots and releases subscriptions on disconnect", () => {
  const frames: string[] = [];
  let disposed = false;
  const ctx = context(() => undefined, () => undefined, []);
  ctx.runtime = { deployment: { subscribe(listener: (value: unknown) => void) {
    listener({ state: "installing", progress: { phase: "download", percent: 42 } });
    return () => { disposed = true; };
  } } } as unknown as XiaomiHomeRuntimeController;
  const response = Object.assign(new EventEmitter(), {
    writeHead: (status: number, headers: Record<string, string>) => { assert.equal(status, 200); assert.equal(headers["Content-Type"], "text/event-stream"); },
    flushHeaders: () => undefined,
    write: (frame: string) => frames.push(frame), destroyed: false
  });
  assert.equal(handleXiaomiHomeManagerApi(request({}, "GET"), new URL("http://localhost/api/agent/xiaomi-home/deployment/events"), response as unknown as http.ServerResponse, ctx), true);
  assert.match(frames[0]!, /event: deployment/);
  assert.match(frames[0]!, /"percent":42/);
  response.emit("close");
  assert.equal(disposed, true);
  const denied: Array<{ status: number; body: any }> = [];
  handleXiaomiHomeManagerApi(request({}, "GET", "192.168.0.20"), new URL("http://localhost/api/agent/xiaomi-home/deployment/events"), {} as http.ServerResponse, context(() => undefined, () => undefined, denied));
  assert.equal(denied[0]?.status, 403);
});

test("deployment paths and startup remain local and fenced before any body is read", () => {
  const responses: Array<{ status: number; body: any }> = [];
  let reads = 0;
  const ctx = context(() => { reads++; }, () => undefined, responses);
  ctx.controlPlaneAccessAllowed = () => true;
  for (const suffix of ["/deployment", "/deployment/start", "/deployment/install"]) {
    handleXiaomiHomeManagerApi(request({}, "POST", "192.168.0.20"), new URL(`http://localhost/api/agent/xiaomi-home${suffix}`), {} as http.ServerResponse, ctx);
  }
  handleXiaomiHomeManagerApi(request({}, "POST"), new URL("http://localhost/api/agent/xiaomi-home/deployment/start"), {} as http.ServerResponse, ctx);
  handleXiaomiHomeManagerApi(request({}, "POST"), new URL("http://localhost/api/agent/xiaomi-home/deployment/install"), {} as http.ServerResponse, ctx);
  assert.deepEqual(responses.map(value => value.status), [403, 403, 403, 400, 400]);
  assert.equal(reads, 0);
});

function request(headers: Record<string, string> = {}, method = "PUT", remoteAddress = "127.0.0.1"): http.IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress }
  } as unknown as http.IncomingMessage;
}

function context(onRead: () => void, onUpdate: () => void, responses: Array<{ status: number; body: any }>): XiaomiHomeManagerRoutesContext {
  const runtime = {
    settings: () => ({ schemaVersion: 1, source: "profile", revision: "revision-current", settings: {} }),
    update: () => { onUpdate(); return { schemaVersion: 1, source: "runtime", revision: "revision-next", settings: {} }; }
  } as unknown as XiaomiHomeRuntimeController;
  return {
    runtime,
    lifecycleFence,
    readJsonBody: async () => { onRead(); return { revision: "revision-current", settings: {} } as never; },
    jsonResponse: (_response, status, body) => responses.push({ status, body }),
    deliverEvent: async () => undefined
  };
}

test("Xiaomi Home message-endpoint configuration accepts an authorized LAN control-plane request", async () => {
  const responses: Array<{ status: number; body: any }> = [];
  const routeContext = context(() => undefined, () => undefined, responses);
  routeContext.controlPlaneAccessAllowed = () => true;
  handleXiaomiHomeManagerApi(
    request({}, "GET", "192.168.0.20"),
    new URL("http://192.168.0.57/api/agent/xiaomi-home/settings"),
    {} as http.ServerResponse,
    routeContext
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses[0]?.status, 200);
});

test("Xiaomi Home authenticated LAN actions proceed to the same request contract", () => {
  const responses: Array<{ status: number; body: any }> = [];
  const routeContext = context(() => undefined, () => undefined, responses);
  routeContext.controlPlaneAccessAllowed = () => false;
  handleXiaomiHomeManagerApi(
    request({}, "GET", "192.168.0.20"),
    new URL("http://192.168.0.57/api/agent/xiaomi-home/settings"),
    {} as http.ServerResponse,
    routeContext
  );
  routeContext.controlPlaneAccessAllowed = () => true;
  handleXiaomiHomeManagerApi(
    request({}, "POST", "192.168.0.20"),
    new URL("http://192.168.0.57/api/agent/xiaomi-home/action-requests"),
    {} as http.ServerResponse,
    routeContext
  );
  assert.deepEqual(responses.map(item => item.status), [403, 400]);
  assert.equal(responses[1]?.body.error.code, "xiaomi_home_lifecycle_fence_required");
});

test("Xiaomi Home settings mutation rejects a missing lifecycle fence before reading the body", () => {
  let reads = 0;
  let updates = 0;
  const responses: Array<{ status: number; body: any }> = [];
  const handled = handleXiaomiHomeManagerApi(
    request(),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/settings"),
    {} as http.ServerResponse,
    context(() => { reads += 1; }, () => { updates += 1; }, responses)
  );
  assert.equal(handled, true);
  assert.equal(reads, 0);
  assert.equal(updates, 0);
  assert.equal(responses[0]?.status, 400);
  assert.equal(responses[0]?.body.error.code, "xiaomi_home_lifecycle_fence_required");
});

test("Xiaomi Home settings mutation rejects stale Manager identity before reading the body", () => {
  let reads = 0;
  const responses: Array<{ status: number; body: any }> = [];
  handleXiaomiHomeManagerApi(
    request({
      "x-rabiroute-expected-application-generation-id": lifecycleFence.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": "manager-instance-old"
    }),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/settings"),
    {} as http.ServerResponse,
    context(() => { reads += 1; }, () => undefined, responses)
  );
  assert.equal(reads, 0);
  assert.equal(responses[0]?.status, 409);
  assert.equal(responses[0]?.body.error.code, "xiaomi_home_lifecycle_fence_stale");
});

test("Xiaomi Home settings mutation accepts the current /meta lifecycle identity", async () => {
  let reads = 0;
  let updates = 0;
  const responses: Array<{ status: number; body: any }> = [];
  handleXiaomiHomeManagerApi(
    request({
      "x-rabiroute-expected-application-generation-id": lifecycleFence.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": lifecycleFence.managerInstanceId
    }),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/settings"),
    {} as http.ServerResponse,
    context(() => { reads += 1; }, () => { updates += 1; }, responses)
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(updates, 1);
  assert.equal(responses[0]?.status, 200);
});

test("Xiaomi Home credential mutation requires the current lifecycle fence before reading a secret", () => {
  let reads = 0;
  let authorizations = 0;
  const rejectedToken = ["must", "not", "be", "read"].join("-");
  const responses: Array<{ status: number; body: any }> = [];
  const runtime = {
    authorize: async () => { authorizations += 1; return {}; }
  } as unknown as XiaomiHomeRuntimeController;
  handleXiaomiHomeManagerApi(
    request({}, "POST"),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/auth"),
    {} as http.ServerResponse,
    {
      runtime,
      lifecycleFence,
      readJsonBody: async () => { reads += 1; return { accessToken: rejectedToken } as never; },
      jsonResponse: (_response, status, body) => responses.push({ status, body }),
      deliverEvent: async () => undefined
    }
  );
  assert.equal(reads, 0);
  assert.equal(authorizations, 0);
  assert.equal(responses[0]?.status, 400);
});

test("Xiaomi Home credential API accepts a fenced token once and never returns it", async () => {
  let presentedToken = "";
  let presentedBaseUrl = "";
  let presentedRevision = "";
  const candidateToken = ["candidate", "secret"].join("-");
  const responses: Array<{ status: number; body: any }> = [];
  const runtime = {
    authorize: async (token: string, baseUrl: string, revision: string) => {
      presentedToken = token;
      presentedBaseUrl = baseUrl;
      presentedRevision = revision;
      return {
        schemaVersion: 1,
        state: "ready",
        configured: true,
        credentialSource: "protected",
        removable: true,
        baseUrl: "http://127.0.0.1:8123",
        endpointAccountId: "account-stable",
        revision: "authorization-current"
      };
    }
  } as unknown as XiaomiHomeRuntimeController;
  handleXiaomiHomeManagerApi(
    request({
      "x-rabiroute-expected-application-generation-id": lifecycleFence.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": lifecycleFence.managerInstanceId,
      "idempotency-key": "xiaomi-home-connect-test-0001"
    }, "POST"),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/auth"),
    {} as http.ServerResponse,
    {
      runtime,
      lifecycleFence,
      authMutationReceipts: {
        execute: (_key: string, _intent: unknown, operation: () => Promise<unknown>) => operation()
      } as XiaomiHomeAuthMutationReceipts,
      readJsonBody: async () => ({
        accessToken: candidateToken,
        baseUrl: "http://127.0.0.1:8123",
        settingsRevision: "settings-current",
        authorizationRevision: "authorization-current"
      } as never),
      jsonResponse: (_response, status, body) => responses.push({ status, body }),
      deliverEvent: async () => undefined
    }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(presentedToken, candidateToken);
  assert.equal(presentedBaseUrl, "http://127.0.0.1:8123");
  assert.equal(presentedRevision, "settings-current");
  assert.equal(responses[0]?.status, 200);
  assert.equal(JSON.stringify(responses[0]?.body).includes(candidateToken), false);
  assert.doesNotMatch(JSON.stringify(responses[0]?.body), /accessToken/);
});

test("Xiaomi Home action route forwards Idempotency-Key and presents stable conflict errors", async () => {
  const body: XiaomiHomeActionRequest = {
    resourceId: "home:ha:switch.desk",
    capability: "home.switch.turn_on@1",
    expectedStateVersion: "ha:expected"
  };
  let presentedKey = "";
  const responses: Array<{ status: number; body: any }> = [];
  const runtime = {
    client: {
      executeAction: async (_request: XiaomiHomeActionRequest, key: string) => {
        presentedKey = key;
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_idempotency_conflict", "Idempotency-Key was already used for another action payload.");
      }
    }
  } as unknown as XiaomiHomeRuntimeController;
  const routeContext: XiaomiHomeManagerRoutesContext = {
    runtime,
    lifecycleFence,
    readJsonBody: async () => body as never,
    jsonResponse: (_response, status, responseBody) => responses.push({ status, body: responseBody }),
    deliverEvent: async () => undefined
  };
  handleXiaomiHomeManagerApi(
    request({
      "x-rabiroute-expected-application-generation-id": lifecycleFence.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": lifecycleFence.managerInstanceId,
      "idempotency-key": "route-key"
    }, "POST"),
    new URL("http://127.0.0.1/api/agent/xiaomi-home/action-requests"),
    {} as http.ServerResponse,
    routeContext
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(presentedKey, "route-key");
  assert.equal(responses[0]?.status, 409);
  assert.equal(responses[0]?.body.error.code, "xiaomi_home_idempotency_conflict");
});


test("device directory is authenticated read-only and refuses caller template/query input", async () => {
 const responses: Array<{status:number;body:any}>=[];let reads=0;
 const ctx=context(()=>undefined,()=>undefined,responses);
 ctx.runtime={client:{listDevices:async()=>{reads++;return{schemaVersion:1,devices:[],unassignedResources:[]};}}} as unknown as XiaomiHomeRuntimeController;
 for(const suffix of ["/devices","/devices?template=bad"]){handleXiaomiHomeManagerApi(request({},"GET"),new URL("http://localhost/api/agent/xiaomi-home"+suffix),{} as http.ServerResponse,ctx);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(reads,1);assert.deepEqual(responses.map(r=>r.status),[200,400]);
});


test("video password management uses lifecycle fences and strict body types",async()=>{
 const responses:Array<{status:number;body:any}>=[];let starts:any[]=[];let forgets=0;
 const ctx=context(()=>undefined,()=>undefined,responses);
 ctx.runtime={vacuumCloud:{video:{start:async(...args:any[])=>{starts=args;return{state:"connecting"};}},
  forgetVideoPassword:()=>{forgets++;return{saved:false,state:"completed"};}}} as unknown as XiaomiHomeRuntimeController;
 const headers={"x-rabiroute-expected-application-generation-id":lifecycleFence.applicationGenerationId,"x-rabiroute-expected-manager-instance-id":lifecycleFence.managerInstanceId,"idempotency-key":"video-password-route-0001"};
 for(const [suffix,body,header] of [
  ["start",{deviceId:"123",password:"4821",rememberPassword:"true"},headers],
  ["start",{deviceId:"123",password:"4821",rememberPassword:true},headers],
  ["password/forget",{deviceId:"123"},{}],
  ["password/forget",{deviceId:"123"},headers],
  ["password/forget",{deviceId:"123",password:"4821"},headers]
 ] as const) {
  ctx.readJsonBody=async()=>body as never;
  handleXiaomiHomeManagerApi(request(header,"POST"),new URL("http://localhost/api/agent/xiaomi-home/vacuum-cloud/video/"+suffix),{setHeader:()=>undefined} as unknown as http.ServerResponse,ctx);
  await new Promise(resolve=>setImmediate(resolve));
 }
 assert.equal(starts[3],"4821");assert.equal(starts[4],true);assert.equal(forgets,1);
 assert.equal(responses[0]?.status,400);assert.equal(responses[1]?.status,200);assert.ok(responses[2]!.status>=400);assert.equal(responses[3]?.status,200);assert.equal(responses[4]?.status,400);
 assert.ok(!JSON.stringify(responses).includes("4821"));
});
