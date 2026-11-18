import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { createNapcatApiOperations, napcatApiResponseValidator, projectNapcatApiResponse, type NapcatApiDescriptor, type NapcatApiOperationsContext } from "./napcatApiOperations.js";
import { createNapcatApiReceiptOperation } from "./napcatApiReceipts.js";

const descriptor: NapcatApiDescriptor = {
  action: "get_group_info", aliases: ["get_group_info_async", "get_group_info_rate_limited"], title: "Group information", description: "Fixture contract", version: "4.18.4", mode: "read",
  parameters: { type: "object", additionalProperties: false, required: ["group_id"], properties: { group_id: { type: "string", pattern: "^[1-9][0-9]+$" } } },
  response: { type: "object", additionalProperties: false, required: ["group_id"], properties: { group_id: { type: "number" } } },
  nativeResponse: { type: "object", required: ["group_id"], properties: { group_id: { type: "number" } } }
};
const route = { id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "fixture-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-token", botUserId: "12345" }
] } as GatewayDefinition;
const input = (body: unknown) => ({ request: { headers: {} } as IncomingMessage, response: {},
  url: new URL("http://127.0.0.1/api/agent/qq/onebot/get_group_info"), path: {}, query: {}, body }) as ApiOperationInput;
const request = () => ({ routeId: "fixture", instanceId: "fixture-instance", params: { group_id: "789" } });
const ok = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });

async function fixture(t: test.TestContext, behavior?: (action: string) => Response) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-api-operation-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const context: NapcatApiOperationsContext = { rootDir, readOnly: () => false, local: () => true, route: () => route,
    transport: async url => {
      const action = new URL(String(url)).pathname.slice(1); calls.push(action);
      return behavior?.(action) ?? ok(action === "get_login_info" ? { user_id: 12345 } : { group_id: 789 });
    } };
  return { rootDir, context, calls };
}

test("static operations expose canonical contracts and aliases with bounded native transport", async t => {
  const f = await fixture(t);
  const operation = createNapcatApiOperations(f.context, [descriptor])[0]!;
  assert.equal(operation.contract.pathTemplate, "/api/agent/qq/onebot/get_group_info");
  assert.deepEqual(operation.contract.aliases, ["agent.qq.onebot.get_group_info_async", "agent.qq.onebot.get_group_info_rate_limited"]);
  const result = await operation.handler(input(request()));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { code: 0, data: { group_id: 789 } });
  assert.deepEqual(f.calls, ["get_login_info", "get_group_info"]);
});

