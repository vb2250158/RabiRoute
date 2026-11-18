import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { callNapcatApi, napcatApiFailure, selectNapcatApiInstance, type NapcatApiTransportContext } from "./napcatApiTransport.js";

const request = () => ({ headers: {} }) as IncomingMessage;
const definition = () => ({ id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "fixture-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-token", botUserId: "12345" }
] }) as GatewayDefinition;
const ok = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
const actions = new Set(["get_group_info"]);

test("static action transport binds configured instance and actual QQ before provider operation", async () => {
  const route = definition(), seen: string[] = [];
  const context: NapcatApiTransportContext = { local: () => true, route: () => route,
    transport: async (url, options) => {
      const action = new URL(String(url)).pathname;
      seen.push(action);
      assert.equal(options?.redirect, "error");
      assert.equal((options?.headers as Record<string, string>).authorization, "Bearer example-token");
      return action === "/get_login_info" ? ok({ user_id: 12345 }) : ok({ group_id: 987 });
    } };
  const selected = selectNapcatApiInstance(context, request(), "fixture", "fixture-instance");
  const result = await callNapcatApi(context, selected, "get_group_info", { group_id: "987" }, actions, new AbortController().signal);
  assert.deepEqual(result, { group_id: 987 });
  assert.deepEqual(seen, ["/get_login_info", "/get_group_info"]);
});

test("unknown action is rejected before identity or upstream calls", async () => {
  let calls = 0;
  const context: NapcatApiTransportContext = { local: () => true, route: definition, transport: async () => { calls++; return ok({}); } };
  const selected = selectNapcatApiInstance(context, request(), "fixture", "fixture-instance");
  await assert.rejects(callNapcatApi(context, selected, "set_arbitrary", {}, actions, new AbortController().signal), { code: "QQ_API_ACTION_NOT_REGISTERED" });
  assert.equal(calls, 0);
});

test("mismatched QQ identity stops the selected action", async () => {
  const route = definition(), seen: string[] = [];
  const context: NapcatApiTransportContext = { local: () => true, route: () => route,
    transport: async url => { seen.push(new URL(String(url)).pathname); return ok({ user_id: 99999 }); } };
  const selected = selectNapcatApiInstance(context, request(), "fixture", "fixture-instance");
  await assert.rejects(callNapcatApi(context, selected, "get_group_info", {}, actions, new AbortController().signal), { code: "QQ_API_ACCOUNT_MISMATCH" });
  assert.deepEqual(seen, ["/get_login_info"]);
});

test("rebound or revoked authority after identity lookup prevents action dispatch", async t => {
  for (const change of ["binding", "permission"] as const) await t.test(change, async () => {
    const route = definition(); let permitted = true, calls = 0;
    const context: NapcatApiTransportContext = { local: () => permitted, route: () => route,
      transport: async () => {
        calls++;
        if (change === "binding") route.napcatInstances![0]!.accessToken = "rotated";
        else permitted = false;
        return ok({ user_id: 12345 });
      } };
    const selected = selectNapcatApiInstance(context, request(), "fixture", "fixture-instance");
    await assert.rejects(callNapcatApi(context, selected, "get_group_info", {}, actions, new AbortController().signal),
      { code: change === "binding" ? "QQ_API_BINDING_CHANGED" : "QQ_API_AUTH_REQUIRED" });
    assert.equal(calls, 1);
  });
});

test("unsafe URLs and missing configured QQ fail before provider reads", () => {
  const route = definition(); const context = { local: () => true, route: () => route };
  route.napcatInstances![0]!.httpUrl = "http://127.0.0.1:12345/?token=secret";
  assert.throws(() => selectNapcatApiInstance(context, request(), "fixture", "fixture-instance"), { code: "QQ_API_ENDPOINT_UNSAFE" });
  route.napcatInstances![0]!.httpUrl = "http://127.0.0.1:12345";
  delete route.napcatInstances![0]!.botUserId;
  assert.throws(() => selectNapcatApiInstance(context, request(), "fixture", "fixture-instance"), { code: "QQ_API_CONFIGURED_ACCOUNT_REQUIRED" });
});

test("provider credential-bearing error bodies do not cross failure projection", async () => {
  const route = definition(); let calls = 0;
  const context: NapcatApiTransportContext = { local: () => true, route: () => route,
    transport: async () => ++calls === 1 ? ok({ user_id: 12345 }) : Response.json({ status: "failed", retcode: 999, wording: "secret-token" }) };
  const selected = selectNapcatApiInstance(context, request(), "fixture", "fixture-instance");
  try { await callNapcatApi(context, selected, "get_group_info", {}, actions, new AbortController().signal); assert.fail("Expected upstream rejection"); }
  catch (error) { assert.deepEqual(napcatApiFailure(error), { status: 503, body: { code: -1, errorCode: "QQ_API_UPSTREAM_REJECTED" } }); }
});
