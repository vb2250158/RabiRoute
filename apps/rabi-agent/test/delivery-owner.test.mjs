import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DeliveryStore, canonicalJson } from "../lib/delivery-store.mjs";
import { DeliveryOwner } from "../lib/delivery-owner.mjs";
import { __test } from "../rabi-agent.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-"));
  return { root, file: path.join(root, "queue.sqlite"), configPath: path.join(root, "config.json") };
}
const intent = (intentId = "fixture-intent") => ({ intentId, agentType: "codex", sessionId: "source-session", request: {
  action: "send", deliveryId: intentId, sourceThreadId: "source-session", threadId: "target-session", agentAdapter: "codex", prompt: "Fixture transport message" } });
const response = (statusCode, data) => ({ ok: statusCode >= 200 && statusCode < 300, statusCode, body: JSON.stringify(data) });

test("canonical durable JSON preserves wire semantics for optional terminal result fields", () => {
  const body = { taskId: "fixture", status: "completed", error: undefined, nested: { missing: undefined, list: [undefined, "text"] } };
  assert.deepEqual(JSON.parse(canonicalJson(body)), JSON.parse(JSON.stringify(body)));
});

test("durable receipt survives a killed writer; same ID conflicts never overwrite content", t => {
  const { file } = fixture(t);
  const module = new URL("../lib/delivery-store.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {DeliveryStore} from ${JSON.stringify(module)}; const store=new DeliveryStore(process.argv[1]);store.submit('a','agent-delivery',{text:'original'});store.update('a','sending');process.exit(17);`, file]);
  assert.equal(child.status, 17, child.stderr.toString());
  const store = new DeliveryStore(file); t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  assert.equal(store.get("a").state, "unknown");
  assert.equal(store.submit("a", "agent-delivery", { text: "original" }).state, "unknown");
  assert.throws(() => store.submit("a", "agent-delivery", { text: "changed" }), /CONFLICT/);
  assert.equal(store.raw("a").payload.text, "original");
});

test("capacity refuses new acceptance, preserves accepted records and paginates without payload", t => {
  const { file } = fixture(t), store = new DeliveryStore(file, { maxPending: 2 }); t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  store.submit("a", "agent-delivery", { text: "private" }); store.submit("b", "agent-delivery", { text: "two" });
  assert.throws(() => store.submit("c", "agent-delivery", {}), /QUEUE_FULL/);
  const first = store.list({ limit: 1 }), second = store.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(first.items[0].intentId, "a"); assert.equal(second.items[0].intentId, "b");
  assert.equal(first.items[0].payload, undefined); assert.equal(first.counts.pending, 2);
});

test("unknown POST only queries original ID until explicit unreserved evidence; changed identity never replays", async t => {
  const { file, configPath } = fixture(t); let now = 1000, mode = "unknown", posts = 0; const calls = [];
  const store = new DeliveryStore(file, { now: () => now });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, random: () => 0, client: () => ({ request: async (method, target, options) => {
    calls.push({ method, target });
    if (method === "POST") { posts++; assert.equal(options.body.deliveryId, "fixture-intent"); return { ...response(202, { status: "delivery_unconfirmed" }), uncertain: true }; }
    if (mode === "unreserved") return response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true });
    if (mode === "changed") return { ...response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true }), identityChanged: true };
    return response(404, { errorCode: "NOT_FOUND" });
  } }) }); t.after(async () => { await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  owner.submit(intent()); await owner.flight; assert.equal(posts, 1); assert.equal(store.get("fixture-intent").state, "unknown");
  now += 10000; await owner.tick(); assert.equal(posts, 1);
  mode = "changed"; now += 10000; await owner.tick(); assert.equal(posts, 1);
  mode = "unreserved"; now += 10000; await owner.tick(); assert.equal(posts, 2);
  assert.ok(calls.some(call => call.target === "/api/agent/deliveries/caller/fixture-intent"));
});

