import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { launchProtectedProcess } from "@rabiroute/host-api/runtime/protectedProcessLauncher";
import { configureTimeouts, readTimeoutOverrides } from "@rabiroute/host-api/shared/timeoutSettings";
import { VacuumVideoTransport, holdVideoStream, safeVideoFailure, resolveVacuumVideoWorkerTimeouts } from "./vacuumVideo.js";

test("the parent resolves each existing worker timeout once and preserves its value in the child DTO", () => {
  const calls: Array<[string, number]> = [];
  const timeouts = resolveVacuumVideoWorkerTimeouts((key, fallback) => { calls.push([key, fallback]); return fallback + 17; });
  assert.deepEqual(calls, [
    ["deadline.integrations.xiaomiHome.vacuumVideoWorker.close", 1000],
    ["backend.integrations.xiaomiHome.vacuumCs2Relay.connectLocal.timeoutMs", 3000],
    ["backend.integrations.xiaomiHome.vacuumCs2Relay.connect.timeoutMs", 30000]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(timeouts)), { closeMs: 1017, localConnectMs: 3017, relayConnectMs: 30017 });
});

test("native video byte sources retain original frame/stream endpoints and close their owned upstream", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-content-"));
  const calls: string[] = [], bytes = Buffer.from("owned-fixture-mp4-bytes");
  let streamClosed!: () => void; const closed = new Promise<void>(resolve => { streamClosed = resolve; });
  const server = http.createServer((request, response) => {
    calls.push(request.url!); assert.equal(request.headers.authorization, "Basic owned-fixture");
    response.writeHead(200, { "content-type": "video/mp4" });
    if (request.url!.startsWith("/api/frame.mp4")) response.end(bytes);
    else { response.once("close", streamClosed); response.write(bytes); }
  });
  const video = new VacuumVideoTransport(root, async () => { throw new Error("No camera provisioning is permitted in this fixture."); });
  let activeContent: Awaited<ReturnType<typeof video.openStream>> | undefined;
  t.after(async () => { await activeContent?.cancel(); (video as any).active = undefined; await video.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("vacuum-video-content-")); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  (video as any).active = { snapshot: { sessionId: "fixture-session", state: "streaming" }, baseUrl: "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port, auth: "Basic owned-fixture", controller: new AbortController() };
  const frame = await video.openStream("fixture-session", true); const chunks: Buffer[] = []; for await (const chunk of frame.frames) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), bytes); assert.equal(frame.headers["content-type"], "video/mp4");
  activeContent = await video.openStream("fixture-session"); await activeContent.cancel(); await closed;
  assert.deepEqual(calls, ["/api/frame.mp4?src=vacuum&video=h264,h265", "/api/stream.mp4?src=vacuum&video=h264,h265"]);
  await assert.rejects(video.openStream("different-session"), /not available/);
});

