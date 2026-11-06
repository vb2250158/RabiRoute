import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { NapcatLifecycleOwner, type NapcatBinding, type NapcatProcessIdentity } from "./napcatLifecycleOwner.js";
import { validateNapcatRouteCardinality } from "../../../../shared/gatewayConfigModel.js";
import { confirmBundledNapcatStopped } from './napcatProcessDriver.js';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-owner-test-"));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const binding = (id: string): NapcatBinding => ({ gatewayId: `route-${id}`, instanceId: id, workingDir: path.join(root, id), httpUrl: `http://127.0.0.1:${id === "a" ? 3000 : 3001}` });
  const process = (pid: number, id: string, parentPid = 0, name = "NapCatWinBootMain.exe"): NapcatProcessIdentity => ({ pid, parentPid, startedAt: `start-${pid}`, napcatRoot: name === "NapCatWinBootMain.exe", executable: path.join(root, id, name) });
  let processes: NapcatProcessIdentity[] = [];
  let failStop = false;
  const stopped: number[] = [];
  const logs: string[] = [];
  const options = { statePath: path.join(root, "ownership.json"), driver: {
    snapshot: async () => structuredClone(processes),
    terminate: async (item: NapcatProcessIdentity) => {
      if (failStop) throw new Error("cannot stop");
      stopped.push(item.pid); processes = processes.filter(current => current.pid !== item.pid);
    }
  }, log: (event: string) => { logs.push(event); } };
  const owner = new NapcatLifecycleOwner(options);
  const own = async (id: string, pid: number) => { owner.prepareLaunch(binding(id)); await owner.recordLaunch(binding(id), pid); };
  return { root, binding, process, stopped, logs, options, owner, own,
    setProcesses: (value: NapcatProcessIdentity[]) => { processes = value; },
    setFailStop: (value: boolean) => { failStop = value; } };
}

test("one Route cannot own two QQ instances, including disabled extra configuration", async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), gatewayId: "route-a" }]), /一条路由只能/);
  assert.throws(() => validateNapcatRouteCardinality({ id: "route", gatewayPort: 8789, napcatInstances: [
    { id: "a", gatewayPort: 8789, httpUrl: "http://localhost:3000" },
    { id: "b", enabled: false, gatewayPort: 8790, httpUrl: "http://localhost:3001" }
  ] }), /一条路由只能/);
  assert.deepEqual(f.stopped, []);
});

test("correcting management endpoints and first account binding preserve the signed-in process", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.own("a", 10);
  const bound = { ...f.binding("a"), botUserId: "10000", webuiUrl: "http://localhost:6100/webui" };
  await f.owner.reconcile([bound]);
  await f.owner.reconcile([{ ...bound, webuiUrl: "http://localhost:6101/webui" }]);
  assert.deepEqual(f.stopped, []);
  await f.owner.reconcile([{ ...bound, botUserId: "20000" }]);
  assert.deepEqual(f.stopped, [10]);
});

test("startup preserves external NapCat trees even in configured directories and ordinary QQ", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(11, "a", 10, "QQ.exe"), f.process(20, "unbound"), f.process(21, "unbound", 20, "QQ.exe"), f.process(30, "desktop", 0, "QQ.exe")]);
  await f.owner.reconcile([f.binding("a")]);
  assert.deepEqual(f.stopped, []);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, []);
  await f.owner.reconcile([f.binding("a")]);
  assert.equal(await f.owner.run(f.binding("a"), async () => "online"), "online");
  await assert.rejects(f.owner.run(f.binding("b"), async () => "unexpected"), /未绑定/);
});

test("unbind revokes queued and late launch operations, drains an existing operation before stopping", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(20, "b")]);
  await f.owner.reconcile([f.binding("a"), f.binding("b")]);
  await f.own("a", 10); await f.own("b", 20);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const active = f.owner.run(f.binding("a"), async () => {
    started(); await held;
    assert.throws(() => f.owner.prepareLaunch(f.binding("a")), /未绑定/);
  });
  await ready;
  const queued = assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  const removing = f.owner.reconcile([f.binding("b")]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.stopped, []);
  assert.equal(await f.owner.run(f.binding("b"), async () => "still online"), "still online");
  release(); await Promise.all([active, queued, removing]);
  assert.deepEqual(f.stopped, [10]);
});

