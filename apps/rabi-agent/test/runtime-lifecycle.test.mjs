import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { __test } from "../rabi-agent.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const entrypoint = fileURLToPath(new URL("../rabi-agent.mjs", import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-lifecycle-"));
  const configPath = path.join(root, "config.json");
  const config = { nodeId: "fixture-node", nodeCredential: "fixture-only", managerUrl: "http://manager.invalid", agents: [{ agentId: "worker", enabled: false, sessionId: "bound-task", workspace: root }] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath);
  runtime.connected = true;
  return { root, configPath, config, runtime };
}
function candidate(root, mode = "ready") {
  const filename = path.join(root, "candidate.mjs");
  const marker = path.join(root, "candidate-events.jsonl");
  fs.writeFileSync(filename, `import fs from 'node:fs';
const log = value => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(value)+'\\n');
log({type:'prepared',pid:process.pid});
process.send({type:'candidatePrepared',nodeId:'fixture-node'});
let committed = false;
process.on('message', message => {
 log({type:message.type});
 if(message.type==='activateCandidate') ${mode === "exit" ? "process.exit(1);" : "process.send({type:'candidateConnected',nodeId:'fixture-node'});"}
 if(message.type==='commitCandidate') {committed=true;process.send({type:'candidateCommitted',nodeId:'fixture-node'});}
});
process.on('disconnect',()=>{log({type:committed?'updated':'aborted'});process.exit(0);});`);
  return { filename, marker, events: () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse) : [] };
}
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  throw new Error("Fixture did not reach expected state.");
}

