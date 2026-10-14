import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { __test } from "../rabi-agent.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error("Desktop fixture timed out.");
}
function launch(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options });
  let output = ""; let errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { errors += value; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, closed, output: () => output, errors: () => errors };
}

test("public runtime snapshots exclude credentials and message content; reconnect preserves task ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-public-state-"));
  const runtime = new __test.RabiAgentRuntime({ managerUrl: "http://manager.invalid", nodeCredential: "private-fixture-value",
    nodeId: "fixture", agents: [{ agentId: "fixture", provider: "codex", sessionId: "bound-task", workspace: root }] }, path.join(root, "config.json"));
  try {
    const before = JSON.stringify(runtime.publishDesktop());
    assert.doesNotMatch(before, /private-fixture-value|nodeCredential|workspace/);
    runtime.taskByThread.set("bound-task", "task-one");
    let closed = false; let connected = false;
    runtime.socket = { close: () => { closed = true; } };
    runtime.connect = () => { connected = true; };
    runtime.reconnect();
    assert.equal(closed, true); assert.equal(connected, true);
    assert.equal(runtime.taskByThread.get("bound-task"), "task-one");
    assert.equal(runtime.publishDesktop().busy, true);
  } finally { runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a child mode without the main-program IPC cannot start an independent connector", async () => {
  const child = launch(process.execPath, [path.resolve("apps/rabi-agent/rabi-agent.mjs"), "--run"], {
    env: { ...process.env, RABI_AGENT_SUPERVISED: "1", RABI_AGENT_UPDATE_CANDIDATE: "0" }
  });
  assert.equal(await child.closed, 1);
  assert.match(child.errors(), /requires the main program IPC/);
});

test("native tray renders owner snapshots and exits when its owner pipe closes", { skip: process.platform !== "win32" }, async t => {
  const script = path.resolve("apps/rabi-agent/desktop/tray.ps1");
  const ui = launch("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script]);
  t.after(() => { if (alive(ui.child.pid)) ui.child.kill(); });
  await waitFor(() => ui.output().includes('"type":"ready"'));
  ui.child.stdin.write(`${JSON.stringify({ type: "snapshot", summary: "已连接主机", running: true, busy: false, startup: true, details: "无凭据状态记录" })}\n`);
  await waitFor(() => ui.output().includes('"type":"rendered"'));
  const rendered = ui.output().trim().split("\n").map(JSON.parse).find(item => item.type === "rendered");
  assert.equal(rendered.summary, "已连接主机"); assert.equal(rendered.startup, true); assert.equal(rendered.visible, true);
  ui.child.stdin.end();
  assert.equal(await ui.closed, 0, ui.errors());
});

async function ownerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-desktop-owner-"));
  const config = path.join(root, "config.json"); const entry = path.join(root, "worker.mjs");
  const configBytes = JSON.stringify({ nodeId: "fixture", nodeCredential: "private-fixture-value", agents: [] });
  fs.writeFileSync(config, configBytes);
  fs.writeFileSync(entry, `
process.send({type:'desktopSnapshot', summary:'已连接主机',version:'fixture',agents:'codex: bound-task',task:'',busy:false,managerOrigin:'http://manager.invalid',nodeCredential:'private-fixture-value'});
process.on('message', m=>{if(m.type==='desktopReconnect')process.send({type:'desktopSnapshot',summary:'已重新连接主机',busy:false});});
process.on('disconnect',()=>process.exit(0));
setInterval(()=>{},1000);
`);
  if (process.platform === "win32") {
    fs.mkdirSync(path.join(root, "desktop"));
    fs.copyFileSync(path.resolve("apps/rabi-agent/desktop/tray.ps1"), path.join(root, "desktop", "tray.ps1"));
  }
  __test.writeCurrentRelease(config, entry, "a".repeat(64));
  const pointerBytes = fs.readFileSync(path.join(root, "current-release.json"));
  const launcher = __test.writeLauncher(config);
  const owner = launch(process.execPath, [launcher, "--config", config], {
    env: { ...process.env, APPDATA: path.join(root, "appdata"), USERPROFILE: root }
  });
  const children = new Set();
  const command = async action => {
    const client = launch(process.execPath, [launcher, "--config", config, "--command", action]);
    const code = await client.closed;
    assert.equal(code, 0, client.errors());
    const receipt = JSON.parse(client.output());
    if (receipt.workerPid) children.add(receipt.workerPid);
    if (receipt.trayPid) children.add(receipt.trayPid);
    return receipt;
  };
  t.after(async () => {
    if (alive(owner.child.pid)) owner.child.kill();
    await owner.closed;
    await waitFor(() => [...children].every(pid => !alive(pid)));
    assert.equal(fs.readFileSync(config, "utf8"), configBytes);
    assert.deepEqual(fs.readFileSync(path.join(root, "current-release.json")), pointerBytes);
    fs.rmSync(root, { recursive: true, force: true });
  });
  let state;
  await waitFor(async () => { try { state = await command("status"); return state.summary === "已连接主机"; } catch { return false; } });
  return { root, owner, command, state, launcher, config };
}

