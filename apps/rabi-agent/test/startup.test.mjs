import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withoutSessionBindings } from "../lib/instance-agents.mjs";
import { __test } from "../rabi-agent.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(20); }
  throw new Error("Startup fixture timed out.");
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-startup-owner-"));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ nodeId: "fixture", nodeCredential: "private-fixture", autoUpdate: false, agents: [{ sessionId: "unchanged" }] }));
  const marker = path.join(root, "events.jsonl");
  const events = () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const createWorker = (name, content) => {
    const entry = path.join(root, `${name}.mjs`);
    fs.writeFileSync(entry, `import fs from 'node:fs'; const log = type => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({type,pid:process.pid,at:Date.now()})+'\\n'); ${content}`);
    return entry;
  };
  const start = () => {
    const launcher = __test.writeLauncher(config, { baseDelayMs: 100, maxDelayMs: 200, maxRestarts: 2, stableMs: 60000 });
    return spawn(process.execPath, [launcher, "--config", config], { stdio: "inherit", windowsHide: true });
  };
  const stop = async child => {
    if (child.exitCode !== null) return;
    const launcher = path.join(root, "rabi-agent-launcher.mjs");
    const stopper = spawn(process.execPath, [launcher, "--config", config, "--stop"], { stdio: "inherit" });
    assert.equal(await new Promise(resolve => stopper.once("exit", resolve)), 0);
    await until(() => child.exitCode !== null);
  };
  return { root, config, marker, events, createWorker, start, stop };
}