test("a Manager restart recovers ownership and never kills a recycled PID now owned by ordinary QQ", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(11, "a", 10, "QQ.exe")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.own("a", 10);
  f.setProcesses([{ ...f.process(10, "desktop", 0, "QQ.exe"), startedAt: "reused" }, f.process(11, "a", 0, "QQ.exe")]);
  const recovered = new NapcatLifecycleOwner(f.options);
  await recovered.reconcile([]);
  assert.deepEqual(f.stopped, [11]);
});

test("stop failure is not an unbind success, blocks relaunch, and remains retryable", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.own("a", 10);
  f.setFailStop(true);
  await assert.rejects(f.owner.reconcile([]), /停止失败/);
  await assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records.length, 1);
  f.setFailStop(false);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});

test("two bindings cannot share or nest a process directory", async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), workingDir: f.binding("a").workingDir }]), /共用/);
  await assert.rejects(f.owner.reconcile([f.binding("a"), { ...f.binding("b"), workingDir: path.join(f.binding("a").workingDir!, "nested") }]), /共用/);
});

test("nested login/start commands reuse the same lease and restart retains the binding", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.own("a", 10);
  await f.owner.run(f.binding("a"), () => f.owner.run(f.binding("a"), async () => {
    await f.owner.stopForRestart(f.binding("a"));
    f.owner.prepareLaunch(f.binding("a"));
    f.setProcesses([f.process(12, "a")]);
    await f.owner.recordLaunch(f.binding("a"), 12);
  }));
  assert.deepEqual(f.stopped, [10]);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10, 12]);
});

test("failed explicit removal remains blocked across unchanged snapshots and can be retried", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]);
  await f.own("a", 10);
  f.setFailStop(true);
  await assert.rejects(f.owner.remove(f.binding("a")), /停止失败/);
  const restarted = new NapcatLifecycleOwner(f.options);
  await assert.rejects(restarted.reconcile([f.binding("a")]), /停止失败/);
  f.setFailStop(false);
  await f.owner.reconcile([f.binding("a")]);
  await assert.rejects(f.owner.run(f.binding("a"), async () => "unexpected"), /未绑定/);
  f.setFailStop(false);
  await f.owner.remove(f.binding("a"));
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});


test("owned cleanup preserves an unrelated process in the same directory", async t => {
  const f = fixture(t);
  await f.owner.reconcile([f.binding("a")]);
  f.setProcesses([f.process(10, "a"), f.process(20, "a")]);
  await f.own("a", 10);
  await f.owner.recordLaunch(f.binding("a"));
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});

test("a persisted launch intent without captured identity cannot claim an external process", async t => {
  const f = fixture(t);
  await f.owner.reconcile([f.binding("a")]);
  f.owner.prepareLaunch(f.binding("a"));
  f.setProcesses([f.process(20, "a")]);
  const restarted = new NapcatLifecycleOwner(f.options);
  await restarted.reconcile([]);
  assert.deepEqual(f.stopped, []);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records.length, 1);
  await restarted.reconcile([f.binding("a")]);
  assert.throws(() => restarted.prepareLaunch(f.binding("a")), /身份尚未确认/);
  await assert.rejects(restarted.remove(f.binding("a")), /启动结果尚未确认/);
});

test("an empty independent owner never enumerates or terminates machine processes", async t => {
  const f = fixture(t);
  const owner = new NapcatLifecycleOwner({ ...f.options, driver: {
    snapshot: async () => { throw new Error("Unrelated machine discovery must not run"); },
    terminate: async () => { throw new Error("Unowned process must not be stopped"); }
  } });
  await owner.reconcile([]);
  await owner.reconcile([f.binding("a")]);
});