test("unknown top-level and nested parameters never reach upstream", async t => {
  const f = await fixture(t), operation = createNapcatApiOperations(f.context, [descriptor])[0]!;
  for (const value of [{ ...request(), action: "send_packet" }, { ...request(), url: "http://other" },
    { ...request(), params: { group_id: "789", token: "caller-token" } }]) {
    const result = await operation.handler(input(value));
    assert.equal(result.status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("an undeclared provider response field is omitted from the public DTO", async t => {
  const f = await fixture(t, action => ok(action === "get_login_info" ? { user_id: 12345 } : { group_id: 789, access_token: "sensitive" }));
  const result = await createNapcatApiOperations(f.context, [descriptor])[0]!.handler(input(request()));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { code: 0, data: { group_id: 789 } });
});

test("mutation receipts use the existing durable owner and reject changed payloads", async t => {
  const f = await fixture(t), mutation = { ...descriptor, mode: "mutation" as const };
  const operation = createNapcatApiOperations(f.context, [mutation])[0]!;
  const body = { ...request(), deliveryId: "fixture-mutation-id" };
  const first = await operation.handler(input(body));
  const second = await operation.handler(input(body));
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(f.calls.filter(x => x === "get_group_info").length, 1);
  assert.equal((second.body as { delivery: { duplicate: boolean } }).delivery.duplicate, true);
  const conflict = await operation.handler(input({ ...body, params: { group_id: "456" } }));
  assert.equal(conflict.status, 409);
  assert.equal(f.calls.filter(x => x === "get_group_info").length, 1);
});

test("read-only mode rejects mutation before identity lookup", async t => {
  const f = await fixture(t); f.context.readOnly = () => true;
  const result = await createNapcatApiOperations(f.context, [{ ...descriptor, mode: "mutation" }])[0]!.handler(input({ ...request(), deliveryId: "fixture-readonly" }));
  assert.equal(result.status, 403); assert.equal(f.calls.length, 0);
});

test("receipt reads use original durable audit binding and never disclose raw result or errors", async t => {
  const f = await fixture(t);
  await createNapcatApiOperations(f.context, [{ ...descriptor, mode: "mutation" }])[0]!.handler(input({ ...request(), deliveryId: "fixture-receipt" }));
  const read = createNapcatApiReceiptOperation(f.context);
  const receiptInput = { ...input(undefined), path: { deliveryId: "fixture-receipt" }, query: { routeId: "fixture", instanceId: "fixture-instance" } };
  const callsBeforeRead = f.calls.length;
  const result = await read.handler(receiptInput);
  assert.equal(result.status, 200);
  const value = result.body as { receipt: Record<string, unknown> };
  assert.equal(value.receipt.state, "completed");
  assert.equal(value.receipt.action, "get_group_info");
  assert.equal(value.receipt.result, undefined);
  assert.equal(value.receipt.error, undefined);
  assert.equal(f.calls.length, callsBeforeRead);
  const changed = { ...route, napcatInstances: [{ ...route.napcatInstances![0]!, botUserId: "67890" }] };
  f.context.route = () => changed;
  assert.equal((await read.handler(receiptInput)).status, 404);
  assert.equal((await read.handler({ ...receiptInput, path: { deliveryId: "absent" } })).status, 404);
});

test("union DTO projection selects the actual native branch and excludes explicitly private fields", () => {
  const native = { oneOf: [
    { type: "object", required: ["kind", "a", "token"], properties: { kind: { const: "a" }, a: { type: "string" }, token: { type: "string" } } },
    { type: "object", required: ["kind", "b", "cookie"], properties: { kind: { const: "b" }, b: { type: "number" }, cookie: { type: "string" } } }
  ] };
  const projected = { oneOf: [
    { type: "object", required: ["kind", "a"], properties: { kind: { const: "a" }, a: { type: "string" } } },
    { type: "object", required: ["kind", "b"], properties: { kind: { const: "b" }, b: { type: "number" } } }
  ] };
  assert.deepEqual(projectNapcatApiResponse(projected, { kind: "b", b: 2, cookie: "private", a: "extraneous" }, native), { kind: "b", b: 2 });
});

test("static response validators retain identity across repeated rows and union projections", () => {
  const schema = { type: "object", required: ["value"], properties: { value: { type: "string" } } };
  const first = napcatApiResponseValidator(schema);
  for (let index = 0; index < 100; index++) {
    assert.equal(napcatApiResponseValidator(schema), first);
    assert.equal(first({ value: "fixture" }), true);
  }
  assert.notEqual(napcatApiResponseValidator({ ...schema }), first);
});

test("uncertain mutation receipts remain unchanged when read and never retry the provider", async t => {
  const f = await fixture(t, action => {
    if (action === "get_login_info") return ok({ user_id: 12345 });
    throw Error("private-provider-failure-with-cookie");
  });
  const write = createNapcatApiOperations(f.context, [{ ...descriptor, mode: "mutation" }])[0]!;
  const outcome = await write.handler(input({ ...request(), deliveryId: "fixture-uncertain" }));
  assert.equal(outcome.status, 202);
  const read = createNapcatApiReceiptOperation(f.context);
  const receiptInput = { ...input(undefined), path: { deliveryId: "fixture-uncertain" }, query: { routeId: "fixture", instanceId: "fixture-instance" } };
  const before = await read.handler(receiptInput);
  const after = await read.handler(receiptInput);
  assert.equal(before.status, 200);
  assert.deepEqual(after.body, before.body);
  assert.equal((before.body as { receipt: { state: string } }).receipt.state, "uncertain");
  assert.equal(f.calls.filter(action => action === "get_group_info").length, 1);
  assert.equal(JSON.stringify(before.body).includes("private-provider"), false);
});

test("managed operations reference their original contract and never fall through to raw transport", async t => {
  const f = await fixture(t);
  const managed = { ...descriptor, mode: "managed" as const, managedOwner: "agent.send" };
  const first = await createNapcatApiOperations(f.context, [managed])[0]!.handler(input(request()));
  assert.equal(first.status, 409); assert.equal(f.calls.length, 0);
  assert.deepEqual(first.body, { code: -1, errorCode: "QQ_API_USE_EXISTING_OWNER" });
  const missing = { ...descriptor, mode: "managed" as const, unavailableReason: "Protected credential owner is not implemented." };
  const second = await createNapcatApiOperations(f.context, [missing])[0]!.handler(input(request()));
  assert.equal(second.status, 503); assert.equal(f.calls.length, 0);
  assert.deepEqual(second.body, { code: -1, errorCode: "QQ_API_OWNER_DEPENDENCY_UNAVAILABLE" });
});