test("offline reconnect timer remains referenced until explicit stop", () => {
  const f = fixture();
  try {
    f.runtime.scheduleReconnect();
    assert.equal(f.runtime.retryTimer.hasRef(), true);
    f.runtime.stop();
    assert.equal(f.runtime.stopped, true);
  } finally { f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("draining and uncommitted candidates reject new execution without changing bindings", () => {
  const f = fixture(); const events = [];
  f.runtime.send = event => events.push(event);
  try {
    for (const state of ["draining", "candidatePending"]) {
      f.runtime[state] = true;
      f.runtime.handleManagerMessage(JSON.stringify({ type: "assignTask", task: { taskId: "fixture-new" } }));
      f.runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "fixture-request", operation: "configure", params: { agentId: "worker", enabled: true } }));
      f.runtime[state] = false;
    }
    assert.equal(events.length, 4);
    assert.equal(events.every(item => item.error.includes("not accepted")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.config);
    assert.deepEqual(f.runtime.stateStore.state.tasks, {});
  } finally { f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("connected publication triggers automatic content updates unless explicitly disabled or pending", async () => {
  const f = fixture(); const versions = [];
  f.runtime.update = async version => { versions.push(version); };
  const message = JSON.stringify({ type: "connected", release: { version: "0.2.0", releaseDigest: "f".repeat(64) } });
  try {
    f.runtime.handleManagerMessage(message);
    assert.deepEqual(versions, ["0.2.0"]);
    f.runtime.config.autoUpdate = false;
    f.runtime.handleManagerMessage(message);
    f.runtime.config.autoUpdate = true;
    f.runtime.candidatePending = true;
    f.runtime.handleManagerMessage(message);
    assert.deepEqual(versions, ["0.2.0"]);
  } finally { f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("update is single-flight and permits a later attempt after failure", async () => {
  const f = fixture();
  let release;
  let calls = 0;
  f.runtime.performUpdate = async () => { calls++; await new Promise(resolve => { release = resolve; }); throw new Error("fixture failure"); };
  try {
    const first = f.runtime.update("one");
    const second = f.runtime.update("one");
    assert.equal(first, second);
    release();
    await assert.rejects(first, /fixture failure/);
    assert.equal(calls, 1);
    const next = f.runtime.update("one"); release();
    await assert.rejects(next, /fixture failure/);
    assert.equal(calls, 2);
  } finally { f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("handoff waits for queue and active threads, closes old socket before candidate activation", async () => {
  const f = fixture();
  const c = candidate(f.root);
  let finishQueue;
  const oldEntry = path.join(f.root, "old.mjs"); fs.writeFileSync(oldEntry, "");
  __test.writeCurrentRelease(f.configPath, oldEntry, "a".repeat(64));
  __test.writeLauncher(f.configPath);
  f.runtime.taskQueue = new Promise(resolve => { finishQueue = resolve; });
  f.runtime.taskByThread.set("bound-task", "fixture-task");
  const oldSocket = new EventTarget(); oldSocket.readyState = WebSocket.OPEN;
  oldSocket.close = () => { oldSocket.readyState = WebSocket.CLOSED; oldSocket.dispatchEvent(new Event("close")); f.runtime.scheduleReconnect(); };
  f.runtime.socket = oldSocket;
  try {
    const update = f.runtime.handoffRelease(c.filename, "b".repeat(64));
    await waitFor(() => f.runtime.draining);
    assert.deepEqual(c.events().map(item => item.type), ["prepared"]);
    assert.equal(f.runtime.connected, true);
    finishQueue(); await delay(40);
    assert.equal(oldSocket.readyState, WebSocket.OPEN);
    assert.deepEqual(c.events().map(item => item.type), ["prepared"]);
    f.runtime.taskByThread.clear();
    await update;
    assert.equal(oldSocket.readyState, WebSocket.CLOSED);
    assert.equal(f.runtime.retryTimer, null);
    await waitFor(() => c.events().some(item => item.type === "updated"));
    assert.deepEqual(c.events().map(item => item.type), ["prepared", "activateCandidate", "commitCandidate", "updated"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "current-release.json"))).entrypoint, c.filename);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.config);
    assert.equal(f.runtime.stopped, true);
    const candidatePid = c.events().find(item => item.type === "prepared").pid;
    await waitFor(() => { try { process.kill(candidatePid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  } finally { finishQueue?.(); f.runtime.stop(); await fs.promises.rm(f.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("pointer failure after READY kills candidate, restores shared bytes and resumes old owner", async () => {
  const f = fixture(); const c = candidate(f.root);
  const oldEntry = path.join(f.root, "old.mjs"); fs.writeFileSync(oldEntry, "");
  __test.writeCurrentRelease(f.configPath, oldEntry, "a".repeat(64)); __test.writeLauncher(f.configPath);
  const names = ["current-release.json", "hook-client.mjs", "rabi-agent-launcher.mjs"];
  const previous = names.map(name => fs.readFileSync(path.join(f.root, name)));
  const rename = fs.renameSync;
  let fail = true;
  let resumed = 0;
  f.runtime.pauseConnection = async () => { f.runtime.connectionPaused = true; f.runtime.connected = false; };
  f.runtime.scheduleReconnect = () => { resumed++; assert.equal(f.runtime.connectionPaused, false); };
  fs.renameSync = (source, destination) => {
    if (fail && destination === path.join(f.root, "current-release.json")) { fail = false; throw new Error("fixture pointer failure"); }
    return rename(source, destination);
  };
  try {
    await assert.rejects(f.runtime.handoffRelease(c.filename, "b".repeat(64)), /fixture pointer failure/);
    assert.deepEqual(c.events().map(item => item.type), ["prepared", "activateCandidate"]);
    const pid = c.events()[0].pid;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    names.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(f.root, name)), previous[i]));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)), f.config);
    assert.equal(resumed, 1); assert.equal(f.runtime.draining, false); assert.equal(f.runtime.stopped, false);
  } finally { fs.renameSync = rename; f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("candidate connection failure restores old owner without updated notification", async () => {
  const f = fixture(); const c = candidate(f.root, "exit");
  let resumed = 0;
  f.runtime.pauseConnection = async () => { f.runtime.connectionPaused = true; f.runtime.connected = false; };
  f.runtime.scheduleReconnect = () => { resumed++; };
  try {
    await assert.rejects(f.runtime.handoffRelease(c.filename, "b".repeat(64)), /did not connect/);
    assert.equal(resumed, 1); assert.equal(f.runtime.draining, false);
    assert.deepEqual(c.events().map(item => item.type), ["prepared", "activateCandidate"]);
    assert.equal(fs.existsSync(path.join(f.root, "current-release.json")), false);
  } finally { f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("real CLI stdin above 1 MiB reaches only ephemeral HTTP fixture unchanged", async () => {
  const f = fixture();
  const body = JSON.stringify({ text: "x".repeat(1024 * 1024 + 17) });
  let received;
  const identity = { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance", health: { live: true, requiredReady: true, state: "healthy" } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    if (req.url === "/meta") res.end(JSON.stringify(identity));
    else { received = Buffer.concat(chunks).toString(); assert.equal(req.headers["x-rabiroute-expected-manager-instance-id"], identity.managerInstanceId); res.end('{"code":0}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const input = path.join(f.root, "stdin.json"); const output = path.join(f.root, "stdout.json");
  fs.writeFileSync(input, body);
  const stdin = fs.openSync(input, "r"); const stdout = fs.openSync(output, "w");
  try {
    fs.writeFileSync(f.configPath, JSON.stringify({ ...f.config, managerUrl: `http://127.0.0.1:${server.address().port}`, agents: [{ agentId: "worker", enabled: true }] }));
    const child = spawn(process.execPath, [entrypoint, "--config", f.configPath, "--api", "POST", "/api/fixture", "--agent", "worker", "--body-stdin"], { stdio: [stdin, stdout, "inherit"] });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0); assert.equal(received, body);
    assert.equal(JSON.parse(fs.readFileSync(output)).ok, true);
  } finally { fs.closeSync(stdin); fs.closeSync(stdout); await new Promise(resolve => server.close(resolve)); f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("production candidate over ephemeral WebSocket sends updated only after pointer commit", async () => {
  const f = fixture();
  const releaseRoot = path.join(f.root, "release");
  fs.mkdirSync(releaseRoot);
  // Copy production entry/lib bytes; no real host, discovery broadcast or business runtime is started.
  fs.copyFileSync(entrypoint, path.join(releaseRoot, "rabi-agent.mjs"));
  fs.copyFileSync(path.join(path.dirname(entrypoint), "package.json"), path.join(releaseRoot, "package.json"));
  fs.cpSync(path.join(path.dirname(entrypoint), "lib"), path.join(releaseRoot, "lib"), { recursive: true });
  const digest = "b".repeat(64);
  fs.writeFileSync(path.join(releaseRoot, "release-identity.json"), JSON.stringify({ digest }));
  const releaseEntry = path.join(releaseRoot, "rabi-agent.mjs");
  const identity = { guid: "fixture-guid", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" };
  const meta = { ...identity, rabiGuid: identity.guid, health: { live: true, requiredReady: true, state: "healthy" } };
  const events = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/rabiroute-manager") res.end(JSON.stringify({ code: 0, data: { ...identity, protocolVersion: 1 } }));
    else if (req.url === "/api/lan-agent/self") res.end(JSON.stringify({ code: 0, data: { ...identity, nodeId: "fixture-node" } }));
    else if (req.url === "/meta") res.end(JSON.stringify(meta));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => socket.on("message", bytes => {
    const event = JSON.parse(bytes); events.push(event);
    if (event.type === "authenticate") socket.send(JSON.stringify({ type: "authenticated" }));
    if (event.type === "hello") socket.send(JSON.stringify({ type: "connected" }));
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { ...f.config, schemaVersion: 1, managerUrl: `http://127.0.0.1:${server.address().port}`, releasePublicKeySha256: "a".repeat(64), defaultWorkspace: f.root, allowedWorkspaces: [f.root], agentType: "codex-desktop", codexDesktop: { threadId: "fixture-thread" } };
  fs.writeFileSync(f.configPath, JSON.stringify(config));
  const before = fs.readFileSync(f.configPath);
  const child = spawn(process.execPath, [releaseEntry, "--run", "--config", f.configPath], { env: { ...process.env, RABI_AGENT_UPDATE_CANDIDATE: "1" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const messages = [];
  child.on("message", message => messages.push(message));
  try {
    await waitFor(() => messages.some(item => item.type === "candidatePrepared"));
    assert.equal(events.length, 0);
    // Simulate completed old-queue changes: candidate must reload this binding at ACTIVATE.
    const latest = { ...config, agents: [{ ...config.agents[0], sessionId: "latest-task" }] };
    fs.writeFileSync(f.configPath, JSON.stringify(latest));
    child.send({ type: "activateCandidate" });
    await waitFor(() => messages.some(item => item.type === "candidateConnected"));
    assert.equal(events.some(item => item.status === "updated"), false);
    assert.equal(events.find(item => item.type === "hello").node.agents[0].sessionId, "latest-task");
    __test.writeCurrentRelease(f.configPath, releaseEntry, digest);
    child.send({ type: "commitCandidate" });
    await waitFor(() => messages.some(item => item.type === "candidateCommitted"));
    assert.equal(events.some(item => item.status === "updated"), false);
    child.disconnect();
    await waitFor(() => events.some(item => item.status === "updated"));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).agents, latest.agents);
    assert.equal(JSON.parse(before).nodeCredential, JSON.parse(fs.readFileSync(f.configPath)).nodeCredential);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
    f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true });
  }
});

async function productionCandidateFixture() {
  const f = fixture();
  const releaseRoot = path.join(f.root, "candidate-release");
  fs.mkdirSync(releaseRoot);
  fs.copyFileSync(entrypoint, path.join(releaseRoot, "rabi-agent.mjs"));
  fs.copyFileSync(path.join(path.dirname(entrypoint), "package.json"), path.join(releaseRoot, "package.json"));
  fs.cpSync(path.join(path.dirname(entrypoint), "lib"), path.join(releaseRoot, "lib"), { recursive: true });
  const digest = "b".repeat(64);
  fs.writeFileSync(path.join(releaseRoot, "release-identity.json"), JSON.stringify({ digest }));
  const releaseEntry = path.join(releaseRoot, "rabi-agent.mjs");
  const identity = { guid: "fixture-guid", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" };
  const events = []; const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/rabiroute-manager") res.end(JSON.stringify({ code: 0, data: { ...identity, protocolVersion: 1 } }));
    else if (req.url === "/api/lan-agent/self") res.end(JSON.stringify({ code: 0, data: { ...identity, nodeId: f.config.nodeId } }));
    else if (req.url === "/meta") res.end(JSON.stringify({ ...identity, rabiGuid: identity.guid, health: { live: true, requiredReady: true, state: "healthy" } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => socket.on("message", bytes => {
    const event = JSON.parse(bytes); events.push(event);
    if (event.type === "authenticate") socket.send(JSON.stringify({ type: "authenticated" }));
    if (event.type === "hello") socket.send(JSON.stringify({ type: "connected" }));
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { ...f.config, schemaVersion: 1, autoUpdate: false, managerUrl: `http://127.0.0.1:${server.address().port}`, releasePublicKeySha256: "a".repeat(64), defaultWorkspace: f.root, allowedWorkspaces: [f.root], agentType: "codex-desktop", codexDesktop: { threadId: "fixture-thread" } };
  fs.writeFileSync(f.configPath, JSON.stringify(config));
  return { ...f, config, releaseEntry, digest, events, requests, ws, async close() {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
    f.runtime.stop(); fs.rmSync(f.root, { recursive: true, force: true });
  } };
}

for (const failure of ["socket", "pointer", "digest"]) {
  test(`production candidate exits nonzero and releases IPC when ${failure} fails after commit ACK`, async () => {
    const f = await productionCandidateFixture();
    const child = spawn(process.execPath, [f.releaseEntry, "--run", "--config", f.configPath], { env: { ...process.env, RABI_AGENT_UPDATE_CANDIDATE: "1", RABI_AGENT_SUPERVISED: "1" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const messages = []; child.on("message", message => messages.push(message));
    let exit; child.once("exit", (code, signal) => { exit = { code, signal }; });
    try {
      await waitFor(() => messages.some(item => item.type === "candidatePrepared"));
      child.send({ type: "activateCandidate" });
      await waitFor(() => messages.some(item => item.type === "candidateConnected"));
      __test.writeCurrentRelease(f.configPath, f.releaseEntry, f.digest);
      child.send({ type: "commitCandidate" });
      await waitFor(() => messages.some(item => item.type === "candidateCommitted"));
      const before = fs.readFileSync(f.configPath);
      if (failure === "socket") {
        await Promise.all([...f.ws.clients].map(socket => new Promise(resolve => { socket.once("close", resolve); socket.close(); })));
        await delay(50); // Let the production close handler observe the broken connection before opening the fence.
      } else __test.writeCurrentRelease(f.configPath, failure === "pointer" ? entrypoint : f.releaseEntry, failure === "digest" ? "c".repeat(64) : f.digest);
      child.send({ type: "launcherCommitted" });
      await waitFor(() => exit !== undefined);
      assert.equal(exit.signal, null); assert.equal(exit.code, 1);
      assert.equal(child.connected, false);
      assert.equal(f.events.some(item => item.status === "updated"), false);
      assert.deepEqual(fs.readFileSync(f.configPath), before);
      assert.equal(f.requests.some(url => url.includes("enroll")), false);
      assert.equal(f.events.filter(item => item.type === "hello").length, 1);
      assert.equal(fs.existsSync(path.join(f.root, "state.json")), false);
    } finally {
      if (!exit) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited; }
      await f.close();
    }
  });
}

for (const failure of ["socket", "pointer"]) {
  test(`stable launcher recovers production successor after post-ACK ${failure} failure without replay`, async () => {
    const f = await productionCandidateFixture();
    const ack = path.join(f.root, "ack.json"); const gate = path.join(f.root, "release-gate");
    const recovered = path.join(f.root, "recovered.json");
    const recoveryEntry = path.join(f.root, "recovery.mjs");
    fs.writeFileSync(recoveryEntry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(recovered)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
    const oldEntry = path.join(f.root, "old-owner.mjs");
    fs.writeFileSync(oldEntry, `import fs from 'node:fs';
const requestId='fixture-release';
process.send({type:'launcherSpawnCandidate',requestId,entrypoint:${JSON.stringify(f.releaseEntry)}});
process.on('message',message=>{
 if(message.type!=='launcherCandidateEvent')return;
 if(message.event.type==='candidatePrepared')process.send({type:'launcherCandidateCommand',requestId,command:'activateCandidate'});
 if(message.event.type==='candidateConnected'){
  fs.writeFileSync(${JSON.stringify(path.join(f.root, "current-release.json"))},JSON.stringify({entrypoint:${JSON.stringify(f.releaseEntry)},digest:${JSON.stringify(f.digest)}}));
  process.send({type:'launcherCandidateCommand',requestId,command:'commitCandidate'});
 }
 if(message.event.type==='candidateCommitted'){
  const watcher=fs.watch(${JSON.stringify(f.root)},()=>{if(!fs.existsSync(${JSON.stringify(gate)}))return;watcher.close();process.send({type:'launcherReleaseCandidate',requestId},()=>{process.disconnect();process.exit(0);});});
  fs.writeFileSync(${JSON.stringify(ack)},'{}');
 }
});`);
    __test.writeCurrentRelease(f.configPath, oldEntry);
    const launcher = __test.writeLauncher(f.configPath, { baseDelayMs: 100, maxDelayMs: 200, maxRestarts: 2, stableMs: 60000 });
    const child = spawn(process.execPath, [launcher, "--config", f.configPath], { stdio: "inherit", windowsHide: true });
    const stop = async () => {
      if (child.exitCode !== null) return;
      const stopper = spawn(process.execPath, [launcher, "--config", f.configPath, "--stop"], { stdio: "inherit" });
      assert.equal(await new Promise(resolve => stopper.once("exit", resolve)), 0);
      await waitFor(() => child.exitCode !== null);
    };
    try {
      await waitFor(() => fs.existsSync(ack));
      const before = fs.readFileSync(f.configPath);
      if (failure === "socket") {
        await Promise.all([...f.ws.clients].map(socket => new Promise(resolve => { socket.once("close", resolve); socket.close(); })));
        await delay(50);
      } else __test.writeCurrentRelease(f.configPath, recoveryEntry);
      fs.writeFileSync(gate, "release");
      await waitFor(() => failure === "socket" ? f.events.filter(item => item.type === "hello").length === 2 : fs.existsSync(recovered));
      assert.equal(child.exitCode, null);
      assert.equal(f.events.some(item => item.status === "updated"), false);
      assert.equal(f.requests.some(url => url.includes("enroll")), false);
      assert.deepEqual(fs.readFileSync(f.configPath), before);
      assert.equal(fs.existsSync(path.join(f.root, "state.json")), false);
      await stop();
      assert.equal(fs.existsSync(path.join(f.root, "launcher-owner.json")), false);
    } finally { await stop(); await f.close(); }
  });
}

test("Windows startup command preserves spaced and expansion-sensitive paths in a temporary batch", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-startup-"));
  const directory = path.join(root, "space & ! %PATH%"); fs.mkdirSync(directory);
  const script = path.join(directory, "argv.mjs"); const config = path.join(directory, "config.json");
  const output = path.join(root, "args.json"); const batch = path.join(root, "fixture.cmd");
  fs.writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));`);
  fs.writeFileSync(batch, __test.startupCommand("win32", process.execPath, script, config));
  try {
    const child = spawn(process.env.ComSpec, ["/d", "/c", batch], { stdio: "inherit", windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0); assert.deepEqual(JSON.parse(fs.readFileSync(output)), ["--config", config]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("startup rendering escapes Windows expansion, plist XML and desktop Exec arguments", () => {
  const unusual = '/fixture space/a&b<q>"$`\\100%/config.json';
  const plist = __test.startupCommand("darwin", "/node path/node", unusual, unusual);
  const strings = [...plist.split("<array>")[1].split("</array>")[0].matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1].replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
  assert.deepEqual(strings, ["/node path/node", unusual, "--config", unusual]);
  const desktop = __test.startupCommand("linux", "/node path/node", unusual, unusual);
  const exec = desktop.split("\n").find(line => line.startsWith("Exec=")).slice(5).replace(/\\([\\nrt])/g, (_, value) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[value]);
  const args = [...exec.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => match[1].replace(/\\([\\"`$])/g, "$1").replace(/%%/g, "%"));
  assert.deepEqual(args, ["/node path/node", unusual, "--config", unusual]);
  const windows = __test.startupCommand("win32", "C:\\node path\\node.exe", "C:\\a&b!%PATH%\\agent.mjs", "C:\\config space\\config.json");
  assert.match(windows, /DisableDelayedExpansion/); assert.match(windows, /%%PATH%%/);
  assert.throws(() => __test.startupCommand("win32", "node", 'bad"path', "config"), /Invalid Windows/);
});