test("final shutdown drains accepted work, stops only owned trees, and permanently rejects new starts", async t => {
  const f = fixture(t);
  f.setProcesses([f.process(10, "a"), f.process(11, "a", 10, "QQ.exe"), f.process(30, "desktop", 0, "QQ.exe")]);
  await f.owner.reconcile([f.binding("a")]); await f.own("a", 10);
  let release!: () => void, accepted!: () => void;
  const ready = new Promise<void>(resolve => { accepted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = f.owner.run(f.binding("a"), async () => { accepted(); await held; });
  await ready;
  const stopping = f.owner.shutdown();
  assert.equal(f.owner.shutdown(), stopping);
  await assert.rejects(f.owner.run(f.binding("a"), async () => {}), /未绑定/);
  assert.deepEqual(f.stopped, []);
  release(); await work; await stopping;
  assert.deepEqual(f.stopped, [10, 11]);
  await assert.rejects(f.owner.run(f.binding("a"), async () => {}), /未绑定/);
});

test("final shutdown retains uncertain launch identities and stop failures", async t => {
  const f = fixture(t); await f.owner.reconcile([f.binding("a")]); f.owner.prepareLaunch(f.binding("a"));
  await assert.rejects(f.owner.shutdown(), /retirement remains unconfirmed/);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records[0].launchPending, true);
  assert.deepEqual(f.stopped, []);
});

test("an unreadable owned identity cannot become a successful stop; unrelated unreadable processes are harmless", async t => {
  const f = fixture(t); f.setProcesses([f.process(10, "a")]);
  await f.owner.reconcile([f.binding("a")]); await f.own("a", 10);
  f.setProcesses([{ ...f.process(10, "a"), executable: "" }, f.process(30, "desktop", 0, "QQ.exe")]);
  await assert.rejects(f.owner.reconcile([]), /身份暂不可读/);
  assert.deepEqual(f.stopped, []);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records[0].processes[0].pid, 10);
  f.setProcesses([f.process(10, "a"), { ...f.process(30, "desktop", 0, "QQ.exe"), executable: "", startedAt: "" }]);
  await f.owner.reconcile([]);
  assert.deepEqual(f.stopped, [10]);
});


test("a new uncaptured launch remains uncertain despite an earlier recorded process", async t => {
  const f = fixture(t);
  await f.owner.reconcile([f.binding("a")]);
  f.setProcesses([f.process(10, "a")]); await f.own("a", 10);
  f.setProcesses([]);
  f.owner.prepareLaunch(f.binding("a"));
  await f.owner.recordLaunch(f.binding("a"));
  const restarted = new NapcatLifecycleOwner(f.options);
  await restarted.reconcile([f.binding("a")]);
  assert.throws(() => restarted.prepareLaunch(f.binding("a")), /身份尚未确认/);
  f.setProcesses([f.process(12, "a")]);
  await restarted.recordLaunch(f.binding("a"), 12);
  await restarted.reconcile([]);
  assert.deepEqual(f.stopped, [12]);
});


test("a known spawn failure releases only that unstarted intent and permits retry", async t => {
  const f = fixture(t); await f.owner.reconcile([f.binding("a")]);
  await assert.rejects(f.owner.launch(f.binding("a"), () => spawn(path.join(f.root, "missing-executable"), [], { windowsHide: true })), /ENOENT/);
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records.length, 0);
  f.owner.prepareLaunch(f.binding("a"));
});

test("a temporarily missing snapshot captures the original live child on later refresh", async t => {
  const f = fixture(t); await f.owner.reconcile([f.binding("a")]);
  let child!: ReturnType<typeof spawn>;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; } });
  await f.owner.launch(f.binding("a"), () => child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" }));
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records[0].launchPending, true);
  f.setProcesses([f.process(child.pid!, "a")]);
  await f.owner.recordLaunch(f.binding("a"));
  assert.equal(JSON.parse(fs.readFileSync(f.options.statePath, "utf8")).records[0].launchPending, undefined);
  await f.owner.reconcile([]); assert.deepEqual(f.stopped, [child.pid]);
});

