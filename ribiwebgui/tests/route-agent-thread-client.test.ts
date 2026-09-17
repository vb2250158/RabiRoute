import assert from "node:assert/strict";
import test from "node:test";
import { postRouteAgentThreadAction } from "../src/routeAgentThreadClient";
import { remoteAgentTargetKey, type RouteAgentTarget } from "../../src/shared/routeAgentTargets";

function remote(instanceId: string): RouteAgentTarget {
  const binding = { instanceId, agentId: "codex" };
  return { id: remoteAgentTargetKey(binding), provider: "codex", binding };
}
test("same-provider operations address local and each remote owner independently", async () => {
  const calls: Array<{ url: string; body?: any }> = [];
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/webgui-access") return Response.json({ data: { token: "test-token" } });
    const data = { thread: { id: "task-result" } };
    return Response.json(url === "/api/agent/threads" ? { code: 0, ...data } : { code: 0, result: { statusCode: 200, data } });
  }) as typeof fetch;
  const options = { fetch: request, accessToken: () => "" };
  await postRouteAgentThreadAction({ action: "read", agentAdapter: "codex" }, undefined, options);
  assert.equal((await postRouteAgentThreadAction({ action: "read" }, remote("computer-a"), options)).thread.id, "task-result");
  await postRouteAgentThreadAction({ action: "resolve" }, remote("computer-b"), options);
  assert.deepEqual(calls.filter(call => call.body).map(call => call.url), ["/api/agent/threads", "/api/lan-agent/instances/computer-a/agents/codex/threads", "/api/lan-agent/instances/computer-b/agents/codex/threads"]);
  assert.equal(calls.at(-1)?.body.agentAdapter, "codex");
  assert.equal(calls[0]?.body.agentTargetId, "local:codex", "local selection must disable remote owner inference");
});

test("remote owner failure never falls back to local and does not retry", async () => {
  const calls: string[] = [];
  const request = (async (url: string) => {
    calls.push(url);
    return Response.json(url === "/api/webgui-access" ? { data: { token: "test-token" } } : { code: 0, result: { statusCode: 503, data: { message: "owner offline" } } });
  }) as typeof fetch;
  await assert.rejects(postRouteAgentThreadAction({ action: "resolve" }, remote("computer-a"), { fetch: request, accessToken: () => "" }), /owner offline/);
  assert.equal(calls.length, 2);
  assert.equal(calls.includes("/api/agent/threads"), false);
});
