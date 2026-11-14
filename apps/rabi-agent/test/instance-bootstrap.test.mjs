import test from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withoutSessionBindings } from "../lib/instance-agents.mjs";
import { __test } from "../rabi-agent.mjs";

// The runtime reaches its published Codex plugin; only the external Desktop IPC
// peer is isolated. No production Desktop receives a fixture task.
async function codexPeer(directory, turns) {
  const pipePath = process.platform === "win32"
    ? `\\\\.\\pipe\\rabi-agent-test-${process.pid}-${path.basename(directory)}`
    : path.join(directory, "codex.sock");
  const sockets = new Set();
  const listener = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
        const length = pending.readUInt32LE(0);
        const message = JSON.parse(pending.subarray(4, length + 4).toString("utf8"));
        pending = pending.subarray(length + 4);
        if (message.method === "thread-follower-start-turn") turns.push(message.params.turnStart.request);
        assert.ok(["initialize", "thread-follower-start-turn"].includes(message.method));
        const response = Buffer.from(JSON.stringify({
          requestId: message.requestId,
          resultType: "success",
          result: message.method === "initialize" ? { clientId: "fixture-client" } : {}
        }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(response.length);
        socket.write(Buffer.concat([header, response]));
      }
    });
  });
  listener.listen(pipePath);
  await once(listener, "listening");
  const previous = process.env.CODEX_DESKTOP_IPC_PATH;
  process.env.CODEX_DESKTOP_IPC_PATH = pipePath;
  return async () => {
    if (previous === undefined) delete process.env.CODEX_DESKTOP_IPC_PATH;
    else process.env.CODEX_DESKTOP_IPC_PATH = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  };
}

const identity = nodeId => ({ code: 0, data: { nodeId, applicationGenerationId: "generation-fixture", managerInstanceId: "manager-fixture", guid: "guid-fixture", rabiGuid: "guid-fixture", health: { live: true, state: "healthy", requiredReady: true } } });
async function fixture(run) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-bootstrap-")));
  const configPath = path.join(directory, "config.json");
  const variables = { RABI_MANAGER_URL: "http://manager.test:54321", RABI_AGENT_BOOTSTRAP_TICKET: "fixture-ticket", RABI_AGENT_DEFAULT_CWD: directory, RABI_AGENT_ALLOWED_CWDS: JSON.stringify([directory]), RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256: "a".repeat(64), RABI_AGENT_TYPE: "codex-desktop", RABI_AGENT_CODEX_THREAD_ID: "new-task", RABI_NODE_ID: "fixture-node" };
  const previousEnv = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try { await run({ directory, configPath }); }
  finally {
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function server(requests, nodeId = "fixture-node") {
  return async (url, init) => {
    requests.push({ url: String(url), init });
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/enroll")) {
      const body = JSON.parse(init.body);
      assert.equal(body.ticket, "fixture-ticket"); assert.equal(body.nodeId, nodeId);
      assert.match(body.enrollmentSecret, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(init.headers.authorization, undefined);
      return Response.json({ code: 0, data: { nodeId, token: `lan1:${nodeId}:${body.enrollmentSecret}` } });
    }
    if (String(url).endsWith("/.well-known/rabiroute-manager")) {
      assert.equal(init.headers.authorization, undefined);
      return Response.json({ code: 0, data: { ...identity(nodeId).data, protocolVersion: "1" } });
    }
    assert.match(init.headers.authorization, new RegExp(`^Bearer lan1:${nodeId}:[A-Za-z0-9_-]{43}$`));
    return Response.json(identity(nodeId));
  };
}

test("bootstrap exchanges ticket once, persists only credential and registered Agent, reconnect skips enrollment", async () => fixture(async ({ configPath }) => {
  const requests = [];
  const config = await __test.bootstrapConfig(configPath, server(requests));
  assert.match(config.nodeCredential, /^lan1:fixture-node:/);
  assert.equal(process.env.RABI_AGENT_BOOTSTRAP_TICKET, undefined);
  assert.deepEqual(config.agents, []);
  assert.equal(fs.readFileSync(configPath, "utf8").includes("fixture-ticket"), false);
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await __test.bootstrapConfig(configPath, server(requests));
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
  assert.equal(__test.readConfig(configPath).nodeCredential, config.nodeCredential);
}));

test("computer-only enrollment and normal configuration loading need no Agent session", async () => fixture(async ({ configPath }) => {
  delete process.env.RABI_AGENT_TYPE; delete process.env.RABI_AGENT_CODEX_THREAD_ID;
  const requests = [];
  const config = await __test.bootstrapConfig(configPath, server(requests));
  assert.deepEqual(config.agents, []); assert.equal(config.codexDesktop, undefined);
  const loaded = __test.readConfig(configPath);
  assert.deepEqual(loaded.agents, []); assert.equal(loaded.nodeCredential, config.nodeCredential);
  await __test.bootstrapConfig(configPath, server(requests));
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
}));

test("a configured Agent catalog does not depend on a legacy global session binding", async () => fixture(async ({ configPath, directory }) => {
  fs.writeFileSync(configPath,JSON.stringify({schemaVersion:1,nodeId:"fixture-node",nodeCredential:"fixture-node-credential",managerUrl:process.env.RABI_MANAGER_URL,releasePublicKeySha256:"a".repeat(64),defaultWorkspace:directory,allowedWorkspaces:[directory],agents:[{agentId:"saved-agent",provider:"codex-desktop",sessionId:"saved-task",workspace:directory}]}));
  const loaded=__test.readConfig(configPath);assert.equal(loaded.agents[0].sessionId,undefined);
}));

test("legacy configuration fails closed, then explicit enrollment preserves node, Agent catalog and workspaces", async () => fixture(async ({ configPath, directory }) => {
  const agents = [{ agentId: "stable-agent", provider: "codex-desktop", sessionId: "saved-task", enabled: false, workspace: directory }];
  const legacy = { schemaVersion: 1, managerUrl: process.env.RABI_MANAGER_URL, nodeId: "stable-instance", lanLinkToken: "fixture-legacy", agents, allowedWorkspaces: [directory] };
  fs.writeFileSync(configPath, JSON.stringify(legacy));
  assert.throws(() => __test.readConfig(configPath), /credential/);
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await assert.rejects(__test.bootstrapConfig(configPath), /re-enroll/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), withoutSessionBindings(legacy));
  process.env.RABI_AGENT_BOOTSTRAP_TICKET = "fixture-ticket";
  const result = await __test.bootstrapConfig(configPath, server([], "stable-instance"));
  assert.equal(result.nodeId, "stable-instance");
  assert.deepEqual(result.agents, withoutSessionBindings({agents}).agents);
  assert.deepEqual(result.allowedWorkspaces.map(item => fs.realpathSync.native(item)), [fs.realpathSync.native(directory)]);
  assert.equal(result.lanLinkToken, undefined);
}));

