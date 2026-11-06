import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import test from "node:test";
import { ProcessLeaseRegistry, type ProcessLeaseOwner } from "./processLeaseRegistry.js";
import { WindowsJobTree } from "./windowsJobObject.mjs";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const owner: ProcessLeaseOwner = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager",
  activationId: "fixture-activation", instanceId: "fixture-owner", revision: "one" };
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
async function until(ready: () => boolean, maximumMs = 10_000) {
  const deadline = Date.now() + maximumMs;
  while (!ready()) { if (Date.now() >= deadline) throw new Error("Protected process fixture did not reach its expected state."); await turn(); }
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-native-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root: string, name: string, code: string) {
  const file = path.join(root, name); await fs.writeFile(file, code); return file;
}
function native() {
  const koffi = createRequire(import.meta.url)("koffi"), kernel = koffi.load("kernel32.dll");
  return {
    openProcess: kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    openJob: kernel.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)"),
    inJob: kernel.func("int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)"),
    wait: kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)"),
    terminate: kernel.func("int __stdcall TerminateProcess(void *process, uint32_t code)"),
    close: kernel.func("int __stdcall CloseHandle(void *handle)")
  };
}
function ownedProcessHandle(pid: number, jobName: string) {
  const api = native();
  const processHandle = api.openProcess(0x100401, 0, pid), job = api.openJob(4, 0, jobName);
  assert.ok(processHandle); assert.ok(job);
  try { const member = [0]; assert.ok(api.inJob(processHandle, job, member)); assert.equal(member[0], 1); }
  catch (error) { api.close(processHandle); throw error; }
  finally { api.close(job); }
  return { exited: () => api.wait(processHandle, 0) === 0,
    dispose: () => { if (api.wait(processHandle, 0) !== 0) api.terminate(processHandle, 1); api.close(processHandle); } };
}

test("a protected fork retains original IPC, argv, source loader and a cleared launch environment", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry();
  t.after(() => registry.disposeAll());
  const entry = await write(root, "fork.mjs", `process.on('message', message => process.send({message, argv:process.argv,
    pid:process.pid, leaked:process.env.RABIROUTE_PROTECTED_LAUNCH}));`);
  const lease = registry.launch(owner, "ipc", { kind: "fork", entry, args: ["argument with spaces"],
    options: { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: {} } });
  const response = once(lease.child, "message");
  lease.child.send({ first: "queued before bootstrap admission" });
  const [message] = await response;
  assert.equal(message.pid, lease.child.pid);
  assert.deepEqual(message.message, { first: "queued before bootstrap admission" });
  assert.deepEqual(message.argv, [process.execPath, entry, "argument with spaces"]);
  assert.equal(message.leaked, undefined);
  await registry.terminateOwner(owner);
  assert.equal(registry.list().length, 0);
});

test("first cancellation closes a just-forked bootstrap before terminating its empty Job", windows, async t => {
  for (const paused of [false, true]) await t.test(paused ? "controlled pre-admission debugger pause" : "immediate cancellation", async t => {
    const root = await fixture(t), registry = new ProcessLeaseRegistry();
    const marker = path.join(root, "business-must-not-run");
    const entry = await write(root, "late-descendant.mjs", `import fs from 'node:fs';import {spawn} from 'node:child_process';
      fs.writeFileSync(${JSON.stringify(marker)},'executed');
      spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'}).unref();`);
    let rootWasKilled = () => false;
    const originalTerminate = WindowsJobTree.prototype.terminate;
    const termination = t.mock.method(WindowsJobTree.prototype, "terminate", function(this: WindowsJobTree) {
      assert.equal(rootWasKilled(), true, "stop the original root handle before terminating its Job");
      originalTerminate.call(this);
    });
    const lease = registry.launch(owner, "cancel-before-admission", { kind: "fork", entry,
      options: { execArgv: paused ? ["--inspect-brk=0"] : [], stdio: ["ignore", "ignore", "pipe", "ipc"] } });
    rootWasKilled = () => lease.child.killed;
    const closed = once(lease.child, "close"), api = native();
    const handle = api.openProcess(0x100401, 0, lease.child.pid!);
    assert.ok(handle);
    t.after(async () => { await registry.disposeAll(); if (api.wait(handle, 0) !== 0) api.terminate(handle, 1); api.close(handle); });
    if (paused) {
      let output = "";
      lease.child.stderr!.on("data", data => { output += String(data); });
      await until(() => output.includes("Debugger listening on ws://"));
      assert.equal(lease.tree!.activeCount(), 0);
    }
    try { await registry.terminateOwner(owner); await closed; }
    finally { termination.mock.restore(); }
    assert.equal(termination.mock.callCount(), 1);
    await until(() => api.wait(handle, 0) === 0);
    assert.equal(lease.tree!.closed, true);
    assert.equal(lease.tree!.activeCount(), 0);
    assert.equal(registry.list().length, 0);
    assert.equal(api.openJob(4, 0, lease.tree!.name), null, "the Job handle is closed after first cancellation");
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  });
});