test("video rejects missing native component before issuing any camera provisioning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-")); let calls = 0;
  try {
    const video = new VacuumVideoTransport(root, async () => { calls++; throw Error("must-not-be-used"); });
    await assert.rejects(video.start("987654321", "cn", "video-test-key-0001"), /pinned Windows/);
    assert.equal(calls, 0); assert.deepEqual(video.status(), { state: "idle", available: false, audio: false });
    await video.shutdown(); await assert.rejects(video.start("987654321", "cn", "video-test-key-0002"), /owner stopped/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("replayed video intent survives restart without starting another camera or native process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-")); const key = "video-test-replay-01", sessionId = "11111111-1111-4111-8111-111111111111";
  try {
    fs.mkdirSync(path.join(root, "vacuum-video", "keys"), {recursive:true}); fs.mkdirSync(path.join(root,"vacuum-video","sessions"),{recursive:true});
    fs.writeFileSync(path.join(root,"vacuum-video","keys",createHash("sha256").update(key).digest("hex")+".json"), JSON.stringify({deviceId:"987654321",region:"cn",sessionId}));
    fs.writeFileSync(path.join(root,"vacuum-video","sessions",sessionId+".json"),JSON.stringify({schemaVersion:1,sessionId,deviceId:"987654321",region:"cn",state:"streaming",audio:false}));
    const video = new VacuumVideoTransport(root, async () => { throw Error("no provisioning on replay"); });
    const receipt = await video.start("987654321","cn",key); assert.equal(receipt.state,"stopped"); assert.equal(receipt.error,"manager_restarted");
    assert.deepEqual(video.receipt(key),receipt);
    await assert.rejects(video.start("123","cn",key), /another intent/);
    assert.throws(()=>video.status("../../outside"), /Invalid video session/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("first-frame proof rejects HTTP success with non-video data and bounded oversized streams", async () => {
  const box = (type: string, length: number) => {const value=Buffer.alloc(length); value.writeUInt32BE(length);value.write(type,4,"ascii");return value;};
  const mp4 = Buffer.concat([box("ftyp",24),box("moov",16),box("moof",16),box("mdat",20)]);
  const owner=new AbortController();
  const held=await holdVideoStream(new Response(mp4),owner.signal);assert.equal(held.bytes,mp4.length);await assert.rejects(held.completed,/interrupted/);owner.abort();
  await assert.rejects(holdVideoStream(new Response("camera accepted but no frame"),new AbortController().signal), /MP4 frame|bounds/);
  await assert.rejects(holdVideoStream(new Response(Buffer.alloc(4*1024*1024+1)),new AbortController().signal), /exceeds bounds/);
});

test("native video diagnostics never echo connection keys or provider payloads", () => {
  assert.equal(safeVideoFailure('xiaomi://host?client_private=secret i/o timeout'),"camera_connection_timeout");
  assert.equal(safeVideoFailure('miss: auth: {"token":"secret"}'),"camera_auth_rejected");
  assert.equal(safeVideoFailure('unknown private response'),"camera_connection_rejected");
});

test("first-fragment subscription survives browser handover and cancels with its owner", async () => {
  const box=(type:string,size:number)=>{const b=Buffer.alloc(size);b.writeUInt32BE(size);b.write(type,4);return b;};
  const fragment=Buffer.concat([box("ftyp",24),box("moov",16),box("moof",16),box("mdat",20)]);
  let source!:ReadableStreamDefaultController<Uint8Array>, cancelled=0;
  const stream=new ReadableStream<Uint8Array>({start(c){source=c;},cancel(){cancelled++;}});
  const owner=new AbortController(), result=holdVideoStream(new Response(stream),owner.signal);
  // A fragmented HTTP boundary must not become premature first-frame evidence.
  source.enqueue(fragment.subarray(0,39));source.enqueue(fragment.subarray(39));
  const held=await result;assert.equal(held.bytes,fragment.length);assert.equal(cancelled,0);
  source.enqueue(Buffer.concat([box("moof",16),box("mdat",20)]));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,0);
  owner.abort();await held.completed;assert.equal(cancelled,1);
});

test("held stream rejects invalid first media and reports a later source disconnect", async () => {
  await assert.rejects(holdVideoStream(new Response("accepted request with no media"),new AbortController().signal),/MP4 frame|bounds/);
  const box=(type:string,size:number)=>{const b=Buffer.alloc(size);b.writeUInt32BE(size);b.write(type,4);return b;};
  let source!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(c){source=c;}});
  source.enqueue(Buffer.concat([box("ftyp",24),box("moov",16),box("moof",16),box("mdat",20)]));
  const held=await holdVideoStream(new Response(stream),new AbortController().signal);
  source.close();await assert.rejects(held.completed,/interrupted/);
});