test("one owner retains its tray across pause, start, restart and reconnect; stop waits for all children", async t => {
  const f = await ownerFixture(t);
  const first = f.state;
  assert.doesNotMatch(JSON.stringify(first), /private-fixture-value|nodeCredential/);
  const paused = await f.command("pause");
  assert.equal(paused.pid, first.pid); assert.equal(paused.trayPid, first.trayPid); assert.equal(paused.running, false);
  assert.equal(alive(first.workerPid), false);
  const started = await f.command("start");
  assert.equal(started.pid, first.pid); assert.notEqual(started.workerPid, first.workerPid);
  const restarted = await f.command("restart");
  assert.equal(restarted.pid, first.pid); assert.equal(restarted.trayPid, first.trayPid);
  assert.notEqual(restarted.workerPid, started.workerPid); assert.equal(alive(started.workerPid), false);
  await f.command("reconnect");
  await waitFor(async () => (await f.command("status")).summary === "已重新连接主机");
  const duplicate = launch(process.execPath, [f.launcher, "--config", f.config]);
  assert.equal(await duplicate.closed, 1); assert.match(duplicate.errors(), /ownership is busy/);
  const stop = launch(process.execPath, [f.launcher, "--config", f.config, "--stop"]);
  assert.equal(await stop.closed, 0, stop.errors()); assert.equal(await f.owner.closed, 0);
  assert.equal(alive(restarted.workerPid), false);
  if (first.trayPid) assert.equal(alive(first.trayPid), false);
});

test("abrupt main-program death releases both worker and native presentation", async t => {
  const f = await ownerFixture(t);
  f.owner.child.kill("SIGKILL"); await f.owner.closed;
  await waitFor(() => !alive(f.state.workerPid) && (!f.state.trayPid || !alive(f.state.trayPid)));
});

test("startup settings use the main owner and preserve foreign startup files", { skip: process.platform !== "win32" }, async t => {
  const f = await ownerFixture(t);
  const startup = path.join(f.root, "appdata", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "RabiAgent.vbs");
  assert.equal((await f.command("enable-startup")).startup, true);
  const bytes = fs.readFileSync(startup);
  assert.equal((await f.command("disable-startup")).startup, false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "startup-before-change.vbs")), bytes);
  fs.writeFileSync(startup, "foreign startup");
  await assert.rejects(() => f.command("disable-startup"));
  assert.equal(fs.readFileSync(startup, "utf8"), "foreign startup");
});

test("native menu actions submit commands and checked state only changes after owner readback", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-tray-menu-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve("apps/rabi-agent/desktop/tray.ps1"), "utf8");
  const harness = source.replace("[RabiAgentPresentation]::Run()", `
$ui = New-Object RabiAgentPresentation
$flags = [System.Reflection.BindingFlags]'Instance,NonPublic'
$data = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$data.Add('summary','已连接主机'); $data.Add('running',$true); $data.Add('busy',$false); $data.Add('startup',$true)
$parameters = New-Object object[] 1
$parameters.SetValue($data,0)
$ui.GetType().GetMethod('Render',$flags).Invoke($ui,$parameters) | Out-Null
foreach($name in @('start','pause','reconnect','startup','exit')){ $ui.GetType().GetField($name,$flags).GetValue($ui).PerformClick() }
$checked = $ui.GetType().GetField('startup',$flags).GetValue($ui).Checked
[Console]::WriteLine('{"type":"checked-after-click","value":'+$checked.ToString().ToLower()+'}')
$ui.GetType().GetMethod('ExitThreadCore',$flags).Invoke($ui,@()) | Out-Null
`);
  const script = path.join(root, "menu.ps1");
  fs.writeFileSync(script, harness.startsWith("\ufeff") ? harness : `\ufeff${harness}`);
  const ui = launch("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script]);
  assert.equal(await ui.closed, 0, ui.errors());
  const events = ui.output().trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter(event => event.type === "command").map(event => event.action), ["pause", "reconnect", "startup", "exit"]);
  assert.equal(events.find(event => event.action === "startup").enabled, false);
  assert.equal(events.find(event => event.type === "checked-after-click").value, true);
});
