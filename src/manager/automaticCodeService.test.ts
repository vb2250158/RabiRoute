import assert from "node:assert/strict";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { WindowsJobTree } from "../runtime/windowsJobObject.mjs";
import { AutomaticCodeService } from "./automaticCodeService.js";
import type { WebPatchService } from "./webPatchService.js";
import { configureTimeouts, readTimeoutOverrides } from "../shared/timeoutSettings.js";

test("native discovery needs no opt-in and preserves explicit disable and unowned startup edits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-native-default-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}");
  const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
  for (const [watch, dirty, state] of [[true, false, "ready"], [false, false, "disabled"], [true, true, "requires_review"]] as const) {
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64), inputHashes: dirty ? { "tsconfig.json": "b".repeat(64) } : {} }));
    const service = new AutomaticCodeService({ packageRoot: root, stateRoot: path.join(root, "state"), watch, publication, onError: () => {} });
    await service.start();
    assert.equal(service.snapshot().state, state);
    await service.stop();
  }
});

for (const state of ["prepared", "superseded", "requires_switch"]) {
  test(`automatic compiler returns ${state} receipt without treating normal worker exit as failure`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-service-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64) }));
    await fs.writeFile(path.join(root, "scripts/automatic-update-worker.mjs"), `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify({ state, reasons: [], definitions: [] })});`);
    const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
    const service = new AutomaticCodeService({ packageRoot: root, sourceRoot: root, stateRoot: path.join(root, "state"), watch: false, publication, onError: () => {} });
    t.after(() => service.stop());
    // Exercise the actual worker handshake, isolated from the publication timer and live service.
    const result = await (service as unknown as { compile(): Promise<{ state: string }> }).compile();
    assert.equal(result.state, state);
  });
}

for (const pauseAt of ["publication", "input"] as const) {
  test(`stopping during ${pauseAt} startup does not create a late source watcher`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-start-stop-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({
      modules: [], webInputDigest: "a".repeat(64), inputHashes: { "tsconfig.json": "b".repeat(64) }
    }));
    const sourceRoot = await fs.realpath(root);
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    t.after(resume);
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const readFile = fs.readFile;
    if (pauseAt === "input") {
      t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === path.join(sourceRoot, "tsconfig.json")) { enter(); await paused; }
        return readFile(...args);
      });
    }
    const watch = t.mock.method(nativeFs, "watch");
    const publication = {
      registerCodePublication: () => {},
      get ready() {
        if (pauseAt === "publication") { enter(); return paused; }
        return Promise.resolve();
      },
      status: () => ({ state: "ready" })
    } as unknown as WebPatchService;
    const service = new AutomaticCodeService({ packageRoot: root, stateRoot: path.join(root, "state"), watch: true, publication, onError: () => {} });
    t.after(() => service.stop());
    const startup = service.start();
    await entered;
    await service.stop();
    resume();
    await startup;
    assert.equal(watch.mock.callCount(), 0, "the stopped source owner must not acquire a watcher");
  });
}