test("query recovers accepted receipt without sending another task; one blocked target does not starve another", async t => {
  const { file, configPath } = fixture(t); let now = 1000, posts = 0;
  const store = new DeliveryStore(file, { now: () => now });
  store.submit("recovered", "agent-delivery", { ...intent("recovered"), request: intent("recovered").request }, { managerGuid: "fixture-guid" }); store.update("recovered", "unknown");
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, client: () => ({ request: async (method, target, options) => {
    if (method === "GET") return response(200, { code: 0, data: { deliveryId: "internal", state: "committed", receipt: { accepted: true } } });
    posts++; return options.body.deliveryId === "blocked" ? response(403, { code: -1 }) : response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: "internal-2" } });
  } }) }); t.after(async () => { await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  owner.submit(intent("blocked")); owner.submit({ ...intent("good"), request: { ...intent("good").request, threadId: "other-target" } }); await owner.flight; await owner.tick();
  assert.equal(store.get("recovered").state, "delivered"); assert.equal(store.get("blocked").state, "blocked"); assert.equal(store.get("good").state, "delivered"); assert.equal(posts, 2);
});

test("runtime completion while disconnected persists until matching receiver ACK and survives restart", async t => {
  const { root, configPath } = fixture(t), config = { nodeId: "fixture-node", managerGuid: "fixture-guid", managerUrl: "http://manager.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath);
  runtime.stateStore.state.tasks.task = { status: "progress", managerGuid: config.managerGuid };
  runtime.publishDesktop = () => {}; runtime.taskByThread.set("thread", "task");
  runtime.handleDesktopBroadcast({ method: "thread-stream-state-changed", params: { threadId: "thread", change: { status: "completed" } } });
  const owner = runtime.deliveryOwner; await owner.flight;
  const record = owner.query().items[0]; assert.equal(owner.store.raw(record.intentId).kind, "task-result"); assert.notEqual(record.state, "received"); assert.equal(runtime.taskByThread.size, 0);
  await owner.close(); runtime.deliveryOwner = null;
  const recovered = new DeliveryOwner({ configPath, config, client: () => {}, sendEvent: () => false });
  assert.notEqual(recovered.query().items[0].state, "received");
  assert.equal(recovered.acknowledge({ eventId: record.intentId, taskId: "wrong" }), false);
  assert.equal(recovered.acknowledge({ eventId: record.intentId, taskId: "task" }), true);
  assert.equal(recovered.query().items[0].state, "received"); await recovered.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
});

test("public queue filtering runs before pagination and policy capacity is read from config", async t => {
  const { configPath, root } = fixture(t);
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxPending: 2 } }, client: () => ({ request: async () => { throw new Error("offline fixture"); } }), sendEvent: () => false });
  owner.paused = true;
  owner.store.submit("first", "agent-delivery", { ...intent("first"), request: intent("first").request });
  owner.store.submit("second", "agent-delivery", { ...intent("second"), request: { ...intent("second").request, threadId: "selected-target" } });
  owner.store.update("first", "blocked", { error: "invalid" });
  const page = owner.query({ state: "queued", query: "selected-target", limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, "second"); assert.equal(page.items[0].target.sessionId, "selected-target");
  assert.equal(page.nextCursor, null); assert.equal(page.items[0].ownerScope, "node"); assert.equal(page.items[0].payload, undefined);
  assert.throws(() => owner.store.submit("third", "agent-delivery", {}), /QUEUE_FULL/);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("disabled identity is blocked but observes original receipt after restoration without a second POST", async t => {
  const { file, configPath } = fixture(t); let now = 1000, allowed = false, posts = 0;
  const store = new DeliveryStore(file, { now: () => now });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, random: () => 0, client: () => ({ request: async method => {
    if (method === "POST") { posts++; return response(403, { code: -1 }); }
    return allowed ? response(200, { data: { state: "committed", deliveryId: "original-internal", receipt: { accepted: true } } }) : response(403, { code: -1 });
  } }) });
  owner.submit(intent()); await owner.flight; assert.equal(store.get("fixture-intent").state, "blocked");
  now += 10000; allowed = true; await owner.tick(); assert.equal(posts, 1); assert.equal(owner.query({ action: "get", intentId: "fixture-intent" }).item.state, "received");
  await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("cancelled records retain dedup evidence but release pending count and byte capacity", t => {
  const { file } = fixture(t), store = new DeliveryStore(file, { maxPending: 1, maxBytes: 300 });
  t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  store.submit("cancelled", "agent-delivery", { text: "first" }); store.update("cancelled", "cancelled");
  assert.equal(store.submit("next", "agent-delivery", { text: "second" }).state, "pending");
  assert.equal(store.get("cancelled").state, "cancelled"); assert.throws(() => store.submit("cancelled", "agent-delivery", { text: "different" }), /CONFLICT/);
});

test("bounded target concurrency starts a healthy target while another is unresolved and pause joins every flight", async t => {
  const { configPath, root } = fixture(t); let releaseSlow; let healthyStarted = false, sameTargetStarted = false, paused = false;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxConcurrency: 2, maxPerTarget: 1 } }, sendEvent: () => false,
    client: () => ({ request: async (_method, _path, options) => {
      if (options.body.deliveryId === "slow") await slow;
      if (options.body.deliveryId === "healthy") healthyStarted = true;
      if (options.body.deliveryId === "same-target") sameTargetStarted = true;
      return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: options.body.deliveryId } });
    } }) });
  owner.submit(intent("slow")); owner.submit({ ...intent("healthy"), request: { ...intent("healthy").request, threadId: "other-target" } }); owner.submit(intent("same-target"));
  for (let count = 0; count < 30 && !healthyStarted; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthyStarted, true, "healthy target must start before releasing the slow target"); assert.equal(sameTargetStarted, false);
  const drain = owner.pause().then(() => { paused = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(paused, false);
  releaseSlow(); await drain; assert.equal(paused, true); assert.equal(sameTargetStarted, false);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("all intent kinds freeze the original Manager GUID and reject another Manager or its ACK", async t => {
  const { configPath, root } = fixture(t); let identity = { nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid" }, now = 1000, posts = 0, events = 0;
  const owner = new DeliveryOwner({ configPath, config: identity, readIdentity: () => identity, now: () => now, sendEvent: () => { events++; },
    client: () => ({ request: async () => { posts++; return response(200, { status: "delivered", delivery: { status: "accepted" } }); } }) });
  owner.paused = true; owner.store.submit("legacy-unbound", "agent-delivery", { ...intent("legacy-unbound"), nodeId: "node" }); owner.store.update("legacy-unbound", "unknown");
  owner.paused = false; owner.submit(intent("original-agent")); owner.paused = true;
  const eventId = owner.enqueueResult({ type: "taskResult", taskId: "task", status: "completed" });
  identity = { ...identity, managerGuid: "manager-B", managerUrl: "http://b.invalid" }; owner.paused = false; await owner.tick();
  if (owner.flight) await owner.flight;
  assert.equal(posts, 0); assert.equal(events, 0); assert.equal(owner.store.get("original-agent").error, "DELIVERY_MANAGER_CHANGED");
  assert.equal(owner.store.get(eventId).error, "DELIVERY_MANAGER_CHANGED"); assert.equal(owner.store.get("legacy-unbound").error, "DELIVERY_ORIGINAL_MANAGER_UNKNOWN");
  assert.equal(owner.acknowledge({ eventId, taskId: "task" }), false);
  now += 10000; identity = { ...identity, managerGuid: "manager-A", managerUrl: "http://a.invalid" }; await owner.tick();
  assert.equal(events, 1); assert.equal(posts, 1); assert.equal(owner.acknowledge({ eventId, taskId: "task" }), true);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a legacy pending hint binds the first authenticated GUID before sending; padded IDs never enter the queue", async t => {
  const { configPath, root } = fixture(t); let identity = { nodeId: "node", managerUrl: "http://original.invalid", nodeCredential: "original-fixture-only" }, proved = false;
  const owner = new DeliveryOwner({ configPath, config: identity, readIdentity: () => identity, resolveManagerIdentity: async () => {
    identity = { ...identity, managerGuid: "verified-original" }; proved = true; return { guid: "verified-original" };
  }, sendEvent: () => false, client: () => ({ request: async () => {
    assert.equal(proved, true); assert.equal(owner.store.raw("fresh").manager_guid, "verified-original");
    return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: "internal" } });
  } }) });
  assert.throws(() => owner.submit(intent(" padded ")), /whitespace/);
  owner.submit(intent("fresh")); await owner.flight; assert.equal(owner.store.get("fresh").state, "delivered");
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

for (const ordering of ["target", "none"]) test(`SQL scheduling bounds payload materialization with 100 queued messages before a healthy target (${ordering})`, async t => {
  const { configPath, root } = fixture(t); let releaseSlow, healthy = false;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxConcurrency: 2, maxPerTarget: 1, ordering } },
    client: () => ({ request: async (_method, _path, options) => {
      if (options.body.threadId === "crowded") await slow; else healthy = true;
      return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: options.body.deliveryId } });
    } }), sendEvent: () => false });
  for (let index = 0; index < 100; index++) owner.store.submit("crowded-" + index, "agent-delivery",
    { ...intent("crowded-" + index), nodeId: "node", request: { ...intent("crowded-" + index).request, threadId: "crowded" } }, { managerGuid: "fixture-guid", targetKey: "crowded" });
  owner.store.submit("healthy-late", "agent-delivery", { ...intent("healthy-late"), nodeId: "node", request: { ...intent("healthy-late").request, threadId: "healthy" } }, { managerGuid: "fixture-guid", targetKey: "healthy" });
  const due = owner.store.due.bind(owner.store); let materialized = 0;
  owner.store.due = (...args) => { const rows = due(...args); materialized += rows.length; return rows; };
  owner.wake(); for (let count = 0; count < 30 && !healthy; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthy, true); assert.equal(materialized, 2, "only two available scheduling slots may materialize bodies");
  const paused = owner.pause(); releaseSlow(); await paused; await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("the actual runtime factory pins the row Manager when config changes after the owner check", async t => {
  const { configPath, root } = fixture(t), original = { schemaVersion: 1, nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid", nodeCredential: "fixture-only", agents: [],
    defaultWorkspace: root, allowedWorkspaces: [root], releasePublicKeySha256: "a".repeat(64) };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const runtime = new __test.RabiAgentRuntime(original, configPath); runtime.publishDesktop = () => {};
  const owner = runtime.startDeliveryOwner(); owner.paused = true;
  const check = owner.ensureManagerBinding.bind(owner);
  owner.ensureManagerBinding = async row => {
    const verified = await check(row);
    fs.writeFileSync(configPath, JSON.stringify({ ...original, managerGuid: "manager-B", managerUrl: "http://b.invalid" }));
    return verified;
  };
  owner.paused = false; owner.submit(intent("binding-race")); await owner.flight;
  assert.equal(owner.store.get("binding-race").attempts, 0, "changed config must fail before creating an HTTP attempt");
  assert.equal(owner.store.raw("binding-race").manager_guid, "manager-A");
  assert.throws(() => owner.client("codex", "source-session", "manager-A"), /Original delivery Manager changed/);
  await owner.close(); runtime.deliveryOwner = null; runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
});

