import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatApiDescriptors, type NapcatApiManifest } from "./napcatApiCatalog.js";
import { createNapcatApiOperations, projectNapcatApiResponse } from "./napcatApiOperations.js";

const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
const descriptors = createNapcatApiDescriptors(manifest);
const definition = { id: "fixture", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "fixture-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-token", botUserId: "12345" }
] } as GatewayDefinition;

function sample(schema: Record<string, unknown>): unknown {
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return sample(variants[0] as Record<string, unknown>);
  if (schema.type === "null") return null;
  if (schema.type === "boolean") return true;
  if (schema.type === "integer" || schema.type === "number") return Math.max(1, Number(schema.minimum ?? 0));
  if (schema.type === "string") return schema.format === "uri" ? "https://example.invalid/fixture" : "12345";
  if (schema.type === "array") return Array.from({ length: Math.max(1, Number(schema.minItems ?? 0)) }, () => sample((schema.items ?? {}) as Record<string, unknown>));
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};
  const required = schema.required as string[] ?? [];
  return Object.fromEntries(required.map(key => [key, sample(properties[key]!)]));
}

function input(body: unknown): ApiOperationInput {
  return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://127.0.0.1/fixture"),
    path: {}, query: {}, body } as ApiOperationInput;
}

test("versioned installed declarations compile all 167 operations and 501 canonical/alias names", () => {
  const operations = createNapcatApiOperations({ rootDir: ".", local: () => true, route: () => definition, readOnly: () => false }, descriptors);
  assert.equal(operations.length, 167);
  const names = operations.flatMap(operation => [operation.contract.operationId, ...(operation.contract.aliases ?? [])]);
  assert.equal(names.length, 501);
  assert.equal(new Set(names).size, 501);
  assert.equal(descriptors.some(row => row.action === "get_word_slices" || row.action === "unknown"), false);
});

test("every declared action rejects additional caller fields before any provider request", async () => {
  let calls = 0;
  const operations = createNapcatApiOperations({ rootDir: ".", local: () => true, route: () => definition, readOnly: () => false,
    transport: async () => { calls++; throw Error("Provider must not be reached"); } }, descriptors);
  for (const [index, operation] of operations.entries()) {
    const descriptor = descriptors[index]!;
    const result = await operation.handler(input({ routeId: "fixture", instanceId: "fixture-instance", params: sample(descriptor.parameters as Record<string, unknown>),
      ...(descriptor.mode === "mutation" ? { deliveryId: `fixture-${descriptor.action}` } : {}), unexpectedAction: "send_packet" }));
    assert.equal(result.status, 400, descriptor.action);
  }
  assert.equal(calls, 0);
});

test("all directly callable declarations use mocked identity and schema-shaped provider results", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-static-catalog-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let selectedAction = "";
  const direct = descriptors.filter(row => row.mode !== "managed");
  const operations = createNapcatApiOperations({ rootDir, local: () => true, route: () => definition, readOnly: () => false,
    transport: async url => {
      if (new URL(String(url)).hostname === "fixture-media.invalid") return new Response(Buffer.from("fixture-image"));
      const action = new URL(String(url)).pathname.slice(1);
      const descriptor = direct.find(row => row.action === selectedAction)!;
      if (action === "get_msg" && descriptor.attachmentInput) return Response.json({ status: "ok", retcode: 0, data: {
        post_type: "message", message_type: "group", group_id: 12345, self_id: 12345, user_id: 45678, message_id: 12345,
        message: Array.from({ length: 2 }, () => ({ type: descriptor.attachmentInput === "audio-message" ? "record" : "image",
          data: { file: "fixture-resource", url: "https://fixture-media.invalid/image" } }))
      } });
      const data = action === "get_login_info" && selectedAction !== "get_login_info" ? { user_id: 12345 }
        : action === "get_online_clients" ? []
          : ["ocr_image", ".ocr_image"].includes(action) ? { texts: [{ text: "fixture OCR", coordinates: [], token: "private" }] }
          : action === "get_login_info" ? { ...sample(descriptor.nativeResponse as Record<string, unknown>) as object, user_id: 12345 }
          : sample(descriptor.nativeResponse as Record<string, unknown>);
      return Response.json({ status: "ok", retcode: 0, data });
    } }, direct);
  for (const [index, descriptor] of direct.entries()) {
    selectedAction = descriptor.action;
    const result = await operations[index]!.handler(input({ routeId: "fixture", instanceId: "fixture-instance", params: sample(descriptor.parameters as Record<string, unknown>),
      ...(descriptor.mode === "mutation" ? { deliveryId: `fixture-${descriptor.action}` } : {}) }));
    assert.equal(result.status, 200, `${descriptor.action}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(direct.length, 87);
});

test("credential, file, event-context and test actions retain an explicit owner/dependency boundary", () => {
  for (const action of ["get_cookies", "get_clientkey", "send_packet", "download_file", ".handle_quick_operation", "test_auto_register_01", "test_auto_register_02"]) {
    const descriptor = descriptors.find(row => row.action === action)!;
    assert.equal(descriptor.mode, "managed", action);
    assert.ok(descriptor.unavailableReason, action);
  }
  assert.equal(descriptors.find(row => row.action === "send_group_msg")!.managedOwner, "agent.send");
  assert.equal(descriptors.find(row => row.action === "get_group_file_url")!.mode, "managed");
});

test("eleven absent outbound producers are explicit dependencies despite their shared owner reference", async () => {
  let calls = 0;
  const rows = descriptors.filter(row => row.managedOwner === "agent.send" && row.unavailableReason);
  assert.equal(rows.length, 11);
  const operations = createNapcatApiOperations({ rootDir: ".", local: () => true, route: () => definition, readOnly: () => false,
    transport: async () => { calls++; throw Error("Provider must not be reached"); } }, rows);
  for (const [index, row] of rows.entries()) {
    const result = await operations[index]!.handler(input({ routeId: "fixture", instanceId: "fixture-instance", params: sample(row.parameters as Record<string, unknown>) }));
    assert.equal(result.status, 503, row.action);
    assert.deepEqual(result.body, { code: -1, errorCode: "QQ_API_OWNER_DEPENDENCY_UNAVAILABLE" });
  }
  assert.equal(calls, 0);
});

test("reviewed metadata DTOs omit opaque message media, notice settings and request extra fields", () => {
  const notice = descriptors.find(row => row.action === "_get_group_notice")!;
  const projected = projectNapcatApiResponse(notice.response, [{ sender_id: 12, publish_time: 30, notice_id: "notice", message: {
    text: "fixture notice", image: [{ url: "private-signed-url" }], images: [{ token: "private" }] }, settings: { cookie: "private" }, read_num: 4
  }], notice.nativeResponse);
  assert.deepEqual(projected, [{ sender_id: 12, publish_time: 30, notice_id: "notice", message: { text: "fixture notice" }, read_num: 4 }]);
  const ignored = descriptors.find(row => row.action === "get_group_ignored_notifies")!;
  const requests = projectNapcatApiResponse(ignored.response, { invited_requests: [{ request_id: 4, group_id: 789, checked: false, cookie: "private" }],
    InvitedRequest: [], join_requests: [] }, ignored.nativeResponse);
  assert.deepEqual(requests, { invited_requests: [{ request_id: 4, group_id: 789, checked: false }], InvitedRequest: [], join_requests: [] });
});
