import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatApiDescriptors, type NapcatApiManifest } from "./napcatApiCatalog.js";
import { createNapcatApiOperations } from "./napcatApiOperations.js";
import { napcatResultProfileFixtures } from "./napcatApiResultProfiles.fixture.js";
import { projectNapcatApiResultProfile } from "./napcatApiResultProfiles.js";

const manifest = JSON.parse(await fs.readFile(new URL("../../contracts/napcat-4.18.4.json", import.meta.url), "utf8")) as NapcatApiManifest;
const descriptors = createNapcatApiDescriptors(manifest).filter(row => row.resultProfile);
const route = { id: "example", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
  { id: "example-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-token", botUserId: "12345" }
] } as GatewayDefinition;
function input(params: unknown): ApiOperationInput {
  return { request: { headers: {} } as IncomingMessage, response: {}, url: new URL("http://127.0.0.1/example"), path: {}, query: {},
    body: { routeId: "example", instanceId: "example-instance", params } } as ApiOperationInput;
}

test("23 explicit views distinguish metadata, installed examples, diagnostics and credential summaries", () => {
  assert.equal(descriptors.length, 23);
  assert.equal(descriptors.filter(row => (row.response as Record<string, any>).properties.view.const === "credential-summary").length, 7);
  assert.equal(descriptors.filter(row => (row.response as Record<string, any>).properties.view.const === "diagnostic").length, 4);
  assert.equal(descriptors.filter(row => (row.response as Record<string, any>).properties.evidence.const === "installed-example").length, 5);
  assert.equal(descriptors.filter(row => (row.response as Record<string, any>).properties.evidence.const === "declared-metadata-projection").length, 4);
  assert.equal(descriptors.every(row => row.mode === "read"), true);
});

test("all profile handlers expose reviewed fields and never persist native credential material", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-result-views-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let selected = "";
  const operations = createNapcatApiOperations({ rootDir, local: () => true, route: () => route, readOnly: () => false,
    transport: async url => Response.json({ status: "ok", retcode: 0, data: new URL(String(url)).pathname === "/get_login_info"
      ? { user_id: 12345 } : napcatResultProfileFixtures[selected] }) }, descriptors);
  for (const [index, descriptor] of descriptors.entries()) {
    selected = descriptor.action;
    // Public operation schema validation is covered by the full-catalog test. These internal calls isolate result projection.
    const parameters = sample(descriptor.parameters as Record<string, unknown>);
    const result = await operations[index]!.handler(input(parameters));
    assert.equal(result.status, 200, `${descriptor.action} ${JSON.stringify(result.body)}`);
    const serialized = JSON.stringify(result.body);
    for (const secret of ["example-secret", "example-acceptance-capability", "example-cookie-material", "example-csrf-material",
      "987654321", "example-client-key-material", "example-rkey-material", "example-private-rkey", "example-group-rkey"]) {
      assert.equal(serialized.includes(secret), false, descriptor.action);
    }
  }
  assert.deepEqual(await fs.readdir(rootDir), []);
});

test("changed example shapes and unknown primitive native results fail without returning raw values", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-result-shapes-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const broken: Record<string, unknown> = { ArkSharePeer: "not json", get_robot_uin_range: [{ minUin: 1, maxUin: 2 }], get_group_shut_list: [{ uid: "12345" }],
    get_collection_list: { result: 0 }, get_group_album_media_list: { media_list: [{ media_id: 1 }] }, get_online_file_msg: "example-secret", get_fileset_info: { fileset_id: "example" },
    get_credentials: { cookies: "example-cookie-material", token: "example-secret" }, nc_get_rkey: [{ type: 10, time: 123, ttl: "example-secret", rkey: "example-rkey-material" }] };
  for (const [action, data] of Object.entries(broken)) {
    const descriptor = descriptors.find(row => row.action === action)!;
    const operation = createNapcatApiOperations({ rootDir, local: () => true, route: () => route, readOnly: () => false,
      transport: async url => Response.json({ status: "ok", retcode: 0, data: new URL(String(url)).pathname === "/get_login_info" ? { user_id: 12345 } : data }) }, [descriptor])[0]!;
    const result = await operation.handler(input(sample(descriptor.parameters as Record<string, unknown>)));
    assert.equal(result.status, 503, action);
    assert.deepEqual(result.body, { code: -1, errorCode: "QQ_API_RESPONSE_CONTRACT_MISMATCH" });
  }
});

test("optional and empty credential material report actual absence without exposing values", () => {
  assert.deepEqual(projectNapcatApiResultProfile("get_clientkey", {}, {}), {
    view: "credential-summary", evidence: "installed-handler", data: { type: "clientkey", available: false }
  });
  assert.deepEqual(projectNapcatApiResultProfile("get_cookies", { cookies: "", bkn: "" }, { domain: "example.invalid" }), {
    view: "credential-summary", evidence: "installed-handler", data: { scope: "example.invalid", cookiesPresent: false, csrfPresent: false }
  });
  assert.deepEqual(projectNapcatApiResultProfile("get_rkey_server", { name: "NapCat 4" }, {}), {
    view: "credential-summary", evidence: "installed-handler", data: { privatePresent: false, groupPresent: false }
  });
});

test("credential scope accepts domain names and rejects caller URLs before provider reads", async () => {
  let calls = 0;
  const descriptor = descriptors.find(row => row.action === "get_cookies")!;
  const operation = createNapcatApiOperations({ rootDir: ".", local: () => true, route: () => route, readOnly: () => false,
    transport: async () => { calls++; throw Error("Provider must not be reached"); } }, [descriptor])[0]!;
  for (const domain of ["https://example.invalid", "example.invalid/path", "example.invalid?token=example", "user@example.invalid", "..example.invalid", "example.invalid\n"]) {
    assert.equal((await operation.handler(input({ domain }))).status, 400);
  }
  assert.equal((await operation.handler(input({ domain: "example.invalid", token: "example-secret" }))).status, 400);
  assert.equal(calls, 0);
});

function sample(schema: Record<string, unknown>): unknown {
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] as Record<string, unknown>);
  if (schema.type === "string") return "example";
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  return Object.fromEntries((schema.required as string[] ?? []).map(key => [key, sample(properties![key]!)]));
}