test("failed pre-admission root kills still terminate the Job and retain their diagnostic", windows, async t => {
  for (const throws of [false, true]) await t.test(throws ? "kill throws" : "kill returns false", async t => {
    const root = await fixture(t), registry = new ProcessLeaseRegistry(undefined, { terminationTimeoutMs: 100 });
    const marker = path.join(root, "must-not-run");
    const entry = await write(root, "forbidden.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
    const termination = t.mock.method(WindowsJobTree.prototype, "terminate");
    const lease = registry.launch(owner, "failed-early-cancel", { kind: "fork", entry,
      options: { execArgv: ["--inspect-brk=0"], stdio: ["ignore", "ignore", "pipe", "ipc"] } });
    const closed = once(lease.child, "close");
    let output = "";
    lease.child.stderr!.on("data", data => { output += String(data); });
    t.after(() => registry.disposeAll());
    await until(() => output.includes("Debugger listening on ws://"));
    const kill = t.mock.method(lease.child, "kill", () => {
      if (throws) throw new Error("controlled original-handle kill failure");
      return false;
    });
    try {
      await assert.rejects(registry.terminateOwner(owner), /tree lease did not confirm exit/);
      assert.equal(termination.mock.callCount(), 1);
      assert.match(lease.tree!.failure?.message ?? "", throws ? /controlled original-handle kill failure/ : /termination was not accepted/);
      assert.equal(registry.list().length, 1);
      assert.equal(lease.tree!.closed, false);
    } finally { kill.mock.restore(); termination.mock.restore(); await registry.terminateOwner(owner); await closed; }
    assert.equal(lease.tree!.closed, true);
    assert.equal(registry.list().length, 0);
    const api = native();
    assert.equal(api.openJob(4, 0, lease.tree!.name), null);
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  });
});

test("protected native spawn preserves PowerShell stdout and the command's exit code", windows, async t => {
  const registry = new ProcessLeaseRegistry();
  t.after(() => registry.disposeAll());
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const lease = registry.launch(owner, "native-powershell", { kind: "spawn", command: executable,
    args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('protected-native-output'); exit 7"],
    options: { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] } });
  let output = "";
  lease.child.stdout!.on("data", data => { output += String(data); });
  await once(lease.child, "close"); await lease.settled;
  assert.equal(output.trim(), "protected-native-output");
  assert.equal(lease.child.exitCode, 7);
  assert.equal(registry.list().length, 0);
});

test("a root exit cannot release a detached descendant's exclusive tree lease", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry();
  const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const externalClosed = once(external, "close");
  t.after(async () => { await registry.disposeAll(); if (external.exitCode === null && external.signalCode === null) external.kill(); await externalClosed; });
  const entry = await write(root, "root.mjs", `import {spawn} from 'node:child_process';
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});
    c.unref();process.send({grandPid:c.pid},()=>process.exit(0));`);
  const lease = registry.launch(owner, "exclusive-tree", { kind: "fork", entry,
    options: { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] } }, { exclusiveAcrossOwners: true });
  const [{ grandPid }] = await once(lease.child, "message");
  const held = ownedProcessHandle(grandPid, lease.tree!.name);
  t.after(held.dispose);
  await once(lease.child, "close");
  assert.equal(lease.child.exitCode, 0);
  assert.equal(held.exited(), false);
  assert.equal(registry.list(owner).length, 1);
  assert.equal(await registry.drainOwner(owner, 30), false);
  assert.throws(() => registry.launch({ ...owner, activationId: "next" }, "exclusive-tree", {
    kind: "fork", entry, options: { execArgv: [] }
  }, { exclusiveAcrossOwners: true }), /Exclusive process lease/);
  await registry.terminateOwner(owner);
  assert.equal(held.exited(), true, "Original descendant HANDLE must already be signalled when its lease is released.");
  assert.equal(registry.list().length, 0);
  assert.equal(external.exitCode, null);
});