test("bootstrap release initialization preserves a valid newer pointer and private identity", async () => {
  const f = fixture(); const before = fs.readFileSync(f.config);
  const old = f.createWorker("obsolete-bootstrap", "process.exit(0);");
  const current = f.createWorker("current", "process.exit(0);");
  const pointer = path.join(f.root, "current-release.json");
  try {
    __test.writeCurrentRelease(f.config, current, "b".repeat(64));
    const bytes = fs.readFileSync(pointer);
    const original = { ...JSON.parse(before), managerUrl: "http://fixture.invalid" };
    fs.writeFileSync(f.config, JSON.stringify(original));
    const requests = [];
    await __test.bootstrapConfig(f.config, async (url, init) => {
      requests.push(String(url)); assert.equal(init.method || "GET", "GET");
      const identity = { nodeId: original.nodeId, guid: "fixture-guid", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance", health: { live: true, requiredReady: true, state: "healthy" } };
      if (String(url).endsWith("/.well-known/rabiroute-manager")) {
        assert.equal(init.headers.authorization, undefined);
        return Response.json({ code: 0, data: { ...identity, protocolVersion: 1 } });
      }
      assert.equal(init.headers.authorization, `Bearer ${original.nodeCredential}`);
      return Response.json({ code: 0, data: identity });
    });
    __test.initializeCurrentRelease(f.config, old);
    assert.deepEqual(fs.readFileSync(pointer), bytes);
    const after = JSON.parse(fs.readFileSync(f.config));
    for (const key of ["nodeId", "nodeCredential", "agents", "autoUpdate"]) assert.deepEqual(after[key], withoutSessionBindings(original)[key]);
    assert.equal(requests.some(url => url.includes("enroll")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("bootstrap release initialization creates only a missing first-install pointer", async () => {
  const f = fixture(); const before = fs.readFileSync(f.config);
  const entry = f.createWorker("first-install", "process.exit(0);");
  const pointer = path.join(f.root, "current-release.json");
  try {
    __test.initializeCurrentRelease(f.config, entry);
    assert.equal(JSON.parse(fs.readFileSync(pointer)).entrypoint, entry);
    fs.writeFileSync(pointer, '{"entrypoint":"missing-release.mjs"}');
    const invalid = fs.readFileSync(pointer);
    assert.throws(() => __test.initializeCurrentRelease(f.config, entry), /Current release/);
    assert.deepEqual(fs.readFileSync(pointer), invalid);
    fs.writeFileSync(pointer, "invalid-json");
    assert.throws(() => __test.initializeCurrentRelease(f.config, entry), /Current release/);
    assert.equal(fs.readFileSync(pointer, "utf8"), "invalid-json");
    assert.deepEqual(fs.readFileSync(f.config), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("launcher recovers only abnormal exit, rereads latest pointer and preserves private configuration", async () => {
  const f = fixture(); const before = fs.readFileSync(f.config);
  const next = f.createWorker("next", "log('next'); setInterval(()=>{},1000);");
  const first = f.createWorker("first", `log('first'); fs.writeFileSync(${JSON.stringify(path.join(f.root, "current-release.json"))}, JSON.stringify({entrypoint:${JSON.stringify(next)}})); process.exit(7);`);
  __test.writeCurrentRelease(f.config, first);
  const child = f.start();
  try {
    await until(() => f.events().some(event => event.type === "next"));
    assert.deepEqual(f.events().map(event => event.type), ["first", "next"]);
    assert.ok(f.events()[1].at - f.events()[0].at >= 100);
    const duplicate = f.start();
    assert.equal(await new Promise(resolve => duplicate.once("exit", resolve)), 1);
    assert.deepEqual(f.events().map(event => event.type), ["first", "next"]);
    await f.stop(child);
    await delay(300);
    assert.equal(f.events().length, 2);
    assert.equal(fs.existsSync(path.join(f.root, "launcher-owner.json")), false);
    assert.deepEqual(fs.readFileSync(f.config), before);
  } finally { if (child.exitCode === null) await f.stop(child); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("normal exit zero with changed pointer does not start a second worker", async () => {
  const f = fixture();
  const next = f.createWorker("never", "log('unexpected'); process.exit(0);");
  const first = f.createWorker("normal", `log('normal'); fs.writeFileSync(${JSON.stringify(path.join(f.root, "current-release.json"))}, JSON.stringify({entrypoint:${JSON.stringify(next)}})); process.exit(0);`);
  __test.writeCurrentRelease(f.config, first);
  const child = f.start();
  try {
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 0);
    assert.deepEqual(f.events().map(event => event.type), ["normal"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("persistent crash has bounded exponential restart budget", async () => {
  const f = fixture();
  __test.writeCurrentRelease(f.config, f.createWorker("crash", "log('crash'); process.exit(9);"));
  const child = f.start();
  try {
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 1);
    assert.equal(f.events().length, 3);
    assert.ok(f.events()[1].at - f.events()[0].at >= 100);
    assert.ok(f.events()[2].at - f.events()[1].at >= 200);
    assert.equal(fs.existsSync(path.join(f.root, "launcher-owner.json")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("supervised candidate inherits lifecycle without duplicate spawn after old exit zero", async () => {
  const f = fixture();
  const next = f.createWorker("candidate", `log('candidate'); process.send({type:'candidatePrepared',nodeId:'fixture'}); process.on('message', msg => { if(msg.type==='activateCandidate') process.send({type:'candidateConnected',nodeId:'fixture'}); if(msg.type==='commitCandidate') process.send({type:'candidateCommitted'}); if(msg.type==='launcherCommitted') {log('committed'); process.exit(8);} });`);
  const final = f.createWorker("recovered", "log('recovered'); setInterval(()=>{},1000);");
  const first = f.createWorker("old", `log('old'); const requestId='fixture'; process.send({type:'launcherSpawnCandidate',requestId,entrypoint:${JSON.stringify(next)}}); process.on('message', msg=>{ if(msg.type!=='launcherCandidateEvent')return; if(msg.event.type==='candidatePrepared')process.send({type:'launcherCandidateCommand',requestId,command:'activateCandidate'}); if(msg.event.type==='candidateConnected'){ fs.writeFileSync(${JSON.stringify(path.join(f.root, "current-release.json"))},JSON.stringify({entrypoint:${JSON.stringify(final)}}));process.send({type:'launcherCandidateCommand',requestId,command:'commitCandidate'}); } if(msg.event.type==='candidateCommitted'){process.send({type:'launcherReleaseCandidate',requestId},()=>{process.disconnect();process.exit(0);});} });`);
  __test.writeCurrentRelease(f.config, first);
  const child = f.start();
  try {
    await until(() => f.events().some(event => event.type === "recovered"));
    assert.deepEqual(f.events().map(event => event.type), ["old", "candidate", "committed", "recovered"]);
    await f.stop(child);
  } finally { if (child.exitCode === null) await f.stop(child); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("production handoff relays candidate through stable owner and supervises committed successor", async () => {
  const f = fixture();
  const source = new URL("../rabi-agent.mjs", import.meta.url).href;
  const next = f.createWorker("relay-candidate", `log('candidate'); process.send({type:'candidatePrepared',nodeId:'fixture'}); process.on('message', message=>{ if(message.type==='activateCandidate')process.send({type:'candidateConnected',nodeId:'fixture'}); if(message.type==='commitCandidate')process.send({type:'candidateCommitted'}); if(message.type==='launcherCommitted')log('committed'); }); process.on('disconnect',()=>process.exit(0));`);
  const final = f.createWorker("relay-recovered", "log('recovered'); setInterval(()=>{},1000);");
  const first = f.createWorker("relay-old", `const {__test}=await import(${JSON.stringify(source)}); log('old'); const runtime=new __test.RabiAgentRuntime(JSON.parse(fs.readFileSync(${JSON.stringify(f.config)})),${JSON.stringify(f.config)}); runtime.connected=true; runtime.pauseConnection=async()=>{runtime.connectionPaused=true;runtime.connected=false;}; await runtime.handoffRelease(${JSON.stringify(next)},'b'.repeat(64)); log('retired');`);
  __test.writeCurrentRelease(f.config, first);
  const child = f.start();
  try {
    await until(() => f.events().some(event => event.type === "committed") && f.events().some(event => event.type === "retired"));
    assert.equal(f.events().filter(event => event.type === "candidate").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "current-release.json"))).entrypoint, next);
    assert.equal(child.exitCode, null);
    __test.writeCurrentRelease(f.config, final);
    process.kill(f.events().find(event => event.type === "candidate").pid, "SIGKILL");
    await until(() => f.events().some(event => event.type === "recovered"));
    assert.equal(f.events().filter(event => event.type === "old").length, 1);
    await f.stop(child);
  } finally { if (child.exitCode === null) await f.stop(child); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("production cold worker remains alive with Manager offline and no Desktop runtime", async () => {
  const f = fixture();
  fs.writeFileSync(f.config, JSON.stringify({ schemaVersion: 1, nodeId: "fixture", nodeCredential: "fixture", autoUpdate: false,
    managerUrl: "http://127.0.0.1:1", releasePublicKeySha256: "a".repeat(64), defaultWorkspace: f.root, allowedWorkspaces: [f.root], agentType: "codex-desktop", codexDesktop: { threadId: "fixture-task" } }));
  const cold = f.createWorker("cold-runtime", `const {__test}=await import(${JSON.stringify(new URL("../rabi-agent.mjs", import.meta.url).href)}); const runtime=new __test.RabiAgentRuntime(__test.readConfig(${JSON.stringify(f.config)}),${JSON.stringify(f.config)}); runtime.start(); process.once('SIGTERM',()=>runtime.stop());`);
  // No launcher/control server, IPC, fake keepalive or business runtime: only
  // the production connector's offline retry timer may keep this process alive.
  const child = spawn(process.execPath, [cold], { stdio: "inherit" });
  try {
    await delay(1600);
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(path.join(f.root, "state.json")), false);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("startup plans restrict activation to current login user and retain failure diagnostics", async () => {
  const f = fixture();
  const commands = [];
  const runCommand = async (...args) => { commands.push(args); return { ok: false, diagnostic: "fixture user bus unavailable" }; };
  try {
    const mac = await __test.configureCurrentUserStartup(null, f.config, { platform: "darwin", home: f.root, uid: 501, activate: true, runCommand });
    assert.equal(mac.activated, false);
    assert.deepEqual(commands.map(command => command[1][0]), ["print", "bootstrap"]);
    assert.equal(commands[1][1][1], "gui/501");
    const plist = fs.readFileSync(path.join(f.root, "Library", "LaunchAgents", "com.rabiroute.agent.plist"), "utf8");
    assert.match(plist, /KeepAlive/); assert.match(plist, /SuccessfulExit/); assert.match(plist, /ThrottleInterval/);
    commands.length = 0;
    const linux = await __test.configureCurrentUserStartup(null, f.config, { platform: "linux", home: f.root, env: {}, activate: true, runCommand });
    assert.equal(linux.mode, "desktop-login-fallback"); assert.match(linux.diagnostic, /No linger or prelogin/);
    assert.deepEqual(commands, [["systemctl", ["--user", "show-environment"]]]);
    const unit = fs.readFileSync(path.join(f.root, ".config", "systemd", "user", "rabi-agent.service"), "utf8");
    assert.match(unit, /Restart=on-failure/); assert.match(unit, /RestartSec=30/); assert.match(unit, /StartLimitBurst=5/);
    assert.ok(fs.existsSync(path.join(f.root, ".config", "autostart", "rabi-agent.desktop")));
    commands.length = 0;
    await __test.configureCurrentUserStartup(null, f.config, { platform: "darwin", home: f.root, uid: 501, activate: true, runCommand: async (...args) => { commands.push(args); return { ok: true }; } });
    assert.equal(commands.length, 1); // Existing launchd job: no duplicate bootstrap.
    commands.length = 0;
    await __test.configureCurrentUserStartup(null, f.config, { platform: "linux", home: f.root, env: {}, activate: true, runCommand: async (...args) => { commands.push(args); return { ok: true }; } });
    assert.equal(commands.length, 3); assert.equal(fs.existsSync(path.join(f.root, ".config", "autostart", "rabi-agent.desktop")), false);
    commands.length = 0;
    await __test.configureCurrentUserStartup(null, f.config, { platform: "darwin", home: f.root, uid: 501, runCommand });
    assert.equal(commands.length, 0); // Generation alone must never call launchctl.
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Windows hidden VBS launches exact argv with spaces quotes and literal percent paths", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  const directory = path.join(f.root, "中文 space & ! %PATH%"); fs.mkdirSync(directory);
  const script = path.join(directory, "argv.mjs"); const config = path.join(directory, "config.json");
  const output = path.join(f.root, "argv.json");
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  const plan = __test.startupFiles("win32", process.execPath, script, config, { home: f.root, env: {} });
  const vbs = plan.files.find(file => file.path.endsWith(".vbs"));
  fs.mkdirSync(path.dirname(vbs.path), { recursive: true }); fs.writeFileSync(vbs.path, `\uFEFF${vbs.content}`, "utf16le");
  try {
    assert.match(vbs.content, /, 0, False/);
    const child = spawn("cscript.exe", ["//nologo", vbs.path], { stdio: "inherit", windowsHide: true });
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 0);
    await until(() => fs.existsSync(output));
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), ["--config", config]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
