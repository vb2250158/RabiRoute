import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { __test } from "../rabi-agent.mjs";

const identity = nodeId => ({ code: 0, data: { nodeId, applicationGenerationId: "generation-fixture", managerInstanceId: "manager-fixture", health: { state: "healthy", requiredReady: true } } });
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
      assert.deepEqual(JSON.parse(init.body), { ticket: "fixture-ticket", nodeId });
      assert.equal(init.headers.authorization, undefined);
      return Response.json({ code: 0, data: { nodeId, token: "fixture-node-credential" } });
    }
    assert.equal(init.headers.authorization, "Bearer fixture-node-credential");
    return Response.json(identity(nodeId));
  };
}

test("bootstrap exchanges ticket once, persists only credential and registered Agent, reconnect skips enrollment", async () => fixture(async ({ configPath }) => {
  const requests = [];
  const config = await __test.bootstrapConfig(configPath, server(requests));
  assert.equal(config.nodeCredential, "fixture-node-credential");
  assert.equal(process.env.RABI_AGENT_BOOTSTRAP_TICKET, undefined);
  assert.equal(config.agents[0].sessionId, "new-task");
  assert.equal(fs.readFileSync(configPath, "utf8").includes("fixture-ticket"), false);
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await __test.bootstrapConfig(configPath, server(requests));
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
  assert.equal(__test.readConfig(configPath).nodeCredential, "fixture-node-credential");
}));

test("legacy configuration fails closed, then explicit enrollment preserves node, Agent catalog and workspaces", async () => fixture(async ({ configPath, directory }) => {
  const agents = [{ agentId: "stable-agent", provider: "codex-desktop", sessionId: "saved-task", enabled: false, workspace: directory }];
  const legacy = { schemaVersion: 1, managerUrl: process.env.RABI_MANAGER_URL, nodeId: "stable-instance", lanLinkToken: "fixture-legacy", agents, allowedWorkspaces: [directory] };
  fs.writeFileSync(configPath, JSON.stringify(legacy));
  assert.throws(() => __test.readConfig(configPath), /Legacy lanLinkToken/);
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await assert.rejects(__test.bootstrapConfig(configPath), /re-enroll/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), legacy);
  process.env.RABI_AGENT_BOOTSTRAP_TICKET = "fixture-ticket";
  const result = await __test.bootstrapConfig(configPath, server([], "stable-instance"));
  assert.equal(result.nodeId, "stable-instance");
  assert.deepEqual(result.agents, agents);
  assert.deepEqual(result.allowedWorkspaces.map(item => fs.realpathSync.native(item)), [fs.realpathSync.native(directory)]);
  assert.equal(result.lanLinkToken, undefined);
}));

test("enrollment rejection and timeout never replay or replace existing config", async () => fixture(async ({ configPath }) => {
  for (const failure of [async () => Response.json({ code: 1 }, { status: 403 }), async () => { throw new DOMException("fixture", "TimeoutError"); }]) {
    process.env.RABI_AGENT_BOOTSTRAP_TICKET = "fixture-ticket";
    let count = 0;
    await assert.rejects(__test.bootstrapConfig(configPath, async () => { count++; return failure(); }), /no automatic retry|uncertain/);
    assert.equal(count, 1);
    assert.equal(fs.existsSync(configPath), false);
  }
  fs.writeFileSync(configPath, "invalid");
  await assert.rejects(__test.bootstrapConfig(configPath), /refusing/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "invalid");
}));

test("self identity failure retains successfully exchanged credential for recovery without another ticket", async () => fixture(async ({ configPath }) => {
  const requests = [];
  const success = server(requests);
  await assert.rejects(__test.bootstrapConfig(configPath, async (url, init) => String(url).endsWith("/self") ? Response.json(identity("wrong-node")) : success(url, init)), /identity/);
  assert.equal(JSON.parse(fs.readFileSync(configPath)).nodeCredential, "fixture-node-credential");
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  await __test.bootstrapConfig(configPath, success);
  assert.equal(requests.filter(item => item.url.endsWith("/enroll")).length, 1);
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
  let turns = 0;
  let releaseQueue;
  globalThis.fetch = async (_url, init) => { requests++; assert.equal(init.headers["x-rabiroute-agent-id"], "default"); return Response.json({ code: 403 }, { status: 403 }); };
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node", defaultWorkspace: directory, allowedWorkspaces: [directory], codexDesktop: { threadId: "fixture-session" } }, configPath);
  runtime.desktop.startTurn = async () => { turns++; };
  runtime.taskQueue = new Promise(resolve => { releaseQueue = resolve; });
  try {
    runtime.enqueueTask({ taskId: "fixture-task", targetAgent: "codex-desktop", message: "fixture", cwd: directory });
    assert.equal(requests, 0);
    releaseQueue();
    await runtime.taskQueue;
    assert.equal(requests, 1);
    assert.equal(turns, 0);
    assert.equal(runtime.stateStore.state.tasks["fixture-task"].status, "failed");
  } finally { runtime.stop(); globalThis.fetch = savedFetch; }
}));

test("WebSocket authenticates only with node credential after self verification", async () => fixture(async ({ configPath, directory }) => {
  const savedFetch = globalThis.fetch;
  const savedSocket = globalThis.WebSocket;
  const sent = [];
  let socket;
  globalThis.fetch = async (_url, init) => { assert.equal(init.headers.authorization, "Bearer fixture-node"); return Response.json(identity("fixture-node")); };
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    handlers = {};
    constructor(url) { this.url = url; socket = this; }
    addEventListener(event, callback) { this.handlers[event] = callback; }
    send(payload) { sent.push(JSON.parse(payload)); }
    close() {}
  };
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.test:54321", nodeId: "fixture-node", nodeCredential: "fixture-node", defaultWorkspace: directory }, configPath);
  try {
    await runtime.connect();
    socket.handlers.open();
    assert.deepEqual(sent, [{ type: "authenticate", token: "fixture-node" }]);
    assert.equal(socket.url, "ws://manager.test:54321/api/lan-agent/connect");
  } finally { runtime.stop(); globalThis.fetch = savedFetch; globalThis.WebSocket = savedSocket; }
}));
