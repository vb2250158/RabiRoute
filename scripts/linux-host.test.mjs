import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LinuxHost, loopbackUrl, validateReady, validateMeta, requestJson, readDescriptor, sendHostCommand } from "./lib/linux-host-runtime.mjs";
import { parseArguments } from "./linux-host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureSource = `
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const generation = process.env.RABIROUTE_APPLICATION_GENERATION_ID;
const instance = randomUUID();
const server = http.createServer((req,res) => {
  res.setHeader('content-type','application/json');
  if (req.url === '/meta') res.end(JSON.stringify({ applicationGenerationId:generation, managerInstanceId:instance,
    health:{live:true,requiredReady:true,state:'healthy',businessReady:false}}));
  else if (req.url === '/_rabiroute/host/shutdown' && req.headers['x-rabiroute-host-token'] === process.env.RABIROUTE_HOST_CONTROL_TOKEN) {
    res.end(JSON.stringify({ok:true})); setImmediate(()=>server.close(()=>process.exit(0)));
  } else {res.statusCode=404;res.end('{}');}
});
process.once('disconnect',()=>server.close(()=>process.exit(0)));
process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
if(process.env.GRANDCHILD_FILE){const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.env.GRANDCHILD_FILE,String(grandchild.pid));}
server.listen(0,'127.0.0.1',()=>setTimeout(()=>console.log('RABIROUTE_MANAGER_READY:'+JSON.stringify({protocolVersion:1,
  applicationGenerationId:process.env.BAD_READY==='1'?'wrong':generation,managerInstanceId:instance,pid:process.pid,
  baseUrl:'http://127.0.0.1:'+server.address().port,readyAt:new Date().toISOString()})),Number(process.env.READY_DELAY_MS)||0));