test("enrollment rejection and timeout never replay or replace existing config", async () => fixture(async ({ configPath }) => {
  for (const failure of [async () => Response.json({ code: 1 }, { status: 403 }), async () => { throw new DOMException("fixture", "TimeoutError"); }]) {
    process.env.RABI_AGENT_BOOTSTRAP_TICKET = "fixture-ticket";
    fs.rmSync(`${configPath}.enrollment.json`, { force: true });
    let count = 0;
    await assert.rejects(__test.bootstrapConfig(configPath, async (url) => {
      if (String(url).endsWith("/enroll")) { count++; return failure(); }
      throw new TypeError("offline");
    }), /Enrollment failed|uncertain/);
    assert.equal(count, 1);
    assert.equal(fs.existsSync(configPath), false);
  }
  fs.writeFileSync(configPath, "invalid");
  await assert.rejects(__test.bootstrapConfig(configPath), /refusing/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "invalid");
}));

test("self identity failure retains the exchange recovery proof without another ticket", async () => fixture(async ({ configPath }) => {
  const requests = [];
  const success = server(requests);
  await assert.rejects(__test.bootstrapConfig(configPath, async (url, init) => String(url).endsWith("/self") ? Response.json(identity("wrong-node")) : success(url, init)), /identity/);
  assert.equal(fs.existsSync(configPath), false);
  assert.match(JSON.parse(fs.readFileSync(`${configPath}.enrollment.json`)).secret, /^[A-Za-z0-9_-]{43}$/);
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await __test.bootstrapConfig(configPath, success);
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
}));