test('a legacy pending launch recovers only with a bundled absence proof and retains its original record', async t => {
  const f=fixture(t);await f.owner.reconcile([f.binding('a')]);f.owner.prepareLaunch(f.binding('a'));
  const original=JSON.parse(fs.readFileSync(f.options.statePath,'utf8')).records[0];
  const proof={checkedAt:new Date().toISOString(),commandPath:path.join(f.root,'a','NapCatWinBootMain.exe')};
  const owner=new NapcatLifecycleOwner({...f.options,driver:{...f.options.driver,confirmBundledInstanceStopped:async()=>proof}});
  await owner.reconcile([f.binding('a')]);let closed!:Promise<unknown>;
  const child=await owner.run(f.binding('a'),()=>owner.launch(f.binding('a'),()=>{const process=spawn(globalThis.process.execPath,['-e','process.exit(7)'],{windowsHide:true,stdio:'ignore'});closed=once(process,'close');return process;}, {cwd:path.join(f.root,'a'),commandPath:proof.commandPath}));
  await closed;
  const recovered=JSON.parse(fs.readFileSync(f.options.statePath,'utf8')).records[0];
  const archive=JSON.parse(fs.readFileSync(recovered.recoveredLaunch.archive,'utf8'));
  assert.equal(archive.resolution,'no-live-instance');assert.deepEqual(archive.record,original);
  assert.equal(recovered.launchAttempt.pid,child.pid);assert.equal(recovered.launchAttempt.exitCode,7);assert.ok(recovered.launchAttempt.closedAt);
  assert.notEqual(recovered.launchAttempt.id,original.launchAttempt.id);
});

test('unproven pending launch remains fenced, including a closed launcher with possible children', async t => {
  const f=fixture(t);await f.owner.reconcile([f.binding('a')]);f.owner.prepareLaunch(f.binding('a'));
  const owner=new NapcatLifecycleOwner({...f.options,driver:{...f.options.driver,confirmBundledInstanceStopped:async()=>undefined}});
  await owner.reconcile([f.binding('a')]);let spawned=false;
  await assert.rejects(owner.run(f.binding('a'),()=>owner.launch(f.binding('a'),()=>{spawned=true;throw Error('must not spawn');},{cwd:f.root,commandPath:'launcher'})),/身份尚未确认/);
  assert.equal(spawned,false);assert.equal(fs.existsSync(f.options.statePath+'.history'),false);
});

test('a live original child cannot be replaced even when a driver supplies absence proof', async t => {
  const f=fixture(t);let checks=0;const owner=new NapcatLifecycleOwner({...f.options,driver:{...f.options.driver,confirmBundledInstanceStopped:async()=>{checks++;return {checkedAt:'now',commandPath:'launcher'};}}});
  await owner.reconcile([f.binding('a')]);let child!:ReturnType<typeof spawn>;
  await owner.launch(f.binding('a'),()=>child=spawn(globalThis.process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}));
  t.after(async()=>{const closed=once(child,'close');child.kill();await closed;});
  await assert.rejects(owner.launch(f.binding('a'),()=>{throw Error('must not replace');},{cwd:f.root,commandPath:'launcher'}),/身份尚未确认/);
  assert.equal(checks,0);
});

test('external launch plans and incomplete bundled layouts never provide stopped proof', async t => {
  const f=fixture(t);
  assert.equal(await confirmBundledNapcatStopped(f.binding('a'),{cwd:f.root,commandPath:'external.exe'}),undefined);
  assert.equal(await confirmBundledNapcatStopped(f.binding('a'),{cwd:path.join(f.root,'a'),commandPath:path.join(f.root,'a','NapCatWinBootMain.exe')}),undefined);
});

test('failure to persist a recovered launch keeps the original pending fence in memory',async t=>{
  const f=fixture(t);await f.owner.reconcile([f.binding('a')]);f.owner.prepareLaunch(f.binding('a'));
  const owner=new NapcatLifecycleOwner({...f.options,driver:{...f.options.driver,confirmBundledInstanceStopped:async()=>({checkedAt:'now',commandPath:'bundled'})}});
  await owner.reconcile([f.binding('a')]);
  const saved=fs.readFileSync(f.options.statePath);fs.unlinkSync(f.options.statePath);fs.mkdirSync(f.options.statePath);
  let spawned=false;
  await assert.rejects(owner.launch(f.binding('a'),()=>{spawned=true;throw Error('must not start');},{cwd:f.root,commandPath:'bundled'}));
  assert.equal(spawned,false);assert.throws(()=>owner.prepareLaunch(f.binding('a')),/身份尚未确认/);
  fs.rmdirSync(f.options.statePath);fs.writeFileSync(f.options.statePath,saved);
});