test("a completion keeps its task's original Manager and a different socket cannot transmit or ACK it", async t => {
  const { configPath, root } = fixture(t), config = { nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath); runtime.publishDesktop = () => {}; runtime.connected = true; runtime.socketManagerGuid = "manager-B";
  const wire = []; runtime.sendRaw = event => { wire.push(event); return true; };
  runtime.stateStore.state.tasks.task = { status: "progress", managerGuid: "manager-A" }; runtime.taskByThread.set("thread", "task");
  fs.writeFileSync(configPath, JSON.stringify({ ...config, managerGuid: "manager-B", managerUrl: "http://b.invalid" }));
  assert.equal(runtime.send({ type: "progress", taskId: "task", summary: "original progress" }), false);
  runtime.handleDesktopBroadcast({ method: "thread-stream-state-changed", params: { threadId: "thread", change: { status: "completed" } } });
  const owner = runtime.deliveryOwner; await owner.flight;
  const record = owner.query().items[0];
  assert.equal(owner.store.raw(record.intentId).manager_guid, "manager-A"); assert.equal(runtime.stateStore.state.tasks.task.managerGuid, "manager-A"); assert.equal(wire.length, 0);
  runtime.handleManagerMessage(JSON.stringify({ type: "resultAck", eventId: record.intentId, taskId: "task" }));
  assert.notEqual(owner.store.get(record.intentId).state, "delivered");
  fs.writeFileSync(configPath, JSON.stringify(config)); owner.store.update(record.intentId, "unknown"); await owner.tick();
  assert.equal(wire.length, 0, "current config A alone cannot authorize sending through actual socket B");
  owner.store.update(record.intentId, "unknown"); runtime.socketManagerGuid = "manager-A"; await owner.tick();
  assert.equal(wire.length, 1); assert.equal(wire[0].eventId, record.intentId);
  runtime.handleManagerMessage(JSON.stringify({ type: "resultAck", eventId: record.intentId, taskId: "task" }));
  assert.equal(owner.store.get(record.intentId).state, "delivered");
  await owner.close(); runtime.deliveryOwner = null; runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
});