test("concurrent bootstrap and concurrent configuration edits cannot replace saved bindings", async () => fixture(async ({ configPath }) => {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const success = server([]);
  const first = __test.bootstrapConfig(configPath, async (url, init) => {
    if (String(url).endsWith("/enroll")) { entered(); await waiting; }
    return success(url, init);
  });
  await started;
  await assert.rejects(__test.bootstrapConfig(configPath, success), /already running|busy/);
  const concurrent = { nodeId: "fixture-node", agents: [{ agentId: "concurrent-binding" }] };
  fs.writeFileSync(configPath, JSON.stringify(concurrent));
  release();
  await assert.rejects(first, /Configuration changed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), concurrent);
  assert.equal(fs.existsSync(`${configPath}.enrollment.json`), true);
}));

test("a fresh pasted ticket repairs rejected credentials without changing node, bindings or directories", async () => fixture(async ({ configPath, directory }) => {
  const agents = [{ agentId: "saved", provider: "dsh", sessionId: "saved-task", workspace: directory }];
  const original = { schemaVersion: 1, nodeId: "stable-node", nodeCredential: "rejected-credential", managerUrl: process.env.RABI_MANAGER_URL,
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const requests = []; const success = server(requests, "stable-node");
  const config = await __test.bootstrapConfig(configPath, async (url, init) => {
    if (String(url).endsWith("/self") && init.headers.authorization === "Bearer rejected-credential") return Response.json({code:-1}, {status:401});
    return success(url, init);
  });
  assert.equal(config.nodeId, original.nodeId); assert.deepEqual(config.agents, withoutSessionBindings({agents}).agents);
  assert.equal(config.defaultWorkspace, directory); assert.deepEqual(config.allowedWorkspaces, [directory]);
  assert.match(config.nodeCredential, /^lan1:stable-node:/);
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
  assert.equal(fs.existsSync(`${configPath}.enrollment.json`), false);
}));

test("a committed exchange with a lost response is recovered by self authentication without another POST", async () => fixture(async ({ configPath }) => {
  let credential; let enrollments = 0;
  const fetcher = async (url, init) => {
    if (String(url).endsWith("/enroll")) {
      enrollments++; const body = JSON.parse(init.body); credential = `lan1:${body.nodeId}:${body.enrollmentSecret}`;
      throw new DOMException("response lost", "TimeoutError");
    }
    if (String(url).endsWith("/.well-known/rabiroute-manager")) return Response.json({code:0,data:{...identity("fixture-node").data,protocolVersion:"1"}});
    assert.equal(init.headers.authorization, `Bearer ${credential}`); return Response.json(identity("fixture-node"));
  };
  const config = await __test.bootstrapConfig(configPath, fetcher);
  assert.equal(config.nodeCredential, credential); assert.equal(enrollments, 1);
  assert.equal(fs.existsSync(`${configPath}.enrollment.json`), false);
}));

test("an interrupted first install recovers its original node after restart without another ticket", async () => fixture(async ({ configPath }) => {
  let credential; let enrollments = 0; let offline = true;
  const success = server([]);
  const fetcher = async (url, init) => {
    if (String(url).endsWith("/enroll")) {
      enrollments++; const body = JSON.parse(init.body); credential = `lan1:${body.nodeId}:${body.enrollmentSecret}`;
      throw new DOMException("response lost", "TimeoutError");
    }
    if (offline) throw new TypeError("offline");
    return success(url, init);
  };
  await assert.rejects(__test.bootstrapConfig(configPath, fetcher), /uncertain/);
  assert.equal(fs.existsSync(configPath), false);
  const recovery = JSON.parse(fs.readFileSync(`${configPath}.enrollment.json`));
  assert.equal(recovery.nodeId, "fixture-node"); assert.equal(JSON.stringify(recovery).includes("fixture-ticket"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(`${configPath}.enrollment.json`).mode & 0o777, 0o600);
  offline = false; process.env.RABI_NODE_ID = "must-not-replace-node";
  const config = await __test.bootstrapConfig(configPath, fetcher);
  assert.equal(config.nodeId, "fixture-node"); assert.equal(config.nodeCredential, credential); assert.equal(enrollments, 1);
}));

test("pending exchange takes precedence over an older credential that might still be valid", async () => fixture(async ({ configPath, directory }) => {
  const previous = { schemaVersion: 1, nodeId: "fixture-node", nodeCredential: "older-credential", managerUrl: process.env.RABI_MANAGER_URL,
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(previous));
  const secret = "r".repeat(43);
  fs.writeFileSync(`${configPath}.enrollment.json`, JSON.stringify({ managerUrl: previous.managerUrl, nodeId: previous.nodeId, secret }));
  let committed = false; let exchanges = 0;
  const config = await __test.bootstrapConfig(configPath, async (url, init) => {
    assert.notEqual(init.headers.authorization, "Bearer older-credential");
    if (String(url).endsWith("/enroll")) {
      exchanges++; assert.equal(JSON.parse(init.body).enrollmentSecret, secret); committed = true;
      return Response.json({ code: 0, data: { nodeId: previous.nodeId, token: `lan1:${previous.nodeId}:${secret}` } });
    }
    if (String(url).endsWith("/.well-known/rabiroute-manager")) return Response.json({code:0,data:{...identity(previous.nodeId).data,protocolVersion:"1"}});
    return committed ? Response.json(identity(previous.nodeId)) : Response.json({code:-1}, {status:401});
  });
  assert.equal(config.nodeCredential, `lan1:${previous.nodeId}:${secret}`); assert.equal(exchanges, 1);
  assert.equal(fs.existsSync(`${configPath}.enrollment.json`), false);
}));

test("download uses independent credential, rejects cross origin and redirects", async () => {
  const config = { managerUrl: "http://manager.test:54321", nodeCredential: "fixture-node" };
  let count = 0;
  const fetcher = async (_url, init) => { count++; assert.equal(init.headers.authorization, "Bearer fixture-node"); assert.equal(init.redirect, "error"); return new Response("fixture"); };
  await __test.authorizedFetch(config, "/api/lan-agent/releases/manifest", fetcher);
  for (const target of ["//other.test/file", "https://other.test/file", "/\\other.test/file"]) await assert.rejects(__test.authorizedFetch(config, target, fetcher), /Cross-origin/);
  assert.equal(count, 1);
  await assert.rejects(__test.authorizedFetch(config, "/api/lan-agent/releases/manifest", async (_url, init) => { assert.equal(init.redirect, "error"); throw new TypeError("redirect rejected"); }), /redirect rejected/);
});

test("launcher installs a pointer-resolving Hook shim and provides stable API forwarding", async () => fixture(async ({ configPath, directory }) => {
  if (process.platform !== "win32") fs.writeFileSync(path.join(directory,"package.json"),JSON.stringify({rabiAgentOwnerProtocol:2}));
  const launcher = __test.writeLauncher(configPath);
  assert.ok(fs.existsSync(path.join(directory, "hook-client.mjs")));
  assert.equal(fs.existsSync(path.join(directory, "manager-client.mjs")), false);
  assert.match(fs.readFileSync(path.join(directory, "hook-client.mjs"), "utf8"), /current-release\.json/);
  const code = fs.readFileSync(launcher, "utf8");
  assert.ok(code.includes(JSON.stringify(configPath)));
  assert.match(code, /forwarded\.length \? forwarded/);
  const entrypoint = path.join(directory, "fixture-entry.mjs");
  const output = path.join(directory, "args.json");
  fs.writeFileSync(entrypoint, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  __test.writeCurrentRelease(configPath, entrypoint);
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, "--api", "GET", "/api/lan-agent/capabilities", "--agent", "fixture-agent"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), ["--api", "GET", "/api/lan-agent/capabilities", "--agent", "fixture-agent", "--config", configPath]);
}));

test("queued task revoked before execution never enters the host", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch;
  let requests = 0;
  const turns = [];
  let releaseQueue;
  globalThis.fetch = async (url, init) => { requests++; if (String(url).endsWith("/.well-known/rabiroute-manager")) return Response.json({ code: 0, data: { ...identity("fixture-node").data, protocolVersion: "1" } }); return Response.json({ code: 403 }, { status: 403 }); };
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node", defaultWorkspace: directory, allowedWorkspaces: [directory],
    agents: [{ agentId: "default", provider: "codex-desktop", sessionId: "fixture-session", workspace: directory }] }, configPath);
  let closePeer;
  try {
  closePeer = await codexPeer(directory, turns);
  // Exercise authority revocation, not the earlier disconnected-transport guard.
  runtime.connected = true;
  runtime.socketManagerGuid = "guid-fixture";
  Object.assign(runtime.config, { schemaVersion: 1, managerGuid: "guid-fixture", releasePublicKeySha256: "a".repeat(64) });
  fs.writeFileSync(configPath, JSON.stringify(runtime.config));
  runtime.send = () => true;
  runtime.taskQueue = new Promise(resolve => { releaseQueue = resolve; });
    runtime.enqueueTask({ taskId: "fixture-task", agentId: "default", targetAgent: "codex-desktop", threadId: "explicit-target", message: "fixture", cwd: directory });
    assert.equal(requests, 0);
    releaseQueue();
    await runtime.taskQueue;
    assert.ok(requests > 0);
    assert.equal(turns.length, 0);
    assert.equal(runtime.stateStore.state.tasks["fixture-task"].status, "failed");
  } finally { try { await runtime.stop(); } finally { await closePeer?.(); globalThis.fetch = savedFetch; } }
}));

