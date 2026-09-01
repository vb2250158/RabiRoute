import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { handleXiaomiHomeManagerApi, type XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";
import { XiaomiHomeManagerApiError, type XiaomiHomeActionRequest } from "./managerApi.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";

const lifecycleFence = {
  applicationGenerationId: "application-generation-current",
  managerInstanceId: "manager-instance-current"
};

function request(headers: Record<string, string> = {}, method = "PUT"): http.IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
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