test("queued original task cannot execute after socket Manager changes and legacy origin stays blocked", async t => {
  const { configPath, root } = fixture(t), config = { nodeId: "node", managerGuid: "manager-B", managerUrl: "http://b.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath); runtime.publishDesktop = () => {}; runtime.connected = true; runtime.socketManagerGuid = "manager-B";
  let turns = 0; runtime.desktop.startTurn = () => { turns++; };
  await runtime.runTask({ taskId: "queued-A", threadId: "thread", message: "fixture" }, "manager-A");
  const owner = runtime.deliveryOwner; await owner.flight;
  const first = owner.query().items.find(item => owner.store.raw(item.intentId).payload.taskId === "queued-A");
  assert.equal(turns, 0); assert.equal(runtime.stateStore.state.tasks["queued-A"].managerGuid, "manager-A"); assert.equal(owner.store.raw(first.intentId).manager_guid, "manager-A");
  runtime.stateStore.state.tasks.legacy = { status: "progress" };
  runtime.send({ type: "taskResult", taskId: "legacy", status: "failed", error: "fixture" }); await owner.flight;
  const legacy = owner.query().items.find(item => owner.store.raw(item.intentId).payload.taskId === "legacy");
  assert.equal(owner.store.get(legacy.intentId).error, "DELIVERY_ORIGINAL_MANAGER_UNKNOWN");
  const firstId = owner.enqueueResult({ type: "taskResult", taskId: "proven-legacy", status: "completed" }, "manager-A");
  const replayId = owner.enqueueResult({ type: "taskResult", taskId: "proven-legacy", status: "completed" }, null);
  assert.equal(replayId, firstId); assert.equal(owner.store.raw(replayId).manager_guid, "manager-A");
  await owner.close(); runtime.deliveryOwner = null; runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
});

for (const changed of ["origin", "credential"]) test(`first GUID resolution cannot rebind a pending intent after ${changed} changes`, async t => {
 const {configPath,root}=fixture(t);let now=1000,posts=0,switched=true;
 const original={nodeId:"node",managerUrl:"http://original.invalid",nodeCredential:"original-fixture"};let identity={...original};
 const owner=new DeliveryOwner({configPath,config:original,readIdentity:()=>identity,now:()=>now,random:()=>0,
  resolveManagerIdentity:async()=>{
   await new Promise(resolve=>setImmediate(resolve));
   identity=switched ? {...original,...(changed==="origin"?{managerUrl:"http://replacement.invalid"}:{nodeCredential:"replacement-fixture"}),managerGuid:"replacement-guid"} : {...original,managerGuid:"original-guid"};
   return {guid:identity.managerGuid};
  },sendEvent:()=>false,client:(_type,_session,guid)=>({request:async()=>{
   posts++;assert.equal(guid,"original-guid");return response(200,{status:"delivered",delivery:{status:"accepted"}});
  }})});
 t.after(async()=>{await owner.close();fs.rmSync(root,{recursive:true,force:true});});
 owner.submit(intent("original-intent"));await owner.flight;
 assert.equal(posts,0);assert.equal(owner.store.raw("original-intent").manager_guid,null);
 assert.equal(owner.store.get("original-intent").state,"pending");assert.equal(owner.store.get("original-intent").attempts,0);
 assert.equal(owner.store.get("original-intent").error,"DELIVERY_MANAGER_CHANGED");
 switched=false;identity={...original};now+=10000;await owner.tick();
 assert.equal(posts,1);assert.equal(owner.store.raw("original-intent").manager_guid,"original-guid");
 assert.equal(owner.store.get("original-intent").state,"delivered");
});