test("prepared management captures original connection before queue execution and sends no replacement receipt", async () => fixture(async ({ configPath, directory }) => {
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node", defaultWorkspace: directory,
    allowedWorkspaces: [directory], codexDesktop: { threadId: "fixture-session" } }, configPath);
  let releaseQueue;
  const replies = [];
  runtime.send = value => { replies.push(value); return true; };
  runtime.connected = true;
  runtime.socket = { close() {} };
  runtime.taskQueue = new Promise(resolve => { releaseQueue = resolve; });
  runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "fixture-delivery", operation: "prepared_delivery", params: {} }));
  runtime.socket = { close() {} };
  releaseQueue();
  await runtime.taskQueue;
  await Promise.all([...runtime.preparedDeliveries]);
  assert.equal(replies.length, 0);
  await runtime.stop();
}));

test("Manager enablement controls queued execution despite a legacy local disabled field", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch;
  const agent = { agentId: "worker", provider: "codex-desktop", sessionId: "fixture-session", workspace: directory, enabled: false };
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node",
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [agent] }, configPath);
  let closePeer;
  try {
  let enabled = true;
  let requests = 0;
  const turns = [];
  runtime.connected = true;
  runtime.socketManagerGuid = "guid-fixture";
  Object.assign(runtime.config, { schemaVersion: 1, managerGuid: "guid-fixture", releasePublicKeySha256: "a".repeat(64) });
  fs.writeFileSync(configPath, JSON.stringify(runtime.config));
  runtime.send = () => true;
  runtime.send = () => true;
  closePeer = await codexPeer(directory, turns);
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/.well-known/rabiroute-manager")) return Response.json({ code: 0, data: { ...identity("fixture-node").data, protocolVersion: "1" } });
    requests++;
    if (init.headers["x-rabiroute-agent-type"]) assert.equal(init.headers["x-rabiroute-agent-type"], "codex");
    return enabled || String(url).endsWith("/api/lan-agent/self") || !init.headers["x-rabiroute-agent-type"] ? Response.json(identity("fixture-node")) : Response.json({ code: 403 }, { status: 403 });
  };
    await runtime.runTask({ taskId: "enabled-task", agentId: agent.agentId, targetAgent: agent.provider, threadId: "explicit-target", message: "fixture", cwd: directory }, "guid-fixture");
    assert.equal(turns.length, 1, JSON.stringify(runtime.stateStore.state.tasks));
    assert.equal(turns[0].threadId, "explicit-target");
    assert.equal(agent.sessionId, "fixture-session");
    assert.equal(runtime.stateStore.state.tasks["enabled-task"].status, "progress");
    enabled = false;
    const beforeDenied = requests;
    await runtime.runTask({ taskId: "disabled-task", agentId: agent.agentId, targetAgent: agent.provider, threadId: "another-target", message: "fixture", cwd: directory }, "guid-fixture");
    assert.ok(requests > beforeDenied);
    assert.equal(turns.length, 1, JSON.stringify(runtime.stateStore.state.tasks));
    assert.match(runtime.stateStore.state.tasks["disabled-task"].error, /Manager no longer authorizes/);
  } finally { try { await runtime.stop(); } finally { await closePeer?.(); globalThis.fetch = savedFetch; } }
}));