for (const mode of ["timeout", "stop", "worker-crash"] as const) {
  test(`automatic compiler ${mode} joins its real Node subprocess before releasing ownership`, { timeout: 20_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-process-owner-"));
    const receipt = path.join(root, "child-pid");
    const previousTimeouts = readTimeoutOverrides();
    configureTimeouts({ ...previousTimeouts, "deadline.manager.automaticCodeService.compile": mode === "timeout" ? 1000 : 10_000 });
    t.after(() => configureTimeouts(previousTimeouts));
    t.after(async () => {
      const pid = Number(await fs.readFile(receipt, "utf8").catch(() => ""));
      if (pid) { try { process.kill(pid); } catch { /* this exact fixture process already exited */ } }
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64) }));
    const command = `require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000);`;
    await fs.writeFile(path.join(root, "scripts/automatic-update-worker.mjs"), `
      import {parentPort} from 'node:worker_threads';
      import fs from 'node:fs';
      parentPort.postMessage({type:'run-node',id:1,root:${JSON.stringify(root)},arguments:['-e',${JSON.stringify(command)}]});
      parentPort.on('message', value => {
        if(value?.type==='run-node-result') { parentPort.postMessage({state:'failed',reasons:[value.error]});parentPort.close(); }
      });
      ${mode === "worker-crash" ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(receipt)})){clearInterval(timer);process.exit(29)}},10);` : ""}
    `);
    const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
    const service = new AutomaticCodeService({ packageRoot: root, sourceRoot: root, stateRoot: path.join(root, "state"), watch: false, publication, onError: () => {} });
    t.after(() => service.stop());
    const compile = (service as unknown as { compile(): Promise<unknown> }).compile();
    const failed = assert.rejects(compile, mode === "timeout" ? /deadline/ : mode === "stop" ? /cancelled/ : /exited without a result/);
    const deadline = Date.now() + 5000;
    while (!nativeFs.existsSync(receipt)) {
      if (Date.now() > deadline) throw new Error("Fixture Node child did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (mode === "stop") await service.stop();
    await failed;
    const pid = Number(await fs.readFile(receipt, "utf8"));
    assert.throws(() => process.kill(pid, 0), "compile completion must confirm the exact owned process exited");
    await service.stop();
  });
}

// Hold the original kernel HANDLE while asserting retirement. PID liveness or
// the compiler root's stream closure does not prove descendant exit.
function compilerProcessHandles() {
  const koffi = createRequire(import.meta.url)("koffi"), kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void* handle, uint32_t milliseconds)");
  const terminate = kernel.func("int __stdcall TerminateProcess(void* handle, uint32_t code)");
  const close = kernel.func("int __stdcall CloseHandle(void* handle)");
  const handles: unknown[] = [];
  return {
    capture(pid: number) { const handle = open(0x100001, 0, pid); assert.ok(handle); handles.push(handle); return handle; },
    wait,
    dispose() { for (const handle of handles) { if (wait(handle, 0) === 258) { terminate(handle, 1); assert.equal(wait(handle, 5000), 0); } close(handle); } }
  };
}
async function compilerOwnedFixture(mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-tree-owner-"));
  const leafReady = path.join(root, "leaf-ready"), releaseRoot = path.join(root, "release-root");
  const rootResult = path.join(root, "root-result"), releaseWorker = path.join(root, "release-worker");
  await fs.mkdir(path.join(root, "dist/automatic-code"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "dist/automatic-code/catalog.json"), JSON.stringify({ modules: [], webInputDigest: "a".repeat(64) }));
  const leaf = `require('node:fs').writeFileSync(${JSON.stringify(leafReady)},String(process.pid));setInterval(()=>{},1000);`;
  const command = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',windowsHide:true,detached:true});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseRoot)})){clearInterval(timer);process.exit(0)}},10);`;
  await fs.writeFile(path.join(root, "scripts/automatic-update-worker.mjs"), `
    import {parentPort} from 'node:worker_threads';import fs from 'node:fs';
    parentPort.postMessage({type:'run-node',id:1,root:${JSON.stringify(root)},arguments:['-e',${JSON.stringify(command)}]});
    parentPort.on('message',value=>{
      if(value==='cancel'){parentPort.close();return;}
      if(value?.type==='run-node-result'){
        fs.writeFileSync(${JSON.stringify(rootResult)},'received');
        if(${JSON.stringify(mode)}==='normal'){parentPort.postMessage({state:'prepared',definitions:[]});parentPort.close();}
      }
    });
    ${mode === "worker-crash" ? `const crash=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseWorker)})){clearInterval(crash);process.exit(29)}},10);` : ""}
  `);
  const publication = { registerCodePublication: () => {}, ready: Promise.resolve(), status: () => ({ state: "ready" }) } as unknown as WebPatchService;
  const service = new AutomaticCodeService({ packageRoot: root, sourceRoot: root, stateRoot: path.join(root, "state"), watch: false, publication, onError: () => {} });
  const waitForFile = async (filename: string) => {
    const deadline = Date.now() + 5000;
    while (!nativeFs.existsSync(filename)) {
      if (Date.now() > deadline) throw new Error("Owned compiler fixture did not reach its receipt");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  return { root, service, leafReady, releaseRoot, rootResult, releaseWorker, waitForFile,
    compile: () => (service as unknown as { compile(): Promise<{ state: string }> }).compile() };
}

for (const mode of ["normal", "stop", "worker-crash"] as const) {
  test(`automatic compiler ${mode} retires the original stdio-independent descendant HANDLE after root exit`, { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
    const f = await compilerOwnedFixture(mode), handles = compilerProcessHandles();
    t.after(async () => { handles.dispose(); try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
    const compilation = f.compile();
    const outcome = mode === "normal" ? compilation : assert.rejects(compilation, mode === "stop" ? /cancelled/ : /exited without a result/);
    await f.waitForFile(f.leafReady);
    const original = handles.capture(Number(await fs.readFile(f.leafReady, "utf8")));
    assert.equal(handles.wait(original, 0), 258);
    await fs.writeFile(f.releaseRoot, "release");
    await f.waitForFile(f.rootResult);
    if (mode === "stop") await f.service.stop();
    if (mode === "worker-crash") await fs.writeFile(f.releaseWorker, "crash");
    await outcome;
    assert.equal(handles.wait(original, 0), 0, "root close or taskkill acceptance cannot replace the original descendant HANDLE signal");
  });
}

for (const failure of ["tree-terminate", "worker-terminate"] as const) {
  test(`automatic compiler retains a failed ${failure} owner and a subsequent stop retries retirement`, { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
    const f = await compilerOwnedFixture("stop"), handles = compilerProcessHandles();
    t.after(async () => { t.mock.restoreAll(); handles.dispose(); try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
    if (failure === "tree-terminate") {
      const terminate = WindowsJobTree.prototype.terminate;
      let fail = true;
      t.mock.method(WindowsJobTree.prototype, "terminate", function(this: WindowsJobTree) {
        if (fail) { fail = false; throw new Error("fixture original Job termination failed"); }
        return terminate.call(this);
      });
    } else t.mock.method(Worker.prototype, "terminate", () => Promise.reject(new Error("fixture worker termination failed")));
    const compilation = assert.rejects(f.compile(), /cleanup remains unconfirmed/);
    await f.waitForFile(f.leafReady);
    const original = handles.capture(Number(await fs.readFile(f.leafReady, "utf8")));
    await assert.rejects(f.service.stop(), /stop remains unconfirmed/);
    await compilation;
    assert.ok((f.service as unknown as { worker?: Worker }).worker, "failed cleanup retains the original compiler owner");
    t.mock.restoreAll();
    await f.service.stop();
    assert.equal(handles.wait(original, 0), 0);
    assert.equal((f.service as unknown as { worker?: Worker }).worker, undefined);
  });
}

test("automatic compiler asynchronous spawn errors preserve the failed receipt and release the empty original tree", { timeout: 15_000 }, async t => {
  const f = await compilerOwnedFixture("normal"), marker = path.join(f.root, "must-not-start");
  await fs.writeFile(path.join(f.root, "scripts/automatic-update-worker.mjs"), `
    import {parentPort} from 'node:worker_threads';
    parentPort.postMessage({type:'run-node',id:1,root:${JSON.stringify(path.join(f.root, "missing-cwd"))},arguments:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}]});
    parentPort.on('message',value=>{if(value?.type==='run-node-result'){parentPort.postMessage({state:'failed',reasons:[value.error]});parentPort.close()}});
  `);
  t.after(async () => { try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
  const result = await f.compile();
  assert.equal(result.state, "failed");
  assert.equal(nativeFs.existsSync(marker), false);
  assert.equal((f.service as unknown as { worker?: Worker }).worker, undefined);
});

test("automatic compiler refuses a late run-node message after cancellation without starting new work", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const f = await compilerOwnedFixture("stop"), marker = path.join(f.root, "late-work"), handles = compilerProcessHandles();
  const command = `require('node:fs').writeFileSync(${JSON.stringify(f.leafReady)},String(process.pid));setInterval(()=>{},1000);`;
  await fs.writeFile(path.join(f.root, "scripts/automatic-update-worker.mjs"), `
    import {parentPort} from 'node:worker_threads';
    parentPort.postMessage({type:'run-node',id:1,root:${JSON.stringify(f.root)},arguments:['-e',${JSON.stringify(command)}]});
    parentPort.on('message',value=>{if(value==='cancel'){
      parentPort.postMessage({type:'run-node',id:2,root:${JSON.stringify(f.root)},arguments:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}]});
      parentPort.close();
    }});
  `);
  t.after(async () => { handles.dispose(); try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
  const failed = assert.rejects(f.compile(), /cancelled/);
  await f.waitForFile(f.leafReady);
  const original = handles.capture(Number(await fs.readFile(f.leafReady, "utf8")));
  await f.service.stop(); await failed;
  assert.equal(nativeFs.existsSync(marker), false);
  assert.equal(handles.wait(original, 0), 0);
});

for (const persistent of [false, true]) {
  test(`a subsequent real compile retries the original failed owner before new work (${persistent ? "still failing" : "recovers"})`, { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
    const f = await compilerOwnedFixture("normal"), handles = compilerProcessHandles();
    let fail = true;
    const terminate = WindowsJobTree.prototype.terminate;
    t.mock.method(WindowsJobTree.prototype, "terminate", function(this: WindowsJobTree) {
      if (fail) { if (!persistent) fail = false; throw new Error("fixture original Job termination failed"); }
      return terminate.call(this);
    });
    t.after(async () => { fail = false; t.mock.restoreAll(); handles.dispose(); try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
    const first = assert.rejects(f.compile(), /cleanup remains unconfirmed/);
    await f.waitForFile(f.leafReady);
    const pid = Number(await fs.readFile(f.leafReady, "utf8")), original = handles.capture(pid);
    await fs.writeFile(f.releaseRoot, "release");
    await first;
    const failedOwner = (f.service as unknown as { worker?: Worker }).worker;
    assert.ok(failedOwner);
    const marker = path.join(f.root, "successor-worker-started");
    await fs.writeFile(path.join(f.root, "scripts/automatic-update-worker.mjs"), `
      import {parentPort} from 'node:worker_threads';import fs from 'node:fs';
      let alive=true;try{process.kill(${pid},0)}catch{alive=false}
      fs.writeFileSync(${JSON.stringify(marker)},alive?'old owner still alive':'original retired');
      parentPort.postMessage({state:'prepared',definitions:[]});parentPort.close();
    `);
    if (persistent) {
      await assert.rejects(f.compile(), /retirement remains unconfirmed/);
      assert.equal(nativeFs.existsSync(marker), false, "failed original cleanup must not start a new compiler");
      assert.equal((f.service as unknown as { worker?: Worker }).worker, failedOwner);
      assert.equal(handles.wait(original, 0), 258);
      fail = false;
    }
    const recovered = await f.compile();
    assert.equal(recovered.state, "prepared");
    assert.equal(handles.wait(original, 0), 0);
    assert.equal(await fs.readFile(marker, "utf8"), "original retired", "the successor begins only after the original process is gone");
    assert.equal((f.service as unknown as { worker?: Worker }).worker, undefined);
  });
}

test("active compilation stays busy and a stopped source owner never starts a successor", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const f = await compilerOwnedFixture("stop"), handles = compilerProcessHandles();
  t.after(async () => { handles.dispose(); try { await f.service.stop(); } finally { await fs.rm(f.root, { recursive: true, force: true }); } });
  const first = assert.rejects(f.compile(), /cancelled/);
  await f.waitForFile(f.leafReady);
  const original = handles.capture(Number(await fs.readFile(f.leafReady, "utf8")));
  const active = (f.service as unknown as { worker?: Worker }).worker;
  await assert.rejects(f.compile(), /still owns active work/);
  assert.equal((f.service as unknown as { worker?: Worker }).worker, active);
  assert.equal(handles.wait(original, 0), 258);
  await f.service.stop(); await first;
  await assert.rejects(f.compile(), /source owner has stopped/);
  assert.equal((f.service as unknown as { worker?: Worker }).worker, undefined);
  assert.equal(handles.wait(original, 0), 0);
});