`;

async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-linux-host-test-"));
  const entry = path.join(dir, "manager.mjs"); fs.writeFileSync(entry, fixtureSource);
  let released = false;
  const host = new LinuxHost({ packageRoot: root, stateRoot: dir, managerEntry: entry,
    descriptorFile: path.join(dir, "control.json"), logPath: path.join(dir, "host.log"),
    readOnly: true, autostart: false, startupTimeoutMs: 2000, stopTimeoutMs: 500,
    lease: { async release() { released = true; } }, ...extra });
  t.after(async () => { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const startup = host.start();
  const concurrent = extra.duringStart?.(host, dir);
  await startup;
  await concurrent;
  return { host, dir, released: () => released };
}

test("Linux Host only accepts complete, matching READY identities and loopback origins", () => {
  const ready = { protocolVersion: 1, applicationGenerationId: "generation", managerInstanceId: "instance", pid: 5, baseUrl: "http://127.0.0.1:12345", readyAt: "now" };
  assert.equal(validateReady(ready, "generation", 5).baseUrl, ready.baseUrl);
  for (const url of ["https://127.0.0.1:12345", "http://example.com:12345", "http://127.0.0.1:12345/path", "http://u:p@127.0.0.1:12345", "http://127.0.0.1:12345/#secret"]) assert.throws(() => loopbackUrl(url));
  assert.throws(() => validateReady(ready, "other", 5));
  assert.throws(() => validateReady(ready, "generation", 6));
  assert.throws(() => validateReady({ ...ready, managerInstanceId: "" }, "generation", 5));
  assert.equal(validateMeta({ applicationGenerationId: "generation", managerInstanceId: "instance", health: { live: true, requiredReady: true, state: "degraded", businessReady: false } }, ready), "degraded");
  assert.throws(() => validateMeta({ applicationGenerationId: "other", managerInstanceId: "instance" }, ready));
});

test("CLI rejects unsupported arguments and makes read-only imply no automatic integrations", () => {
  assert.equal(parseArguments(["--read-only"]).autostart, false);
  assert.equal(parseArguments(["--command", "stop"]).command, "quit");
  assert.throws(() => parseArguments(["--state-root", "relative"]));
  assert.throws(() => parseArguments(["--token", "secret"]));
  assert.throws(() => parseArguments(["--command"]));
  assert.equal(parseArguments(["--state-root", `${root}/../${path.basename(root)}/`]).stateRoot, root);
});

test("Host starts, verifies health, denies unauthorized control, fences restart, and stops cleanly", async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, "control.json");
  const descriptor = readDescriptor(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const first = await sendHostCommand(file, "status");
  assert.equal(first.ok, true); assert.equal(first.state, "healthy");
  assert.equal(first.readOnly, true); assert.equal(first.autostart, false);
  assert.equal(JSON.stringify(first).includes(descriptor.controlToken), false);
  await assert.rejects(requestJson(`${descriptor.baseUrl}/control`, { method: "POST", body: '{}' }), /authorization/);
  await assert.rejects(requestJson(`${descriptor.baseUrl}/control`, { method: "POST", headers: { origin: "https://example.com", "x-rabiroute-host-token": descriptor.controlToken }, body: '{}' }), /authorization/);
  await assert.rejects(sendHostCommand(file, "restart", "stale"), /generation/);
  const next = await sendHostCommand(file, "restart", first.applicationGenerationId);
  assert.equal(next.state, "healthy");
  assert.notEqual(next.applicationGenerationId, first.applicationGenerationId);
  assert.notEqual(next.managerInstanceId, first.managerInstanceId);
  await assert.rejects(sendHostCommand(file, "quit", first.applicationGenerationId), /generation/);
  const quit = await sendHostCommand(file, "quit", next.applicationGenerationId);
  assert.equal(quit.ok, true);
  await f.host.close();
  assert.equal(f.released(), true);
  assert.equal(fs.existsSync(file), false);
});

test("Host rejects mismatched READY and cleans up the owned Manager", async t => {
  const f = await fixture(t, { env: { BAD_READY: "1" } });
  assert.equal(f.host.state, "faulted");
  assert.equal(f.host.child, null);
  assert.equal((await f.host.status()).ok, false);
});

test("Manager exit creates a fresh, verified generation within bounded recovery", async t => {
  const f = await fixture(t);
  const first = f.host.ready;
  process.kill(f.host.child.pid, "SIGTERM");
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && (!f.host.ready || f.host.ready.applicationGenerationId === first.applicationGenerationId)) await sleep(30);
  assert.equal(f.host.state, "healthy");
  assert.notEqual(f.host.ready.applicationGenerationId, first.applicationGenerationId);
});

test("Private descriptor rejects permissive modes and symlinks", async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, "control.json");
  fs.chmodSync(file, 0o644); assert.throws(() => readDescriptor(file), /private/); fs.chmodSync(file, 0o600);
  const link = path.join(f.dir, "link.json"); fs.symlinkSync(file, link);
  assert.throws(() => readDescriptor(link), /private/);
});

test("Restart queued during first READY admission cannot fault or kill its replacement", async t => {
  const f = await fixture(t, { env: { READY_DELAY_MS: "180" }, duringStart: async (host, dir) => {
    await sleep(50);
    const file = path.join(dir, "control.json");
    const initial = await sendHostCommand(file, "status");
    const restarted = await sendHostCommand(file, "restart", initial.applicationGenerationId);
    assert.equal(restarted.ok, true); assert.equal(restarted.state, "healthy");
    assert.notEqual(restarted.applicationGenerationId, initial.applicationGenerationId);
  } });
  assert.equal(f.host.state, "healthy"); assert.ok(f.host.child);
});

test("Shutdown reclaims same-group descendants after the Manager leader exits", async t => {
  const record = path.join(os.tmpdir(), `rabi-grandchild-${process.pid}-${Date.now()}.txt`);
  t.after(() => fs.rmSync(record, { force: true }));
  const f = await fixture(t, { env: { GRANDCHILD_FILE: record } });
  const grandchild = Number(fs.readFileSync(record, "utf8"));
  await sleep(80);
  await f.host.close();
  let state;
  try { const text = fs.readFileSync(`/proc/${grandchild}/stat`, "utf8"); state = text.slice(text.lastIndexOf(")") + 2).split(" ")[0]; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.ok(state === undefined || state === "Z" || state === "X", `grandchild remained live: ${state}`);
});

test("Concurrent restarts cannot reuse the same generation fence", async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, "control.json"), generation = f.host.generation;
  const results = await Promise.allSettled([sendHostCommand(file, "restart", generation), sendHostCommand(file, "restart", generation)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.filter(value => value.status === "rejected").length, 1);
  assert.equal(f.host.state, "healthy");
});

test("Failed restart reclaims its child and leaves an explicit faulted state", async t => {
  const f = await fixture(t);
  f.host.options.env = { BAD_READY: "1" };
  await assert.rejects(sendHostCommand(path.join(f.dir, "control.json"), "restart", f.host.generation), /READY identity/);
  assert.equal(f.host.state, "faulted"); assert.equal(f.host.child, null);
});

test("Failed fork faults cleanly without an unhandled child error or invalid PID signal", async t => {
  const f = await fixture(t, { packageRoot: path.join(os.tmpdir(), `rabi-absent-${process.pid}-${Date.now()}`) });
  assert.equal(f.host.state, "faulted"); assert.equal(f.host.child, null);
});