test("thread and prepared operations reach Manager authority with legacy local disabled state", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch;
  const agent = { agentId: "worker", provider: "codex-desktop", sessionId: "fixture-session", workspace: directory, enabled: false };
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node",
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [agent] }, configPath);
  const replies = [];
  let requests = 0;
  runtime.connected = true;
  runtime.socket = { close() {} };
  runtime.send = value => { replies.push(value); return true; };
  globalThis.fetch = async () => { requests++; return Response.json({ code: 403 }, { status: 403 }); };
  try {
    for (const operation of ["prepared_delivery", "reconcile_prepared_delivery"]) {
      const before = requests;
      runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: operation, operation, params: {
        agentId: agent.agentId, agentAdapter: "codex", action: "read", threadId: agent.sessionId,
        delivery: { deliveryId: "fixture-delivery", generation: "fixture-generation", target: {
          kind: "instance", nodeId: "fixture-node", agentId: agent.agentId, provider: "codex", sessionId: agent.sessionId
        } }
      } }));
      await Promise.all([...runtime.preparedDeliveries, ...runtime.receiptRecoveries]);
      assert.ok(requests > before, JSON.stringify(replies));
      assert.match(replies.at(-1).error, operation === "threads" ? /Manager no longer authorizes/ : /Original delivery authority is unavailable/);
    }
  } finally { await runtime.stop(); globalThis.fetch = savedFetch; }
}));

