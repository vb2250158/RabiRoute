import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { __test } from "../rabi-agent.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (check()) return; await delay(20); }
  throw new Error(`Fixture timed out: ${label}`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
function fixture(t, platform = process.platform, mode = "normal") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-owner-"));
  const config = path.join(root, "config.json");
  const entry = path.join(root, "worker.mjs");
  const marker = path.join(root, "worker-events.jsonl");
  const configBytes = JSON.stringify({ nodeId: "fixture-node", agents: [{ agentId: "fixture", sessionId: "bound-task", enabled: false }] });
  fs.writeFileSync(config, configBytes);
  fs.writeFileSync(entry, `import fs from 'node:fs';
const log = type => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({type,pid:process.pid,supervised:process.env.RABI_AGENT_SUPERVISED,args:process.argv.slice(2)})+'\\n');
if(process.argv.includes('--api')||process.argv.includes('--upload')) {log('start');process.exit(0);}
process.on('disconnect',()=>{log('disconnect');process.exit(0);});
process.on('SIGTERM',()=>{${mode === "slow" ? "setTimeout(()=>{log('stop');process.exit(0);},350);" : "log('stop');process.exit(0);"}});
${mode === "crash" ? "setTimeout(()=>{log('crash');process.exit(1);},60);" : ""}
setInterval(()=>{},1000);
log('start');
`);
  __test.writeCurrentRelease(config, entry, "a".repeat(64));
  const pointerBytes = fs.readFileSync(path.join(root, "current-release.json"));
  const launcher = __test.writeLauncher(config, { baseDelayMs: 20, maxDelayMs: 40, maxRestarts: 2, stableMs: 60000 });
  if (platform !== process.platform) {
    const bytes = fs.readFileSync(launcher, "utf8");
    fs.writeFileSync(launcher, bytes.replace("(async function stableLauncher", `Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}});\n(async function stableLauncher`));
  }
  const canonical = fs.realpathSync(config);
  const hash = createHash("sha256").update(platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const diagnostic = path.join(root, `launcher-control-${hash}.json`);
  const target = platform === "win32" ? `\\\\.\\pipe\\rabi-agent-${hash}` : { host: "127.0.0.1", port: 16384 + (parseInt(hash.slice(0, 8), 16) % 16384), exclusive: true };
  const processes = [];
  function run(args = []) {
    const output = path.join(root, `output-${processes.length}.txt`);
    const fd = fs.openSync(output, "w");
    const child = spawn(process.execPath, [launcher, "--config", config, ...args], { stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
    const result = { child, output, done: false, code: undefined };
    result.closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => { result.done = true; result.code = code; resolve(code); }); });
    processes.push(result);
    return result;
  }
  const events = () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const started = () => events().filter(event => event.type === "start");
  const ready = () => waitFor(() => started().length > 0, "worker started");
  const stopped = async () => {
    const stop = run(["--stop"]); await waitFor(() => stop.done, "stop client exited");
    assert.equal(await stop.closed, 0, fs.readFileSync(stop.output, "utf8"));
  };
  t.after(async () => {
    // Only fixture-owned PIDs are signalled; never use diagnostic PIDs as authority.
    for (const item of processes) if (!item.done) item.child.kill("SIGKILL");
    await Promise.all(processes.map(item => item.closed));
    await waitFor(() => started().every(item => !alive(item.pid)), "fixture workers exited");
    assert.equal(fs.readFileSync(config, "utf8"), configBytes);
    assert.deepEqual(fs.readFileSync(path.join(root, "current-release.json")), pointerBytes);
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { root, config, diagnostic, target, run, events, started, ready, stopped };
}

for (const platform of new Set([process.platform, "linux"])) {
  test(`${platform}: empty retired owner and crash recovery never block startup`, async t => {
    const f = fixture(t, platform);
    const owner = path.join(f.root, "launcher-owner.json"); const recovery = `${owner}.recovery`;
    const oldSocket = path.join(f.root, "launcher-control.sock");
    fs.writeFileSync(owner, ""); fs.writeFileSync(recovery, "retired-recovery"); fs.writeFileSync(oldSocket, "retired-socket-do-not-unlink");
    const launcher = f.run(); await f.ready();
    assert.equal(f.started().length, 1); assert.equal(f.started()[0].supervised, "1");
    assert.equal(fs.readFileSync(owner, "utf8"), ""); assert.equal(fs.readFileSync(recovery, "utf8"), "retired-recovery");
    assert.equal(fs.readFileSync(oldSocket, "utf8"), "retired-socket-do-not-unlink");
    await f.stopped(); assert.equal(await launcher.closed, 0);
  });

  test(`${platform}: concurrent launches spawn exactly one worker and report busy`, async t => {
    const f = fixture(t, platform); const a = f.run(); const b = f.run();
    await f.ready(); await waitFor(() => a.done || b.done, "loser exited");
    const loser = a.done ? a : b; const winner = a.done ? b : a;
    assert.equal(await loser.closed, 1); assert.match(fs.readFileSync(loser.output, "utf8"), /ownership is busy/);
    assert.equal(f.started().length, 1);
    await f.stopped(); assert.equal(await winner.closed, 0);
  });

  test(`${platform}: killed launcher releases kernel lease and old IPC worker exits`, async t => {
    const f = fixture(t, platform); const first = f.run(); await f.ready();
    const oldPid = f.started()[0].pid; const stale = fs.readFileSync(f.diagnostic);
    first.child.kill("SIGKILL"); await first.closed;
    const next = f.run(); await waitFor(() => f.started().length === 2, "new worker started");
    await waitFor(() => !alive(oldPid), "old worker exited after IPC disconnect");
    if (process.platform !== "win32") assert.equal(f.events().some(item => item.type === "disconnect" && item.pid === oldPid), true);
    // Windows can terminate children in the enclosing process job before an IPC
    // disconnect callback runs. Actual PID exit, not callback logging, is required.
    assert.notDeepEqual(fs.readFileSync(f.diagnostic), stale);
    await f.stopped(); assert.equal(await next.closed, 0);
  });

  test(`${platform}: unrelated live listener is not stolen or sent unauthenticated stop`, async t => {
    const f = fixture(t, platform); let received = "";
    const server = net.createServer(socket => { socket.on("data", bytes => { received += bytes.toString(); socket.end("not-a-launcher\n"); }); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.target, resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const contender = f.run(); assert.equal(await contender.closed, 1); assert.equal(f.started().length, 0);
    fs.writeFileSync(f.diagnostic, JSON.stringify({ configHash: createHash("sha256").update(platform === "win32" ? fs.realpathSync(f.config).toLowerCase() : fs.realpathSync(f.config)).digest("hex"), token: "a".repeat(64), pid: process.pid }));
    const stop = f.run(["--stop"]); assert.equal(await stop.closed, 1);
    assert.match(received, /^hello [a-f0-9]{64}\n$/); assert.equal(received.includes("stop"), false);
    assert.equal(server.listening, true);
  });

  test(`${platform}: sequential and concurrent stop are acknowledged after worker exit`, async t => {
    const f = fixture(t, platform, "slow"); const launcher = f.run(); await f.ready();
    const pid = f.started()[0].pid;
    const a = f.run(["--stop"]); const b = f.run(["--stop"]);
    assert.equal(await a.closed, 0); assert.equal(await b.closed, 0);
    assert.equal(alive(pid), false); assert.equal(await launcher.closed, 0);
    await f.stopped(); await f.stopped(); assert.equal(f.started().length, 1);
    const next = f.run(); await waitFor(() => f.started().length === 2, "restart after graceful stop");
    await f.stopped(); assert.equal(await next.closed, 0);
  });

  test(`${platform}: corrupted diagnostic does not weaken real owner or enable stop`, async t => {
    const f = fixture(t, platform); const launcher = f.run(); await f.ready();
    const bytes = fs.readFileSync(f.diagnostic); fs.writeFileSync(f.diagnostic, "");
    const contender = f.run(); assert.equal(await contender.closed, 1); assert.equal(f.started().length, 1);
    const stop = f.run(["--stop"]); assert.equal(await stop.closed, 1); assert.equal(launcher.done, false);
    fs.writeFileSync(f.diagnostic, bytes); await f.stopped(); assert.equal(await launcher.closed, 0);
  });
}

test("launcher preserves abnormal-exit backoff and finite restart budget", async t => {
  const f = fixture(t, process.platform, "crash"); const launcher = f.run();
  await waitFor(() => launcher.done, "restart budget exhausted"); assert.equal(await launcher.closed, 1);
  assert.equal(f.started().length, 3); assert.match(fs.readFileSync(launcher.output, "utf8"), /restart budget exhausted/);
});

test("launcher retains candidate IPC relay and promotes the existing candidate", async t => {
  const f = fixture(t);
  const candidateEntry = path.join(f.root, "candidate.mjs");
  const ipcLog = path.join(f.root, "handoff.jsonl");
  fs.writeFileSync(candidateEntry, `import fs from 'node:fs';
const log = type => fs.appendFileSync(${JSON.stringify(ipcLog)},JSON.stringify({type,pid:process.pid})+'\\n');
process.on('disconnect',()=>process.exit(0));
process.on('message',message=>{log(message.type);if(message.type==='activateCandidate')process.send({type:'candidateConnected'});if(message.type==='commitCandidate')process.send({type:'candidateCommitted'});});
log('candidate-start');process.send({type:'candidatePrepared'});setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(f.root, "worker.mjs"), `import fs from 'node:fs';
const log = type => fs.appendFileSync(${JSON.stringify(ipcLog)},JSON.stringify({type,pid:process.pid})+'\\n');
process.on('disconnect',()=>process.exit(0));
process.on('message',message=>{
 if(message.type!=='launcherCandidateEvent')return;log(message.event.type);
 if(message.event.type==='candidatePrepared')process.send({type:'launcherCandidateCommand',requestId:'fixture-handoff',command:'activateCandidate'});
 if(message.event.type==='candidateConnected')process.send({type:'launcherCandidateCommand',requestId:'fixture-handoff',command:'commitCandidate'});
 if(message.event.type==='candidateCommitted')process.send({type:'launcherReleaseCandidate',requestId:'fixture-handoff'},()=>process.exit(0));
});
log('worker-start');process.send({type:'launcherSpawnCandidate',requestId:'fixture-handoff',entrypoint:${JSON.stringify(candidateEntry)}});setInterval(()=>{},1000);`);
  const launcher = f.run();
  const events = () => fs.existsSync(ipcLog) ? fs.readFileSync(ipcLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  await waitFor(() => events().some(item => item.type === "launcherCommitted"), "candidate promoted");
  assert.deepEqual(events().map(item => item.type), ["worker-start", "candidate-start", "candidatePrepared", "activateCandidate", "candidateConnected", "commitCandidate", "candidateCommitted", "launcherCommitted"]);
  assert.equal(launcher.done, false);
  await f.stopped(); assert.equal(await launcher.closed, 0);
  await waitFor(() => events().every(item => !alive(item.pid)), "handoff children exited");
});

test("diagnostic publication failure releases the kernel lease without spawning", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.diagnostic);
  const failed = f.run(); assert.equal(await failed.closed, 1); assert.equal(f.started().length, 0);
  const busyCheck = f.run(); assert.equal(await busyCheck.closed, 1);
  assert.doesNotMatch(fs.readFileSync(busyCheck.output, "utf8"), /ownership is busy/);
  assert.equal(f.started().length, 0);
});

test("API and upload remain short-lived bypasses even while owner is busy", async t => {
  const f = fixture(t); const launcher = f.run(); await f.ready();
  for (const command of ["--api", "--upload"]) {
    const client = f.run([command]); assert.equal(await client.closed, 0);
    assert.equal(f.started().at(-1).supervised, undefined);
  }
  assert.equal(f.started().length, 3); await f.stopped(); assert.equal(await launcher.closed, 0);
});