test("native count-query failure retains the tree fence until the same Job confirms exit", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry(undefined, { terminationTimeoutMs: 100 });
  const entry = await write(root, "held.mjs", "process.send('ready');setInterval(()=>{},1000);");
  const lease = registry.launch(owner, "native-failure", { kind: "fork", entry,
    options: { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] } });
  await once(lease.child, "message");
  const nativeApi = Object.getOwnPropertyDescriptor(lease.tree!, "api")?.value;
  assert.ok(nativeApi);
  const fault = t.mock.method(nativeApi, "query", () => { throw new Error("controlled native query failure"); });
  try {
    await assert.rejects(registry.terminateOwner(owner), /tree lease did not confirm exit/);
    assert.equal(registry.list(owner).length, 1);
    assert.throws(() => registry.releaseOwner(owner), /active children/);
    assert.match(lease.tree!.failure?.message ?? "", /controlled native query/);
  } finally { fault.mock.restore(); lease.tree!.refresh(); await lease.settled; await registry.disposeAll(); }
  assert.equal(registry.list(owner).length, 0);
});

test("failed bootstrap Job admission executes no business module", windows, async t => {
  const root = await fixture(t), marker = path.join(root, "must-not-exist");
  const entry = await write(root, "forbidden.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  const bootstrap = fileURLToPath(new URL("./protectedProcessBootstrap.mjs", import.meta.url));
  const child = fork(bootstrap, [], { execArgv: [], ...{ windowsHide: true }, stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
    env: { ...process.env, RABIROUTE_PROTECTED_LAUNCH: JSON.stringify({ kind: "fork", entry, args: [],
      job: `Local\\Missing.RabiTree.${Date.now()}`, nonce: "controlled-fixture", controlFd: 4 }) } });
  (child.stdio[4] as Readable | null)?.resume();
  await once(child, "close");
  assert.equal(child.exitCode, 1);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("Manager death closes a nested Job and its detached descendants without a stop request", windows, async t => {
  const root = await fixture(t);
  const target = await write(root, "descendant-root.mjs", `import {spawn} from 'node:child_process';
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});
    c.unref();process.send({grandPid:c.pid});setInterval(()=>{},1000);`);
  const registryUrl = pathToFileURL(fileURLToPath(new URL("./processLeaseRegistry.ts", import.meta.url))).href;
  const nativeUrl = pathToFileURL(fileURLToPath(new URL("./windowsJobObject.mjs", import.meta.url))).href;
  const manager = await write(root, "manager.mjs", `import {ProcessLeaseRegistry} from ${JSON.stringify(registryUrl)};
    import {WindowsJobTree,joinCurrentProcessToJob} from ${JSON.stringify(nativeUrl)};
    const outer=new WindowsJobTree();joinCurrentProcessToJob(outer.name);
    const r=new ProcessLeaseRegistry();const l=r.launch(${JSON.stringify(owner)},'crash-tree',
      {kind:'fork',entry:${JSON.stringify(target)},options:{execArgv:[],stdio:['ignore','ignore','ignore','ipc']}});
    l.child.once('message',m=>console.log(JSON.stringify({grandPid:m.grandPid,job:l.tree.name})));`);
  const child = spawn(process.execPath, ["--import", "tsx", manager], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "", error = "";
  child.stdout.on("data", data => { output += String(data); });
  child.stderr.on("data", data => { error += String(data); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  await until(() => output.includes("\n") || child.exitCode !== null);
  assert.ok(output.includes("\n"), error);
  const ready = JSON.parse(output.trim().split(/\r?\n/)[0]!);
  const held = ownedProcessHandle(ready.grandPid, ready.job);
  t.after(held.dispose);
  child.kill("SIGKILL"); await closed;
  await until(held.exited);
  assert.equal(held.exited(), true);
});

test("a default Windows registry rejects an unprotected start callback before it runs", windows, () => {
  let executed = false;
  assert.throws(() => new ProcessLeaseRegistry().launch(owner, "bare", () => { executed = true; throw new Error("must not run"); }), /protected fork\/spawn descriptor/);
  assert.equal(executed, false);
});

test("CLI and NODE_OPTIONS preloads create detached children only after Job admission", windows, async t => {
  const root = await fixture(t);
  const esm = await write(root, "pre load.mjs", `import {spawn} from 'node:child_process';
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_OPTIONS:''}});
    c.unref();globalThis.preloadedPid=c.pid;`);
  const cjs = await write(root, "pre load.cjs", `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_OPTIONS:''}});
    c.unref();globalThis.preloadedPid=c.pid;`);
  const entry = await write(root, "after-preload.mjs", `process.send({preloadedPid:globalThis.preloadedPid,execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS});setInterval(()=>{},1000);`);
  const quoted = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  const cases = [
    { name: "execArgv import", execArgv: ["--import", pathToFileURL(esm).href] },
    { name: "execArgv require", execArgv: ["-r", cjs] },
    { name: "NODE_OPTIONS import", execArgv: [], nodeOptions: `--max-old-space-size=256 --import ${quoted(pathToFileURL(esm).href)}` },
    { name: "case-insensitive NODE_OPTIONS require", execArgv: [], nodeOptions: `--require ${quoted(cjs)}`, environmentKey: "node_options" }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const registry = new ProcessLeaseRegistry();
    let held: ReturnType<typeof ownedProcessHandle> | undefined;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"));
    if (item.nodeOptions) environment[item.environmentKey ?? "NODE_OPTIONS"] = item.nodeOptions;
    const lease = registry.launch(owner, "preload-tree", { kind: "fork", entry,
      options: { execArgv: item.execArgv, env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"] } });
    const closed = once(lease.child, "close");
    try {
      const [ready] = await once(lease.child, "message");
      assert.ok(Number.isInteger(ready.preloadedPid));
      assert.deepEqual(ready.execArgv, item.execArgv);
      assert.equal(ready.nodeOptions, item.nodeOptions);
      held = ownedProcessHandle(ready.preloadedPid, lease.tree!.name);
      await registry.terminateOwner(owner); await closed;
      await until(held.exited);
      assert.equal(registry.list().length, 0);
    } finally { await registry.disposeAll(); held?.dispose(); }
  });
});

test("post-admission bare package preloads retain distinct import and require export conditions", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry();
  const packageRoot = path.join(root, "node_modules", "conditional-preload");
  await fs.mkdir(packageRoot, { recursive: true });
  await write(packageRoot, "package.json", JSON.stringify({ name: "conditional-preload", type: "module", exports: { import: "./import.mjs", require: "./require.cjs" } }));
  await write(packageRoot, "import.mjs", "globalThis.importBranch='import';");
  await write(packageRoot, "require.cjs", "globalThis.requireBranch='require';");
  const entry = await write(root, "conditions.mjs", "process.send({importBranch:globalThis.importBranch,requireBranch:globalThis.requireBranch});setInterval(()=>{},1000);");
  const lease = registry.launch(owner, "conditional-exports", { kind: "fork", entry, options: {
    cwd: root, execArgv: ["--require", "conditional-preload", "--import", "conditional-preload"], stdio: ["ignore", "ignore", "pipe", "ipc"] } });
  const closed = once(lease.child, "close");
  try {
    const [ready] = await once(lease.child, "message");
    assert.deepEqual(ready, { importBranch: "import", requireBranch: "require" });
  } finally { await registry.disposeAll(); await closed; }
});

test("source --import tsx still loads a typed entry after protected admission", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry();
  const entry = await write(root, "source.ts", "const value: number=42;process.send!({value,execArgv:process.execArgv});setInterval(()=>{},1000);");
  const lease = registry.launch(owner, "typed-source", { kind: "fork", entry,
    options: { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] } });
  const closed = once(lease.child, "close");
  try {
    const [ready] = await once(lease.child, "message");
    assert.equal(ready.value, 42);
    assert.deepEqual(ready.execArgv, ["--import", "tsx"]);
  } finally { await registry.disposeAll(); await closed; }
});

test("unsupported pre-bootstrap loader or entry modes are rejected before their preload can execute", windows, async t => {
  const root = await fixture(t), marker = path.join(root, "outside-job-must-not-run");
  const preload = await write(root, "loader.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  const registry = new ProcessLeaseRegistry();
  for (const options of [
    { execArgv: ["--loader", pathToFileURL(preload).href] },
    { execArgv: [], env: { ...process.env, NODE_OPTIONS: `--experimental_loader=${pathToFileURL(preload).href}` } },
    { execArgv: ["--eval", "process.exit(0)"] }
  ]) assert.throws(() => registry.launch(owner, "unsafe-entry", { kind: "fork", entry: preload, options }), /before protected Job admission.*module entry/);
  assert.equal(registry.list().length, 0);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});


test("Node env/config-file initialization flags reject before creating an unadmitted child", windows, async t => {
  const root = await fixture(t), marker = path.join(root, "preload-receipt.json"), business = path.join(root, "business-receipt");
  const preload = await write(root, "preload.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({descriptorStillPresent:!!process.env.RABIROUTE_PROTECTED_LAUNCH}));`);
  const entry = await write(root, "entry.mjs", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(business)},'executed');`);
  const envFile = await write(root, "fixture.env", 'NODE_OPTIONS="--require=' + preload.split(path.sep).join('/') + '"\n');
  const configFile = await write(root, "node.config.json", JSON.stringify({ nodeOptions: { import: [pathToFileURL(preload).href] } }));
  const registry = new ProcessLeaseRegistry(); t.after(() => registry.disposeAll());
  for (const flag of ["--env-file", "--env-file-if-exists", "--experimental-config-file", "--experimental-default-config-file"]) {
    const argument = flag.includes("env-file") ? envFile : configFile;
    const execArgv = flag === "--experimental-default-config-file" ? [flag] : [flag, argument];
    for (const options of [{ cwd: root, execArgv }, { cwd: root, execArgv: [], env: { ...process.env, NODE_OPTIONS: flag === "--experimental-default-config-file" ? flag : flag + "=" + argument } }]) {
      assert.throws(() => registry.launch(owner, "early-file-initialization", { kind: "fork", entry, options }), /before protected Job admission.*options.env.*--import/);
      assert.equal(registry.list().length, 0);
    }
  }
  await assert.rejects(fs.access(marker), { code: "ENOENT" }); await assert.rejects(fs.access(business), { code: "ENOENT" });
});

test("native Node spawn keeps env/config file flags inside the admitted Job", windows, async t => {
  const root = await fixture(t), registry = new ProcessLeaseRegistry(); t.after(() => registry.disposeAll());
  for (const flag of ["--env-file", "--experimental-config-file"]) {
    const marker = path.join(root, flag.slice(2) + ".json");
    const preload = await write(root, flag.slice(2) + ".cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({descriptorStillPresent:!!process.env.RABIROUTE_PROTECTED_LAUNCH}));`);
    const config = flag === "--env-file"
      ? await write(root, "native.env", 'NODE_OPTIONS="--require=' + preload.split(path.sep).join('/') + '"\n')
      : await write(root, "node.config.json", JSON.stringify({ nodeOptions: { import: [pathToFileURL(preload).href] } }));
    const entry = await write(root, "native-entry.mjs", "export const executed=true;");
    const lease = registry.launch({ ...owner, activationId: flag }, "native-file-flags", { kind: "spawn", command: process.execPath, args: [flag, config, entry], options: { cwd: root, stdio: "ignore", windowsHide: true } });
    await lease.settled; assert.equal(lease.child.exitCode, 0); assert.equal(registry.list().length, 0);
    assert.equal(JSON.parse(await fs.readFile(marker, "utf8")).descriptorStillPresent, false);
  }
});
