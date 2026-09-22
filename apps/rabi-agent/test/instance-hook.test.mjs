import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestInstanceHook } from "../lib/instance-hook.mjs";

const meta = { applicationGenerationId: "generation-fixture", managerInstanceId: "instance-fixture", health: { live: true, state: "healthy", requiredReady: true } };
async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-hook-"));
  const configPath = path.join(directory, "config.json");
  const config = { managerUrl: "http://manager.test:54321", nodeId: "instance-a", nodeCredential: "fixture-only", agents: [{ agentId: "agent-b", sessionId: "session-b", managedSessionIds: ["child-session"], enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  try { await run(configPath, config); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("Hook checks metadata around own context, injects installed API guide only into registered session", async () => fixture(async configPath => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(String(url).endsWith("/meta") ? meta : { code: 0, data: { additionalContext: "fixture-context", action: "context" } });
  };
  for (const input of [{ session_id: "unrelated" }, {}, { session_id: "session-b", sessionId: "other" }]) assert.equal(await requestInstanceHook(input, configPath, fetcher), undefined);
  assert.equal(requests.length, 0);
  const result = await requestInstanceHook({ session_id: "session-b", hook_event_name: "SessionStart" }, configPath, fetcher);
  assert.match(result.additionalContext, /^fixture-context/);
  assert.match(result.additionalContext, /rabi-agent-launcher\.mjs/);
  assert.match(result.additionalContext, /\/api\/lan-agent\/capabilities/);
  assert.match(result.additionalContext, /\/api\/lan-agent\/resources/);
  assert.match(result.additionalContext, /session-b/);
  assert.match(result.additionalContext, /download --output "ABSOLUTE_LOCAL_ZIP_PATH".*outside the installation and under an existing parent directory/);
  assert.match(result.additionalContext, /direct user request/);
  assert.match(result.additionalContext, /\.mac or \.ps1.*not permission to execute/);
  assert.equal(result.additionalContext.includes("fixture-only"), false);
  assert.equal(requests[1].url, "http://manager.test:54321/api/lan-agent/instances/instance-a/agents/agent-b/context");
  assert.equal(requests.length, 3);
  for (const { init } of requests) { assert.equal(init.headers.authorization, "Bearer fixture-only"); assert.equal(init.headers["x-rabiroute-agent-id"], "agent-b"); assert.equal(init.redirect, "error"); }
  assert.equal(JSON.parse(requests[1].init.body).session_id, "session-b");
}));

test("Hook preserves Manager deny exactly and never weakens permission fields", async () => fixture(async configPath => {
  const decision = { action: "deny", additionalContext: "blocked", reason: "fixture-policy", hookSpecificOutput: { permissionDecision: "deny" } };
  const result = await requestInstanceHook({ session_id: "child-session" }, configPath, async url => Response.json(String(url).endsWith("/meta") ? meta : { code: 0, data: decision }));
  assert.deepEqual(result, decision);
}));

test("Hook rejects disabled, shared-token, ambiguous and changing Manager identities", async () => fixture(async (configPath, config) => {
  let calls = 0;
  const fetcher = async url => { calls++; return Response.json(String(url).endsWith("/meta") ? { ...meta, applicationGenerationId: calls === 1 ? "first" : "changed" } : { code: 0, data: {} }); };
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, fetcher), /uncertain/);
  assert.equal(calls, 3);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, nodeCredential: undefined, lanLinkToken: "fixture-legacy" }));
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, fetcher), /re-enroll/);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, agents: [{ ...config.agents[0], enabled: false }] }));
  assert.equal(await requestInstanceHook({ session_id: "session-b" }, configPath, fetcher), undefined);
  assert.equal(calls, 3);
  fs.writeFileSync(configPath, JSON.stringify(config));
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, async url => Response.json(String(url).endsWith("/meta") ? meta : { code: 403 }, { status: String(url).endsWith("/meta") ? 200 : 403 })), /Hook failed/);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, agents: [...config.agents, { ...config.agents[0], agentId: "duplicate" }] }));
  assert.equal(await requestInstanceHook({ session_id: "session-b" }, configPath, fetcher), undefined);
  assert.equal(calls, 3);
}));

test("Hook rejects unhealthy metadata, policy errors and timeout without replay", async () => fixture(async configPath => {
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, async () => Response.json({ health: { state: "starting", requiredReady: false } })), /not ready/);
  let mutations = 0;
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, async url => {
    if (String(url).endsWith("/meta")) return Response.json(meta);
    mutations++;
    throw new DOMException("fixture timeout", "TimeoutError");
  }), /uncertain/);
  assert.equal(mutations, 1);
  await assert.rejects(requestInstanceHook({ session_id: "session-b" }, configPath, async url => Response.json(String(url).endsWith("/meta") ? meta : { code: 403 }, { status: String(url).endsWith("/meta") ? 200 : 403 })), /Hook failed/);
}));