test("unconfirmed native stop retains the session owner and release until actual close, then allows retry", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-unconfirmed-"));
  const previous = readTimeoutOverrides();
  configureTimeouts({ ...previous, "backend.integrations.xiaomiHome.vacuumVideo.close.child": 10 });
  t.after(() => { configureTimeouts(previous); fs.rmSync(root, { recursive: true, force: true }); });
  const video = new VacuumVideoTransport(root, async () => { throw new Error("No device calls allowed"); });
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null, send() {}, kill() { return false; } });
  const configPath = path.join(root, "session.yaml"); fs.writeFileSync(configPath, "fixture");
  let released = 0;
  const active = { snapshot: { schemaVersion: 1, sessionId: "fixture-close", deviceId: "123", region: "cn", state: "streaming", startedAt: new Date().toISOString(), parentPid: process.pid, managerPid: process.pid, audio: false },
    child, configPath, controller: new AbortController(), release: async () => { released++; } };
  (video as any).active = active;
  await assert.rejects(video.stop("fixture-close"), /termination is not confirmed/);
  assert.equal(released, 0); assert.equal(fs.existsSync(configPath), true);
  assert.equal((video.status("fixture-close") as any).state, "failed");
  assert.equal((video.status("fixture-close") as any).pageExit, "uncertain");
  await assert.rejects(video.start("123", "cn", "fixture-new-session-0001"), /already active/);
  child.emit("close", 0, null);
  assert.equal((await video.stop("fixture-close")).pageExit, "completed");
  assert.equal(released, 1); assert.equal(fs.existsSync(configPath), false);
  await video.shutdown(); assert.equal(released, 1, "a confirmed release is not replayed");
});

test("closed worker alone cannot release a session while its original process tree is unconfirmed", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-tree-retain-"));
  const previous = readTimeoutOverrides();
  configureTimeouts({ ...previous, "backend.integrations.xiaomiHome.vacuumVideo.close.child": 10 });
  t.after(() => { configureTimeouts(previous); fs.rmSync(root, { recursive: true, force: true }); });
  const video = new VacuumVideoTransport(root, async () => { throw new Error("No device calls allowed"); });
  const child = Object.assign(new EventEmitter(), { connected: false, exitCode: 0, signalCode: null, send() {}, kill() { return false; } });
  let completeTree!: () => void;
  const processTree = { name: "original-private-tree", settled: new Promise<void>(resolve => { completeTree = resolve; }), closed: false,
    activeCount: () => 0, refresh() {}, terminate() { throw new Error("Original native handle is not signaled"); } };
  const configPath = path.join(root, "session.yaml"); fs.writeFileSync(configPath, "original");
  let released = 0;
  const originalClosed = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const active: any = { snapshot: { schemaVersion: 1, sessionId: "fixture-tree", deviceId: "123", region: "cn", state: "streaming", startedAt: new Date().toISOString(), parentPid: process.pid, managerPid: process.pid, audio: false },
    child, processTree, configPath, controller: new AbortController(), release: async () => { released++; } };
  active.childClosed = Promise.all([originalClosed, processTree.settled]).then(() => { active.childExitConfirmed = true; });
  (video as any).active = active;
  const stopping = video.stop("fixture-tree");
  child.emit("exit", 0, null);
  await assert.rejects(stopping, /termination is not confirmed/);
  assert.equal(released, 0); assert.equal(fs.existsSync(configPath), true);
  await assert.rejects(video.start("123", "cn", "fixture-replacement-0001"), /already active/);
  completeTree();
  assert.equal((await video.stop("fixture-tree")).pageExit, "completed");
  assert.equal(released, 1); assert.equal(fs.existsSync(configPath), false);
  await video.shutdown(); assert.equal(released, 1);
});

