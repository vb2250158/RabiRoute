import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type http from "node:http";
import { createAgentGroupFilesOperation, handleAgentGroupFiles, type AgentGroupFilesContext } from "./agentGroupFiles.js";
import { compileApiOperation, readApiOperationInput, validateApiOperationResult } from "./apiOperationContract.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { normalizeGatewayDefinition, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

const groupId = "123456";
const route = (): GatewayDefinition => ({
  id: "route-one", gatewayPort: 8789, enabled: true, messageAdapters: ["napcat"],
  agentAdapters: ["dsh"], primaryAgentAdapter: "dsh",
  primaryAgentTarget: "remote:other-node:other-agent",
  remoteAgentTargets: [{ id: "remote:other-node:other-agent", instanceId: "other-node", agentId: "other-agent", provider: "dsh" }],
  napcatInstances: [{ id: "qq-one", enabled: true, gatewayPort: 8789, httpUrl: "http://127.0.0.1:3000", accessToken: "do-not-leak" }]
});
const page = { files: [], folders: [], completenessUnknown: true as const, potentiallyTruncated: true as const, projectionTruncated: false };
function fixture(t: TestContext, options: { remote?: boolean; query?: string; address?: string; headers?: Record<string, string | undefined> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-qq-group-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-one");
  const target = `/api/agent/qq/group-files?${options.query ?? `routeId=route-one&groupId=${groupId}`}`;
  const request = { method: "GET", url: target, headers: { host: "localhost:8000", ...options.headers },
    socket: { remoteAddress: options.address ?? (options.remote === false ? "127.0.0.1" : "192.0.2.1") } } as unknown as http.IncomingMessage;
  if (options.remote !== false) {
    request.headers.authorization = `Bearer ${credential.token}`;
    request.headers["x-rabiroute-agent-id"] = "agent-one";
    assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    assert.equal(getTrustedLanAgentSource(request), undefined);
  }
  let definition = route();
  let probes = 0;
  const responses: { status: number; body: any }[] = [];
  const context: AgentGroupFilesContext = {
    route: id => id === definition.id ? definition : undefined,
    jsonResponse: (_response, status, body) => { responses.push({ status, body }); },
    readFiles: async (endpoint, group, folder) => {
      probes++;
      assert.deepEqual(endpoint, { httpUrl: "http://127.0.0.1:3000", accessToken: "do-not-leak" });
      assert.equal(group, groupId);
      assert.equal(folder, options.query?.includes("folderId") ? "folder_1" : undefined);
      return page;
    }
  };
  return { authority, config, credential, request, context, responses, definition,
    replaceRoute: (next: GatewayDefinition) => { definition = next; }, count: () => probes,
    run: () => handleAgentGroupFiles(request, new URL(target, "http://localhost:8000"), { setHeader() {} } as unknown as http.ServerResponse, context) };
}

test("local and enabled authenticated Agents read group metadata by default without plan or primary bindings", async t => {
  for (const remote of [true, false]) {
    const value = fixture(t, { remote, query: `routeId=route-one&groupId=${groupId}&folderId=folder_1` });
    assert.equal(await value.run(), true);
    assert.equal(value.count(), 1);
    assert.deepEqual(value.responses, [{ status: 200, body: { code: 0,
      data: { routeId: "route-one", groupId, folderId: "folder_1", instanceId: "qq-one", ...page } } }]);
    assert.doesNotMatch(JSON.stringify(value.responses), /do-not-leak/);
  }
});

test("executable group-file contract validates the same bounded response and preserves authenticated/local access", async t => {
  for (const remote of [true, false]) {
    const value = fixture(t, { remote });
    const definition = createAgentGroupFilesOperation(value.context);
    const operation = compileApiOperation(definition);
    const response = { setHeader() {} } as unknown as http.ServerResponse;
    const input = await readApiOperationInput(operation, value.request, new URL(value.request.url!, "http://localhost:8000"), response);
    const result = await definition.handler(input);
    assert.equal(result.status, 200); validateApiOperationResult(operation, result);
    assert.equal(value.count(), 1);
    assert.doesNotMatch(JSON.stringify(result.body), /do-not-leak/);
    const invalid = new URL(value.request.url! + "&unknown=fixture", "http://localhost:8000");
    await assert.rejects(readApiOperationInput(operation, value.request, invalid, response), { code: "API_REQUEST_SCHEMA_INVALID" });
    assert.equal(value.count(), 1);
  }
});

test("omitted group restriction survives normalization and explicit allowed groups work for local and remote", async t => {
  for (const remote of [true, false]) {
    for (const policy of [undefined, {}, { readableGroupFileIds: undefined }, { readableGroupFileIds: [groupId] }]) {
      const value = fixture(t, { remote });
      value.definition.messageAdapterPolicies = policy === undefined ? undefined : { napcat: policy };
      value.replaceRoute(normalizeGatewayDefinition(value.definition));
      await value.run();
      assert.equal(value.count(), 1);
      assert.equal(value.responses[0].status, 200);
    }
  }
});

test("explicit group restrictions apply equally to local and remote and are not replaced by send permissions", async t => {
  for (const remote of [true, false]) {
    for (const policy of [[], ["999999"], [" 123456"], ["0123456"]]) {
      const value = fixture(t, { remote });
      value.definition.messageAdapterPolicies = { napcat: { readableGroupFileIds: policy, allowedFileRoots: ["/tmp"], outputEnabled: true } };
      value.definition.targetGroupId = groupId;
      await value.run();
      assert.equal(value.count(), 0);
      assert.equal(value.responses[0].status, 403);
      assert.equal(value.responses[0].body.errorCode, "QQ_GROUP_FILES_GROUP_NOT_ALLOWED");
      assert.match(value.responses[0].body.message, /messageAdapterPolicies\.napcat\.readableGroupFileIds/);
      assert.ok(value.responses[0].body.message.includes(JSON.stringify(policy)));
      delete value.definition.messageAdapterPolicies.napcat!.readableGroupFileIds;
      await value.run(); assert.equal(value.responses[1].status, 200); assert.equal(value.count(), 1);
    }
  }
});

test("forged Agent headers, source-only markers and nonlocal callers never reach upstream", async t => {
  for (const variant of ["nonlocal", "forged", "source"]) {
    const value = fixture(t, { remote: false, address: variant === "nonlocal" ? "192.0.2.1" : "127.0.0.1" });
    if (variant === "forged") value.request.headers["x-rabiroute-agent-id"] = "agent-one";
    if (variant === "source") setTrustedLanAgentSource(value.request, { nodeId: "node-one", agentId: "agent-one", provider: "dsh", sessionId: "fixture-session", sessionName: "Main" });
    await value.run();
    assert.equal(value.count(), 0);
    assert.equal(value.responses[0].status, 403);
  }
});

test("safe local fallback rejects proxy, hostile Host/Origin and cross-site fetch", async t => {
  for (const headers of [{ "x-forwarded-for": "192.0.2.1" }, { host: "remote.invalid" }, { origin: "http://remote.invalid" },
    { "sec-fetch-site": "cross-site" }, { "x-rabiroute-peer-proxy": "1" }, { "x-rabilink-resource-owner": "1" }]) {
    const value = fixture(t, { remote: false, headers });
    await value.run();
    assert.equal(value.count(), 0);
    assert.equal(value.responses[0].status, 403);
  }
});

test("valid principal is authoritative even when untrusted proxy markers are present", async t => {
  const value = fixture(t, { headers: { "x-rabiroute-peer-proxy": "1", "x-rabilink-tunnel-local": "1" } });
  await value.run();
  assert.equal(value.responses[0].status, 200);
});

test("revoked original principal cannot downgrade to loopback", async t => {
  const value = fixture(t, { address: "127.0.0.1" });
  value.authority.setNodeEnabled("node-one", false);
  delete value.request.headers["x-rabiroute-agent-id"];
  await value.run();
  assert.equal(value.count(), 0);
  assert.equal(value.responses[0].status, 403);
});

test("query must be exact and bodyless; unavailable Route, ambiguous and unsafe instances fail before read", async t => {
  for (const query of [`routeId=other&groupId=${groupId}`, `routeId=route-one&groupId=${groupId}&offset=1`,
    `routeId=route-one&groupId=${groupId}&groupId=${groupId}`, `routeId=route-one&groupId=${groupId}&folderId=../evil`, "routeId=route-one&groupId=001"]) {
    const value = fixture(t, { query });
    await value.run();
    assert.equal(value.count(), 0);
    assert.ok(value.responses[0].status >= 400);
  }
  for (const variant of ["body", "disabled", "napcat-disabled", "ambiguous", "unsafe"]) {
    const value = fixture(t);
    if (variant === "body") value.request.headers["content-length"] = "2";
    if (variant === "disabled") value.definition.enabled = false;
    if (variant === "napcat-disabled") value.definition.messageAdapters = ["heartbeat"];
    if (variant === "ambiguous") value.definition.napcatInstances!.push({ ...value.definition.napcatInstances![0], id: "second" });
    if (variant === "unsafe") value.definition.napcatInstances![0]!.httpUrl = "file:///unsupported";
    await value.run();
    assert.equal(value.count(), 0);
    assert.ok(value.responses[0].status >= 400);
  }
});

test("user configured LAN and HTTPS NapCat endpoints remain available", async t => {
  for (const httpUrl of ["http://192.0.2.5:3000", "https://napcat.example:8443"]) {
    const value = fixture(t);
    value.definition.napcatInstances![0]!.httpUrl = httpUrl;
    let called = false;
    value.context.readFiles = async endpoint => { called = true; assert.equal(endpoint.httpUrl, httpUrl); return page; };
    await value.run();
    assert.equal(value.responses[0].status, 200); assert.equal(called, true);
  }
});

test("authenticated Relay or Peer reads group files without a second source grant", async t => {
  for (const header of ["x-rabilink-tunnel-local", "x-rabiroute-peer-proxy"]) {
    const value = fixture(t, { remote: false, address: "192.0.2.2", headers: { [header]: "1" } });
    let revoked = false;
    markAuthenticatedConnectionRequest(value.request, () => { if (revoked) throw new Error("revoked"); });
    await value.run(); assert.equal(value.responses[0].status, 200);
    revoked = true;
    await value.run(); assert.equal(value.responses[1].status, 403); assert.equal(value.count(), 1);
  }
});

test("revocation, credential rotation and node/global ABA while awaiting upstream suppress all metadata", async t => {
  for (const variant of ["disable", "node-aba", "global-aba", "credential"]) {
    const value = fixture(t, { address: "127.0.0.1" });
    let finish!: (result: typeof page) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    value.context.readFiles = () => { started(); return new Promise<typeof page>(resolve => { finish = resolve; }); };
    const operation = value.run();
    await waiting;
    if (variant === "global-aba") {
      value.config.patch({ webguiLan: { enabled: false } });
      value.config.patch({ webguiLan: { enabled: true } });
    } else if (variant === "credential") {
      value.authority.revokeNode("node-one");
      const replacement = value.authority.enroll(value.authority.issueBootstrapTicket().ticket, "node-one");
    } else {
      value.authority.setNodeEnabled("node-one", false);
      if (variant === "node-aba") {
        value.authority.setNodeEnabled("node-one", true);
        assert.ok(value.authority.authenticate(value.request.headers.authorization!.toString().replace(/^Bearer /, "")), "Restored node accepts fresh authentication while the original request lease remains revoked.");
      }
    }
    delete value.request.headers["x-rabiroute-agent-id"];
    finish(page);
    await operation;
    assert.deepEqual(value.responses, [{ status: 403, body: { code: -1, errorCode: "QQ_GROUP_FILES_NOT_AUTHORIZED" } }]);
  }
});

test("ACL and in-place Route/endpoint reconfiguration while reading cannot disclose stale metadata", async t => {
  for (const remote of [true, false]) {
    for (const variant of ["acl", "enabled", "napcat", "id", "httpUrl", "accessToken", "ambiguous"]) {
      const value = fixture(t, { remote });
      value.context.readFiles = async () => {
        if (variant === "acl") value.definition.messageAdapterPolicies = { napcat: { readableGroupFileIds: [] } };
        if (variant === "enabled") value.definition.enabled = false;
        if (variant === "napcat") value.definition.messageAdapters = ["heartbeat"];
        if (variant === "id" || variant === "httpUrl" || variant === "accessToken") value.definition.napcatInstances![0]![variant] = "changed";
        if (variant === "ambiguous") value.definition.napcatInstances!.push({ ...value.definition.napcatInstances![0], id: "second" });
        return page;
      };
      await value.run();
      assert.equal(value.responses[0].status, 403, `${remote}:${variant}`);
      assert.equal(value.responses[0].body.data, undefined);
    }
  }
});

test("fresh equivalent Route snapshot is allowed; public admission is not object-reference identity", async t => {
  const value = fixture(t);
  value.context.readFiles = async () => { value.replaceRoute(route()); return page; };
  await value.run();
  assert.equal(value.responses[0].status, 200);
});

test("upstream error hides token and private error payload", async t => {
  const value = fixture(t);
  value.context.readFiles = async () => { throw new Error("do-not-leak private content"); };
  await value.run();
  assert.equal(value.responses[0].status, 503);
  assert.doesNotMatch(JSON.stringify(value.responses[0].body), /do-not-leak|private content/);
});
