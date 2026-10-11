import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type http from "node:http";
import { handleAgentGroupFiles, type AgentGroupFilesContext } from "./agentGroupFiles.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

const groupId = "123456";
const route = (): GatewayDefinition => ({
  id: "route-one", gatewayPort: 8789, enabled: true, messageAdapters: ["napcat"],
  agentAdapters: ["dsh"], primaryAgentAdapter: "dsh",
  primaryAgentTarget: "remote:other-node:other-agent",
  remoteAgentTargets: [{ id: "remote:other-node:other-agent", instanceId: "other-node", agentId: "other-agent", provider: "dsh" }],
  messageAdapterPolicies: { napcat: { readableGroupFileIds: [groupId] } },
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
  authority.registerAgentCatalog(credential.token, [{ agentId: "agent-one", provider: "custom-provider" }]);
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
    approvedBinding: () => { throw new Error("obsolete primary gate"); },
    isAgentEnabled: () => { throw new Error("obsolete source gate"); },
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

test("enabled authenticated custom provider needs no plan source or matching primary to read allowed group", async t => {
  for (const remote of [true, false]) {
    const value = fixture(t, { remote, query: `routeId=route-one&groupId=${groupId}&folderId=folder_1` });
    assert.equal(await value.run(), true);
    assert.equal(value.count(), 1);
    assert.deepEqual(value.responses, [{ status: 200, body: { code: 0,
      data: { routeId: "route-one", groupId, folderId: "folder_1", instanceId: "qq-one", ...page } } }]);
    assert.doesNotMatch(JSON.stringify(value.responses), /do-not-leak/);
  }
});

test("group business ACL applies equally to local and remote, never inferred from target or send roots", async t => {
  for (const remote of [true, false]) {
    for (const policy of [undefined, [], ["999999"]]) {
      const value = fixture(t, { remote });
      value.definition.messageAdapterPolicies = { napcat: { readableGroupFileIds: policy, allowedFileRoots: ["/tmp"], outputEnabled: true } };
      value.definition.targetGroupId = groupId;
      await value.run();
      assert.equal(value.count(), 0);
      assert.deepEqual(value.responses, [{ status: 403, body: { code: -1, errorCode: "QQ_GROUP_FILES_GROUP_NOT_ALLOWED" } }]);
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
  value.authority.setAgentEnabled("node-one", "agent-one", false);
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
    if (variant === "unsafe") value.definition.napcatInstances![0]!.httpUrl = "http://example.com";
    await value.run();
    assert.equal(value.count(), 0);
    assert.ok(value.responses[0].status >= 400);
  }
});

test("revocation, credential rotation and Agent/global ABA while awaiting upstream suppress all metadata", async t => {
  for (const variant of ["disable", "agent-aba", "global-aba", "credential"]) {
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
      value.authority.registerAgentCatalog(replacement.token, [{ agentId: "agent-one", provider: "custom-provider" }]);
    } else {
      value.authority.setAgentEnabled("node-one", "agent-one", false);
      if (variant === "agent-aba") value.authority.setAgentEnabled("node-one", "agent-one", true);
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
        if (variant === "acl") value.definition.messageAdapterPolicies!.napcat!.readableGroupFileIds = [];
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