test("protected native video stop, cancellation, IPC loss, natural exit and worker crash join original Win32 handles", { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-video-native-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "native-fixture.exe");
  const code = `using System;using System.IO;using System.Diagnostics;using System.Threading;
    public class Fixture { public static void Main(string[] args) {
      string receipt=File.ReadAllText(args[1]); File.WriteAllText(receipt,Process.GetCurrentProcess().Id.ToString());
      while(!File.Exists(receipt+".exit")) { Thread.Sleep(10); }
    } }`;
  const built = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -TypeDefinition $env:RABI_VIDEO_FIXTURE_SOURCE -OutputAssembly $env:RABI_VIDEO_FIXTURE_EXECUTABLE -OutputType ConsoleApplication"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, RABI_VIDEO_FIXTURE_SOURCE: code, RABI_VIDEO_FIXTURE_EXECUTABLE: executable,
      PSModulePath: path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/Modules") }
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const koffi = createRequire(import.meta.url)("koffi"), kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const terminate = kernel.func("int __stdcall TerminateProcess(void *handle, uint32_t code)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  for (const mode of ["stop", "cancel", "disconnect", "natural-exit", "worker-crash"]) {
    const config = path.join(root, `${mode}.yaml`), receipt = path.join(root, `${mode}.pid`);
    fs.writeFileSync(config, receipt);
    const launched = launchProtectedProcess({ kind: "fork", entry: fileURLToPath(new URL("./vacuumVideoWorker.ts", import.meta.url)),
      args: [executable, config, JSON.stringify(resolveVacuumVideoWorkerTimeouts())],
      options: { execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP,
          NODE_PATH: process.env.NODE_PATH, RABI_VIDEO_SOURCE: "http://fixture.invalid/video" } }
    });
    const worker = launched.child;
    assert.ok(launched.tree);
    const originalClosed = new Promise<void>(resolve => worker.once("exit", () => resolve()));
    const retired = Promise.all([originalClosed, launched.tree.settled]);
    void retired.catch(() => {});
    let diagnostic = ""; worker.stderr?.on("data", chunk => { diagnostic += String(chunk); });
    let handle: any;
    let readyPid = 0;
    worker.on("message", message => { const value = message as {event?:string;pid?:number}; if(value.event === "ready") readyPid = value.pid!; });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(receipt) || !readyPid) {
        if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Video fixture worker exited early: ${diagnostic}`);
        if (Date.now() > deadline) throw new Error(`Native video fixture did not start: ${diagnostic}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const nativePid = Number(fs.readFileSync(receipt, "utf8"));
      assert.equal(readyPid, nativePid, "ready retains the original native executable PID");
      handle = open(0x00100001, 0, nativePid);
      assert.ok(handle, "hold the original native process HANDLE before any stop or crash");
      assert.equal(wait(handle, 0), 258);
      const video = new VacuumVideoTransport(path.join(root, "state"), async () => { throw new Error("No device calls allowed"); });
      let released = 0;
      const controller = new AbortController();
      const active: any = { snapshot: { schemaVersion: 1, sessionId: "fixture-native", deviceId: "123", region: "cn", state: "streaming", startedAt: new Date().toISOString(), parentPid: process.pid, managerPid: process.pid, audio: false },
        child: worker, processTree: launched.tree, configPath: config, controller,
        childClosed: retired.then(() => { active.childExitConfirmed = true; }), childExitConfirmed: false,
        release: async () => { assert.ok(worker.exitCode !== null || worker.signalCode !== null); assert.equal(wait(handle, 0), 0); t.diagnostic(JSON.stringify({ mode, originalNativeHandleWait: wait(handle, 0), workerExitObserved: true })); released++; } };
      (video as any).active = active;
      if (mode === "worker-crash") worker.kill("SIGKILL");
      else if (mode === "disconnect") worker.disconnect();
      else if (mode === "natural-exit") { fs.writeFileSync(receipt + ".exit", "exit"); await originalClosed; }
      else if (mode === "cancel") controller.abort();
      assert.equal((await video.stop("fixture-native")).pageExit, "completed");
      await retired;
      assert.equal(wait(handle, 0), 0, "Job completion is insufficient until the original OS HANDLE is signaled");
      assert.equal(released, 1); assert.equal(fs.existsSync(config), false);
      await video.shutdown(); assert.equal(released, 1);
    } finally {
      try { launched.tree.terminate(); } finally {
        if (handle) {
          if (wait(handle, 0) !== 0) { assert.equal(terminate(handle, 1), 1); assert.equal(wait(handle, 5000), 0); }
          close(handle);
        }
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await retired;
      }
    }
  }
});
