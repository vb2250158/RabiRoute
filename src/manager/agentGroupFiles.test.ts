import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";
import { handleAgentGroupFiles, type AgentGroupFilesContext } from "./agentGroupFiles.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { remoteAgentTargetKey } from "../shared/routeAgentTargets.js";

const groupId = "123456";
const sessionId = "session-11111111-1111-1111-1111-111111111111";
const route = (changes: Partial<GatewayDefinition> = {}): GatewayDefinition => ({
  id: "route-one", gatewayPort: 8789, enabled: true, messageAdapters: ["napcat"],
  agentAdapters: ["dsh"], primaryAgentAdapter: "dsh", dshSessionId: sessionId,
  remoteAgentTargets: [{ id: remoteAgentTargetKey({ instanceId: "node-one", agentId: "agent-one" }), instanceId: "node-one", agentId: "agent-one", provider: "dsh" }],
  primaryAgentTarget: remoteAgentTargetKey({ instanceId: "node-one", agentId: "agent-one" }),
  messageAdapterPolicies: { napcat: { readableGroupFileIds: [groupId] } },
  napcatInstances: [{ id: "qq-one", enabled: true, gatewayPort: 8789, httpUrl: "http://127.0.0.1:3000", accessToken: "do-not-leak" }],
  ...changes
});
const page = { files: [], folders: [], completenessUnknown: true as const, potentiallyTruncated: true as const, projectionTruncated: false };
async function run(changes: Partial<GatewayDefinition> = {}, query = `routeId=route-one&groupId=${groupId}`, trusted = true, overrides: Partial<AgentGroupFilesContext> = {}, headers: Record<string, string> = {}) {
  const request = { method: "GET", headers } as unknown as http.IncomingMessage;
  if (trusted) setTrustedLanAgentSource(request, { nodeId: "node-one", agentId: "agent-one", provider: "dsh", sessionId, sessionName: "Main" });
  const responses: { status: number; body: any }[] = [];
  let probes = 0;
  const definition = route(changes);
  const context: AgentGroupFilesContext = {
    route: id => id === "route-one" ? definition : undefined,
    approvedBinding: () => ({ provider: "dsh", sessionId }), isAgentEnabled: () => true,
    jsonResponse: (_response, status, body) => { responses.push({ status, body }); },
    readFiles: async () => { probes++; return page; }, ...overrides
  };
  const response = { setHeader() {} } as unknown as http.ServerResponse;
  const handled = await handleAgentGroupFiles(request, new URL(`http://localhost/api/agent/qq/group-files?${query}`), response, context);
  return { handled, probes, result: responses[0]! };
}

test("trusted LAN identity, exact Route, approved primary and explicit group ACL all gate before probe", async () => {
  for (const item of [
    await run({}, undefined, false),
    await run({}, `routeId=other&groupId=${groupId}`),
    await run({}, `routeId=route-one&groupId=999999`),
    await run({ messageAdapterPolicies: { napcat: { allowedFileRoots: ["/tmp"], outputEnabled: true } }, targetGroupId: groupId }),
    await run({ enabled: false }),
    await run({ napcatInstances: [{ id: "one", gatewayPort: 8789, httpUrl: "http://127.0.0.1:3000" }, { id: "two", gatewayPort: 8790, httpUrl: "http://127.0.0.1:3001" }] }),
    await run({}, undefined, true, { approvedBinding: () => ({ provider: "dsh", sessionId: "another" }) }),
    await run({}, undefined, true, { isAgentEnabled: () => false }),
    await run({}, undefined, true, { route: () => route({ primaryAgentAdapter: "codex", primaryAgentTarget: "local:codex", agentAdapters: ["codex"], codexThreadId: "11111111-1111-1111-1111-111111111111" }) })
  ]) {
    assert.equal(item.handled, true);
    assert.equal(item.probes, 0);
    assert.notEqual(item.result.status, 200);
  }
});

test("query must be exact and bodyless; unsafe OneBot URL cannot receive token", async () => {
  for (const query of [`routeId=route-one&groupId=${groupId}&offset=1`, `routeId=route-one&groupId=${groupId}&groupId=${groupId}`, `routeId=route-one&groupId=${groupId}&folderId=../evil`, `routeId=route-one&groupId=001`]) {
    assert.equal((await run({}, query)).probes, 0);
  }
  assert.equal((await run({}, undefined, true, {}, { "content-length": "2" })).probes, 0);
  assert.equal((await run({ napcatInstances: [{ id: "qq-one", gatewayPort: 8789, httpUrl: "http://example.com", accessToken: "do-not-leak" }] })).probes, 0);
});

test("authorized single-directory call returns explicit uncertain completeness", async () => {
  const result = await run({}, `routeId=route-one&groupId=${groupId}&folderId=folder_1`);
  assert.equal(result.probes, 1);
  assert.equal(result.result.status, 200);
  assert.equal(result.result.body.data.folderId, "folder_1");
  assert.equal(result.result.body.data.completenessUnknown, true);
  assert.equal(result.result.body.data.potentiallyTruncated, true);
});

test("revocation during upstream read never releases metadata", async () => {
  let allowed = true;
  const result = await run({}, undefined, true, {
    isAgentEnabled: () => allowed,
    readFiles: async () => { allowed = false; return page; }
  });
  assert.equal(result.probes, 0);
  assert.equal(result.result.status, 403);
});

test("upstream error hides token and private error payload", async () => {
  const result = await run({}, undefined, true, { readFiles: async () => { throw new Error("do-not-leak private content"); } });
  assert.equal(result.result.status, 503);
  assert.doesNotMatch(JSON.stringify(result.result.body), /do-not-leak|private content/);
});