test("prepared-recovery diagnostics retain the original request while observing a busy receipt owner without waiting", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch, replies = [];
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "private-fixture-credential",
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [] }, configPath);
  runtime.connected = true; runtime.socket = { close() {} };
  runtime.send = value => { replies.push(value); return true; };
  let release, requests = 0;
  const waiting = runtime.withReceiptOperation("original-delivery", () => new Promise(resolve => { release = resolve; }));
  globalThis.fetch = async () => { requests++; return Response.json({ code: 403 }, { status: 403 }); };
  try {
    await Promise.resolve();
    runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "original-management-request", operation: "reconcile_prepared_delivery", params: {
      agentAdapter: "codex", delivery: { deliveryId: "original-delivery", generation: "original-generation", target: {
        kind: "instance", nodeId: "fixture-node", provider: "codex", sessionId: "exact-owner"
      } }
    } }));
    await Promise.all([...runtime.receiptRecoveries]);
    const diagnostic = () => fs.readFileSync(path.join(directory, "logs", "management-diagnostics.json"), "utf8");
    const queued = JSON.parse(diagnostic()).entries.at(-1);
    assert.equal(queued.requestId, "original-management-request");
    assert.equal(runtime.receiptOperations.size, 1, "the original execution still owns its receipt");
    assert.ok(requests > 0); assert.equal(replies.length, 1);
    assert.equal(queued.stages.receipt_wait, undefined, "snapshot observation must not queue behind native work");
    release(); await waiting;
    await Promise.all([...runtime.receiptRecoveries]);
    const finished = JSON.parse(diagnostic()).entries.at(-1);
    assert.equal(finished.stages.receipt_enter, undefined);
    assert.equal(finished.stages.module.result, "completed");
    assert.equal(finished.stages.authority.result, "failed");
    assert.equal(finished.stages.response.result, "failed");
    assert.equal(replies.at(-1).requestId, queued.requestId);
    assert.doesNotMatch(diagnostic(), /private-fixture-credential|Original delivery authority/);
    runtime.send = () => false;
    runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "unwritable-response", operation: "reconcile_prepared_delivery", params: {
      agentAdapter: "codex", delivery: { deliveryId: "original-delivery", generation: "original-generation", target: {
        kind: "instance", nodeId: "fixture-node", provider: "codex", sessionId: "exact-owner"
      } }
    } }));
    await Promise.all([...runtime.receiptRecoveries]);
    assert.equal(JSON.parse(diagnostic()).entries.at(-1).stages.response.result, "not_sent");
  } finally { release?.(); await waiting; await runtime.stop(); globalThis.fetch = savedFetch; }
}));

