import test from "node:test";
import assert from "node:assert/strict";
import { createTimeoutSettings } from "../lib/timeout-settings.mjs";
import { createManagerClient } from "../lib/manager-client.mjs";
import { createEndpointSession } from "../lib/endpoint-session.mjs";
import { CodexDesktopIpcClient } from "../lib/codex-desktop-ipc.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("timeout snapshots isolate targets, isolate invalid durations and reset defaults", t => {
  const diagnostics = []; t.mock.method(console, "warn", value => diagnostics.push(value));
  const one = createTimeoutSettings({ "agent.client.request": 25 });
  const two = createTimeoutSettings();
  assert.equal(one.get("agent.client.request", 100), 25);
  assert.equal(two.get("agent.client.request", 100), 100);
  for (const value of [0, -1, 1.5, 2147483648, "20"]) {
    one.adopt({ timeoutOverrides: { x: value, "agent.client.request": 25 } });
    assert.equal(one.get("x", 700), 700);
    assert.equal(one.get("agent.client.request", 100), 25);
  }
  assert.equal(one.get("agent.client.request", 100), 25);
  assert.equal(diagnostics.length, 5);
  one.adopt({});
  assert.equal(one.get("agent.client.request", 100), 100);
});

test("Desktop IPC observes the configured budget and releases a timed-out pending request", async () => {
  const settings = createTimeoutSettings({ "agent.desktop.ipc": 10 });
  const client = new CodexDesktopIpcClient({ timeout: (key, fallback) => settings.get(key, fallback) });
  client.socket = { writable: true, write() {} };
  await assert.rejects(client.request("fixture-read", {}, 1, true), /timed out/);
  assert.equal(client.pending.size, 0);
});

test("verified settings persist through the endpoint owner and clear when removed", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-timeout-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const config = { managerUrl: "http://manager.invalid", managerGuid: "stable", nodeId: "node", nodeCredential: "fixture" };
  fs.writeFileSync(configPath, JSON.stringify(config));
  let overrides = { "agent.client.discovery": 12345 };
  const identity = { guid: "stable", applicationGenerationId: "generation", managerInstanceId: "instance" };
  const session = createEndpointSession({ config, configPath, fetchImpl: async url => {
    if (url.endsWith("/.well-known/rabiroute-manager")) return Response.json({ code: 0, data: { ...identity, protocolVersion: 1 } });
    if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: "node" } });
    return Response.json({ ...identity, rabiGuid: "stable", timeoutOverrides: overrides,
      health: { live: true, requiredReady: true, state: "healthy" } });
  } });
  await session.ensure();
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).timeoutOverridesCache, overrides);
  overrides = {};
  await session.ensure();
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).timeoutOverridesCache, {});
  assert.equal(JSON.parse(fs.readFileSync(configPath)).nodeCredential, "fixture");
});

test("verified Manager timeout controls response body and preserves uncertain mutations", async () => {
  const meta = { applicationGenerationId: "test-generation", managerInstanceId: "test-instance",
    health: { live: true, requiredReady: true, state: "healthy" }, timeoutOverrides: { "agent.client.request": 25 } };
  let writes = 0;
  const client = createManagerClient({ managerUrl: "http://manager.invalid", credential: "test-only", timeoutMs: 1000,
    fetchImpl: async url => {
      if (new URL(url).pathname === "/meta") return Response.json(meta);
      writes++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }),
        { headers: { "content-type": "application/json" } });
    } });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const result = await client.invoke("PATCH", "/test", { body: {} });
    assert.equal(result.transportError, "CANCELLED");
    assert.equal(result.uncertain, true);
    assert.equal(writes, 1);
  } finally { clearTimeout(keepAlive); }
});

test("bad duration does not prevent verified endpoint requests or leak into another connection", async t => {
 const diagnostics=[];t.mock.method(console,"warn",value=>diagnostics.push(value));
 const initial={good:600000,bad:0};const cached=createTimeoutSettings(initial);
 initial.good=1;assert.equal(cached.get("good",100),600000);assert.equal(cached.get("bad",100),100);
 const meta={applicationGenerationId:"fixture-app",managerInstanceId:"fixture-manager",health:{live:true,state:"degraded",requiredReady:false},timeoutOverrides:{"agent.client.request":5000,bad:"private-bad-value"}};
 let requests=0;const client=createManagerClient({managerUrl:"http://fixture.invalid",credential:"fixture-only",fetchImpl:async url=>{
   if(new URL(url).pathname==="/meta")return Response.json(meta);requests++;return Response.json({code:0});
 }});
 assert.equal((await client.request("GET","/api/fixture")).ok,true);assert.equal(requests,1);
 assert.equal(createTimeoutSettings().get("agent.client.request",100),100);
 for(const value of [null,[],false,"bad"]){const settings=createTimeoutSettings(value);assert.equal(settings.get("good",100),100);}
 assert.ok(diagnostics.length>=6);assert.equal(diagnostics.join("\n").includes("private-bad-value"),false);
});
