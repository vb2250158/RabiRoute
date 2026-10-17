import test from "node:test";
import assert from "node:assert/strict";
import { discoverGrokBotAgent } from "./grokBotDiscovery.js";
import { GrokBotClient, decodeGrokBotSessionId } from "./grokBotClient.js";
import { getGrokBotStatus } from "./grokBotManagerApi.js";

test("explicit discovery maps only native sessions, names from Bot owner and supports paging", async () => {
  const calls: string[] = [];
  const client = new GrokBotClient({ readProfile: async () => ({ signedIn: true, accountScope: "fixture", accessToken: "fixture" }), request: async (input, init) => {
    const method = String(input).split("/").at(-1)!; calls.push(method);
    const body = JSON.parse(String(init?.body));
    if (method === "ListGrokBotAgents") return Response.json({ agents: [{ agentId: "fixture-owner", name: "Owner supplied name" }] });
    return Response.json({ sessions: Array.from({ length: 105 }, (_, index) => ({ agentId: body.agentId, sessionId: "session-" + index, updatedAtMs: String(index) })) });
  } });
  const first = await discoverGrokBotAgent({ client, agentId: "fixture-owner", limit: 100 });
  const second = await discoverGrokBotAgent({ client, agentId: "fixture-owner", limit: 100, offset: 100 });
  assert.equal(first.sessions.length, 100);
  assert.equal(first.sessionPage.hasMore, true);
  assert.equal(second.sessions.length, 5);
  assert.equal(second.sessionPage.hasMore, false);
  assert.equal(new Set([...first.sessions, ...second.sessions].map(session => session.id)).size, 105);
  assert.equal(first.sessions[0].name, "Owner supplied name");
  assert.equal(decodeGrokBotSessionId(first.sessions[0].id).agentId, "fixture-owner");
  assert.equal(calls.some(method => /Create|Send|Automation/.test(method)), false);
});
test("status is local auth only and never performs a roster/session scan", async () => {
  const client = new GrokBotClient({ readProfile: async () => ({ signedIn: true, accountScope: "fixture", accessToken: "fixture" }),
    request: async () => { throw new Error("status must not call network"); } });
  assert.equal((await getGrokBotStatus({ client })).status, "signed-in");
});

test("room discovery returns native kind, members and canonical main without private session lookup", async () => {
  const client = new GrokBotClient({ readProfile: async () => ({ signedIn: true, accountScope: "fixture", accessToken: "fixture" }),
    request: async input => {
      assert.equal(String(input).split("/").at(-1), "ListGrokBotAgents");
      return Response.json({ agents: [{ agentId: "room", name: "Room", kind: "ROOM", memberAgentIds: ["member"] }] });
    } });
  const result = await discoverGrokBotAgent({ client });
  assert.equal(result.healthy, true);
  assert.equal(result.sessions[0].kind, "ROOM");
  assert.equal(result.sessions[0].nativeAgentId, "room");
  assert.equal(result.bots[0].mainSessionId, result.sessions[0].id);
  assert.ok(result.profilePath.endsWith("Grok Bot"));
  assert.deepEqual(result.sessions[0].memberAgentIds, ["member"]);
  assert.deepEqual(decodeGrokBotSessionId(result.sessions[0].id), { agentId: "room", sessionId: "", defaultMain: true });
});
test("discovery errors are actionable and cannot expose arbitrary credential text", async () => {
  const client = new GrokBotClient({ readProfile: async () => { throw new Error("private-token-should-not-escape"); } });
  const result = await discoverGrokBotAgent({ client });
  assert.equal(result.status, "unavailable");
  assert.equal(result.healthy, false);
  assert.ok(!JSON.stringify(result).includes("private-token-should-not-escape"));
  assert.ok(result.warnings.length > 0);
});
test("discovery account switch cannot merge owner lists from different accounts", async () => {
  let switched = false;
  const calls: string[] = [];
  const client = new GrokBotClient({ readProfile: async () => ({ signedIn: true, accountScope: switched ? "changed" : "original", accessToken: "fixture" }),
    request: async input => {
      calls.push(String(input).split("/").at(-1)!);
      switched = true;
      return Response.json({ agents: [{ agentId: "fixture-owner", name: "Fixture Bot" }] });
    } });
  const result = await discoverGrokBotAgent({ client, agentId: "fixture-owner" });
  assert.equal(result.healthy, false);
  assert.equal(result.errorCode, "GROK_BOT_ACCOUNT_CHANGED");
  assert.equal(result.sessions.length, 0);
  assert.deepEqual(calls, ["ListGrokBotAgents"]);
});
test("unverified discovery origin returns a closed actionable failure before authentication", async () => {
  let requests = 0;
  const result = await discoverGrokBotAgent({ backendUrl: "https://unverified.invalid/", request: async () => {
    requests += 1; return Response.json({});
  } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "GROK_BOT_BACKEND_MISMATCH");
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(result).includes("unverified.invalid"), false);
});