test("WebSocket discovers its path and authenticates only with the original node credential after self verification", { timeout: 10000 }, async () => fixture(async ({ configPath, directory }) => {
  const sent = [], requests = [], meta = identity("fixture-node").data;
  const frame = { type: "object", required: ["type"], properties: { type: { type: "string" } }, additionalProperties: true };
  const contract = { operationId: "manager.lan-agent.connect", contractVersion: "1.0.0", method: "GET", transport: "websocket", pathTemplate: "/future/discovered-node-channel",
    websocket: { protocol: "native-fixture", framing: "json", maxMessageBytes: 1024, maxBufferedBytes: 2048, closeGraceMs: 100, incomingSchema: frame, outgoingSchema: frame } };
  const listener = http.createServer((request, response) => {
    requests.push(request.url); response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/rabiroute-manager") { assert.equal(request.headers.authorization, undefined); response.end(JSON.stringify({ code: 0, data: { ...meta, protocolVersion: 1 } })); return; }
    assert.equal(request.headers.authorization, "Bearer fixture-node");
    response.end(JSON.stringify(request.url === "/api/agent/help" ? { code: 0, data: { schemaVersion: "2", ...meta, pluginGenerationId: "plugins", catalogRevision: 1,
      catalogDigest: "sha256:" + "a".repeat(64), nextCursor: "", operations: [{ id: contract.operationId, contractDigest: "sha256:" + "b".repeat(64), contract }] } } : identity("fixture-node")));
  });
  const ws = new WebSocketServer({ server: listener }); let authenticated;
  const received = new Promise(resolve => { authenticated = resolve; });
  ws.on("connection", (socket, request) => {
    assert.equal(request.url, contract.pathTemplate); assert.equal(request.headers["x-rabiroute-api-contract"], "sha256:" + "b".repeat(64));
    assert.ok(requests.includes("/api/lan-agent/self"));
    socket.on("message", raw => { sent.push(JSON.parse(raw)); authenticated(); });
  });
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://127.0.0.1:" + listener.address().port, nodeId: "fixture-node", nodeCredential: "fixture-node", defaultWorkspace: directory }, configPath);
  try {
    await runtime.connect(); await received;
    assert.deepEqual(sent, [{ type: "authenticate", token: "fixture-node" }]);
  } finally {
    await runtime.stop(); if (runtime.socket) await runtime.socket.closed;
    for (const socket of ws.clients) socket.terminate(); await new Promise(resolve => ws.close(resolve));
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
  }
}));


test("caller creation status reads bypass an occupied mutation queue while metadata create remains ordered", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch, replies = [];
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-only",
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [] }, configPath);
  runtime.connected = true; runtime.socket = { close() {} };
  runtime.send = value => { replies.push(value); return true; };
  globalThis.fetch = async () => { throw new Error("The scheduler fixture must not connect to any Manager."); };
  let releaseWrite, writeStarted = false;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  try {
    runtime.queueManagementWrite(async () => { writeStarted = true; await gate; }, "fixture-held-write");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writeStarted, true);
    const creationIntent = { callerKey: "agent-" + "c".repeat(64) };
    // Missing intentHash deliberately stops at SDK validation after the write queue opens.
    // This exercises scheduling without creating a real native task.
    runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "fixture-metadata-create", operation: "threads", params: {
      agentAdapter: "codex", action: "create_metadata", creationIntent, title: "Fixture metadata", cwd: directory
    } }));
    runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "fixture-creation-status", operation: "threads", params: {
      agentAdapter: "codex", action: "creation_status", creationIntent
    } }));
    assert.equal(runtime.managementReads.size, 1, "status uses the existing independent read owner");
    assert.equal(runtime.managementMutations.size, 2, "metadata create stays behind the original write");
    await Promise.all([...runtime.managementReads]);
    const status = replies.find(value => value.requestId === "fixture-creation-status");
    assert.equal(status?.result?.data?.creation?.protocolVersion, 1, JSON.stringify(replies));
    assert.equal(status.result.data.creation.state, "absent");
    assert.equal(replies.some(value => value.requestId === "fixture-metadata-create"), false, "no create executes while the prior mutation owns the queue");
    assert.equal(runtime.managementMutations.size, 2);
    releaseWrite();
    await Promise.all([...runtime.managementMutations]);
    assert.match(replies.find(value => value.requestId === "fixture-metadata-create")?.error || "", /frozen intent hash/);
    assert.equal(runtime.managementReads.size, 0); assert.equal(runtime.managementMutations.size, 0);
    assert.equal(runtime.pendingOperations, 0);
  } finally {
    releaseWrite?.(); await Promise.allSettled([...runtime.managementReads, ...runtime.managementMutations]);
    await runtime.stop(); globalThis.fetch = savedFetch;
  }
}));
