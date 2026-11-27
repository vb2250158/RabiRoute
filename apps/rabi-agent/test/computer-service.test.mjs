import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";
import { ComputerService } from "../lib/computer-service.mjs";
import { ComputerControlService } from "../lib/computer-control-service.mjs";
import { computerRequestSchema } from "../lib/interactive-protocol.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");

test("upload status recovery never reads malformed feature settings or enables new file work", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-bad-computer-settings-"));
  const service = new ComputerService({ uploadHistoryRoot: path.join(root, "history"), getSettings: () => { throw new Error("Original computer settings are malformed"); } });
  t.after(async () => { await service.stop(); removePrivateFixture(root); });
  assert.equal((await service.execute({ action: "upload.status", uploadId: randomUUID() })).state, "absent");
  await assert.rejects(service.execute({ action: "file.stat", path: path.join(os.tmpdir(), "unopened-fixture-file") }), /settings are malformed/);
  assert.equal(service.children.size, 0);
  await service.stop();
});

test("computer stop joins the actual helper close before confirming cleanup", async t => {
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let closed = false;
  const exited = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  t.after(async () => { if (!closed) child.kill("SIGKILL"); await exited; });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  const service = new ComputerService();
  service.children.add(child);
  const stopping = service.stop();
  assert.equal(service.stop(), stopping, "repeated stop joins the same owner");
  await stopping;
  assert.equal(closed, true, "kill acceptance is insufficient; close must be observed");
});

test("computer stop retains a delayed helper until close and reports an unconfirmed kill", async () => {
  const child = new EventEmitter();
  child.kill = () => false;
  const service = new ComputerService({ timeout: () => 1000 });
  service.children.add(child);
  let settled = false;
  const stopping = service.stop().finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close", 0);
  await stopping;

  const failed = new EventEmitter();
  failed.kill = () => { throw new Error("fixture kill denied"); };
  const blocked = new ComputerService({ timeout: () => 20 });
  blocked.children.add(failed);
  await assert.rejects(blocked.stop(), error => error instanceof AggregateError
    && error.errors.some(item => /helper process close remains unconfirmed/.test(item.message)
      && item.cause?.message === "fixture kill denied"));
  assert.equal(blocked.children.has(failed), true, "unconfirmed closure retains ownership");
  failed.emit("close", 0);
});
function removePrivateFixture(root) {
  const absolute = path.resolve(root);
  assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(absolute, { recursive: true, force: true });
}

test("computer uploads allow larger files by default and retain explicit user limits", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-computer-size-"));
  const service = new ComputerService({ maxUploadBytes: Number.MAX_SAFE_INTEGER, uploadHistoryRoot: path.join(root, "history") });
  const limited = new ComputerService({ maxUploadBytes: 3, uploadHistoryRoot: path.join(root, "limited-history") });
  const resumed = new ComputerService({ maxUploadBytes: 3, uploadHistoryRoot: path.join(root, "history") });
  t.after(async () => { await Promise.all([service.stop(), limited.stop(), resumed.stop()]); removePrivateFixture(root); });
  const request = { action: "upload.begin", uploadId: randomUUID(), path: path.join(root, "large.bin"), size: 2 * 1024 ** 3 + 1, sha256: sha("") };
  const schema = computerRequestSchema.anyOf.find(item => item.properties.action.const === "upload.begin");
  assert.ok(schema.properties.size.maximum >= request.size);
  assert.equal((await service.execute(request)).size, request.size);
  await service.execute({ action: "upload.abort", uploadId: request.uploadId });
  assert.equal((await resumed.execute({ action: "upload.status", uploadId: request.uploadId })).size, request.size);
  await assert.rejects(limited.execute({ ...request, size: 4 }), /RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES=3.*launcher/);
  assert.equal((await limited.execute({ ...request, size: 3 })).size, 3);
  await limited.execute({ action: "upload.abort", uploadId: request.uploadId });
  for (const maxUploadBytes of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new ComputerService({ maxUploadBytes }), /exact byte count/);
});

test("computer upload limit reads the user's launcher environment", t => {
  const previous = process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES;
  t.after(() => { if (previous === undefined) delete process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES; else process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES = previous; });
  delete process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES;
  assert.equal(new ComputerService().maxUploadBytes, Number.MAX_SAFE_INTEGER);
  process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES = "0";
  assert.equal(new ComputerService().maxUploadBytes, 0);
  process.env.RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES = "invalid";
  assert.throws(() => new ComputerService(), /RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES/);
});

test("computer resource budgets preserve configured values and report their source", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-computer-capacity-"));
  const service = new ComputerService({ maxConcurrentIo: 1, maxActiveUploads: 1, maxUploadRecords: 2, uploadHistoryRoot: path.join(root, "history") });
  const owned = [service];
  t.after(async () => { await Promise.all(owned.map(owner => owner.stop())); removePrivateFixture(root); });
  const begin = () => ({ action: "upload.begin", uploadId: randomUUID(), path: path.join(root, `${randomUUID()}.bin`), size: 0, sha256: sha("") });
  const first = begin(), second = begin();
  await service.execute(first);
  await assert.rejects(service.execute(second), /RABI_AGENT_COMPUTER_MAX_ACTIVE_UPLOADS=1.*launcher/);
  await service.execute({ action: "upload.abort", uploadId: first.uploadId });
  await service.execute(second);
  await service.execute({ action: "upload.abort", uploadId: second.uploadId });
  const third = begin();
  assert.equal((await service.execute(third)).state, "uploading");
  assert.ok(service.uploads.size <= 2);
  assert.equal((await service.execute({ action: "upload.status", uploadId: first.uploadId })).state, "aborted");
  await service.execute({ action: "upload.abort", uploadId: third.uploadId });
  let finish;
  service.readFile = () => new Promise(resolve => { finish = resolve; });
  const read = service.execute({ action: "file.stat" });
  await assert.rejects(service.execute({ action: "file.stat" }), /RABI_AGENT_COMPUTER_MAX_CONCURRENT_IO=1.*launcher/);
  finish({}); await read;
  assert.equal(service.pending, 0);
  const unlimited = new ComputerService({ maxConcurrentIo: 0, maxActiveUploads: 0, maxUploadRecords: 0, uploadHistoryRoot: path.join(root, "unlimited-history") });
  owned.push(unlimited);
  const requests = Array.from({ length: 5 }, begin);
  await Promise.all(requests.map(request => unlimited.execute(request)));
  assert.equal(unlimited.activeCount, 5);
  await unlimited.stop();
});

test("binary files transfer in checked chunks, commit once and preserve existing files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-computer-"));
  const service = new ComputerService({ uploadHistoryRoot: path.join(root, "history") });
  t.after(async () => { await service.stop(); removePrivateFixture(root); });
  const bytes = Buffer.alloc(200013); for (let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const uploadId = randomUUID(), target = path.join(root, "binary.dat");
  const begin = { action: "upload.begin", uploadId, path: target, size: bytes.length, sha256: sha(bytes) };
  assert.equal((await service.execute(begin)).offset, 0);
  assert.equal((await service.execute(begin)).offset, 0);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset+65536);
    const write = { action: "upload.write", uploadId, offset, data: chunk.toString("base64"), sha256: sha(chunk) };
    await service.execute(write); await service.execute(write);
  }
  assert.equal((await service.execute({ action: "upload.status", uploadId })).offset, bytes.length);
  assert.equal(fs.existsSync(target), false);
  await service.execute({ action: "upload.commit", uploadId });
  assert.equal((await service.execute({ action: "upload.commit", uploadId })).state, "committed");
  assert.deepEqual(fs.readFileSync(target), bytes);
  await assert.rejects(service.execute({ ...begin, uploadId: randomUUID() }), /already exists/);
  const metadata = await service.execute({ action: "file.stat", path: target });
  const downloaded = [];
  let offset = 0;
  while (offset < metadata.size) {
    const chunk = await service.execute({ action: "file.read", path: target, version: metadata.version, offset });
    const part = Buffer.from(chunk.data,"base64"); assert.equal(sha(part),chunk.sha256);
    downloaded.push(part); offset = chunk.nextOffset;
  }
  assert.deepEqual(Buffer.concat(downloaded), bytes);
  fs.appendFileSync(target,"changed");
  await assert.rejects(service.execute({ action: "file.read", path: target, version: metadata.version, offset: 0 }), /changed/);
  const cancelled = randomUUID();
  await service.execute({ ...begin, uploadId: cancelled, path: path.join(root,"cancelled.dat") });
  service.stop(); assert.equal(fs.readdirSync(root).filter(name=>name.endsWith(".tmp")).length,0);
});

test("Windows helper queries and captures an owned window without any Agent backend", { skip: process.platform !== "win32" }, async t => {
  const title = `RabiCapture-${randomUUID()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-screen-wait-"));
  const trigger = path.join(root, "change-color");
  const scriptPath = trigger.replaceAll("'", "''");
  const code = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $form=New-Object System.Windows.Forms.Form; $form.Text='${title}'; $form.FormBorderStyle='None'; $form.Width=420; $form.Height=260; $form.StartPosition='Manual'; $form.Location=New-Object System.Drawing.Point(30000,30000); $form.ShowInTaskbar=$false; $form.BackColor=[System.Drawing.Color]::Crimson; $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=40; $timer.Add_Tick({if(Test-Path -LiteralPath '${scriptPath}'){$form.BackColor=[System.Drawing.Color]::ForestGreen;$form.Refresh();$timer.Stop()}}); $timer.Start(); $form.Add_Shown({$form.Refresh();[Console]::WriteLine('READY');[Console]::Out.Flush()});[System.Windows.Forms.Application]::Run($form)`;
  const child = spawn(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const exited = new Promise(resolve => child.once("close",resolve));
  const service = new ComputerService();
  t.after(async () => {
    child.kill();
    await Promise.all([service.stop(), exited]);
    removePrivateFixture(root);
  });
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error("Window fixture timed out")),30000);child.stdout.once("data",()=>{clearTimeout(deadline);resolve();});child.once("error",reject);});
  const queried = await service.execute({ action:"windows.list",query:title });
  assert.equal(queried.windows.length,1); const window = queried.windows[0];
  assert.equal(window.pid,child.pid);
  const captureWindow = () => service.execute({ action:"screen.capture",windowId:window.windowId,pid:window.pid,maxWidth:320 });
  const topLeft = image => {
    const png = Buffer.from(image.data, "base64");
    assert.equal(png[24], 8);
    assert.ok(png[25] === 2 || png[25] === 6);
    assert.equal(png[28], 0);
    const chunks = [];
    for (let offset = 8; offset + 12 <= png.length;) {
      const size = png.readUInt32BE(offset);
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    // The first pixel has no prior row or column, so its RGB bytes do not depend on the PNG filter.
    return inflateSync(Buffer.concat(chunks)).subarray(1, 4).toString("hex");
  };
  let captured = await captureWindow();
  // An off-screen window can initially return an unpainted black surface even after WinForms Shown.
  for (let i = 0; i < 5 && topLeft(captured) !== "dc143c"; i++) {
    await new Promise(resolve => setTimeout(resolve, 75));
    captured = await captureWindow();
  }
  assert.equal(topLeft(captured), "dc143c");
  const png = Buffer.from(captured.data,"base64");
  assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  assert.equal(captured.mimeType,"image/png"); assert.equal(captured.width,320);
  assert.ok(captured.height>100);assert.ok(png.length<8388608);
  const wait = { action: "screen.wait", source: captured.source };
  const unchanged = await service.execute({ ...wait, waitMs: 180 });
  assert.equal(unchanged.state, "unchanged");
  assert.equal(unchanged.capture, undefined);
  // The off-screen form changes on its own. Stub only input so the test never moves or clicks the physical cursor.
  const readback = new ComputerControlService({ native: {
    async request(action, input, options) {
      if (action === "control.begin") return { state: "active" };
      if (action === "input.execute") return { state: "injected", completedActions: 1, releaseState: "released" };
      if (action === "control.end") return { state: "ended" };
      assert.equal(action, "screen.wait");
      assert.equal((await readback.execute({ action: "control.status" })).state, "absent");
      const capture = service.native.request(action, input, options);
      fs.writeFileSync(trigger, "change");
      return capture;
    }
  } });
  const result = await readback.execute({ action: "input.perform", requestId: randomUUID(), source: captured.source,
    actions: [{ type: "key", keys: ["Enter"] }], captureAfter: { waitMs: 3000 } });
  assert.equal(result.state, "injected");
  assert.equal(result.controlCleanup.state, "ended");
  assert.equal(result.capture.width, captured.width);
  assert.equal(result.capture.source.windowId, window.windowId);
  assert.notEqual(result.capture.source.frameId, captured.source.frameId);
  assert.notEqual(result.capture.data, captured.data);
  assert.equal(topLeft(result.capture), "228b22");
  const abort = new AbortController();
  const pending = service.execute({ ...wait, source: result.capture.source, waitMs: 5000 }, { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const start = performance.now();
  const stop = setTimeout(() => abort.abort(), 150);
  try { await rejected; } finally { clearTimeout(stop); }
  assert.ok(performance.now() - start < 2500);
  assert.deepEqual(await service.execute({ ...wait, source: result.capture.source, waitMs: 150 }), { state: "unchanged" });
  await assert.rejects(service.execute({ action:"screen.capture",windowId:window.windowId,pid:window.pid+1 }),/changed/);
  const desktop = await service.execute({ action:"screen.capture",maxWidth:320 });
  assert.equal(desktop.width,320); assert.equal(desktop.mimeType,"image/png");
});

test("Windows helper addresses an owned minimized child without leasing desktop input", { skip: process.platform !== "win32" }, async t => {
  const title = "RabiBackground-" + randomUUID();
  const code = `
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = '${title}'
    $form.ShowInTaskbar = $false
    $form.StartPosition = 'Manual'
    $form.Location = New-Object System.Drawing.Point(30000,30000)
    $form.BackColor = [System.Drawing.Color]::CornflowerBlue
    $box = New-Object System.Windows.Forms.TextBox
    $form.Controls.Add($box)
    $box.Add_TextChanged({ if ($box.Text -eq 'Rabi') { [Console]::WriteLine('TEXT:Rabi'); [Console]::Out.Flush() } })
    $form.Add_Shown({
      $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
      [Console]::WriteLine(('READY:{0:x}:{1:x}' -f $form.Handle.ToInt64(),$box.Handle.ToInt64()))
      [Console]::Out.Flush()
    })
    [System.Windows.Forms.Application]::Run($form)`;
  const child = spawn(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("close", resolve));
  const service = new ComputerService();
  t.after(async () => { child.kill(); await Promise.all([service.stop(), exited]); });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", data => { output += data; });
  async function waitFor(pattern) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const match = output.match(pattern);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail("Window fixture did not report " + pattern);
  }
  const [, windowId, receiverWindowId] = await waitFor(/READY:([0-9a-f]+):([0-9a-f]+)/);
  const pid = child.pid;
  const parent = { windowId, pid };
  const target = (await service.execute({ action: "windows.list", query: title })).windows[0];
  assert.equal(target?.minimized, true);
  const discovered = await service.execute({ action: "windows.list", parent });
  assert.ok(discovered.windows.some(window => window.windowId === receiverWindowId && window.pid === pid));
  const input = { action: "input.background", ...parent, receiverWindowId, requestId: randomUUID(), actions: [{ type: "text", text: "Rabi" }] };
  const receipt = await service.execute(input);
  assert.equal(receipt.state, "posted", receipt.reason);
  assert.equal(receipt.minimized, true);
  assert.equal(receipt.postedMessages, 4);
  await waitFor(/TEXT:Rabi/);
  const original = await service.execute({ action: "input.status", requestId: input.requestId });
  assert.equal(original.state, "posted");
  assert.equal((await service.execute({ action: "control.status" })).state, "absent");
  const background = await service.execute({ action: "screen.capture.background", ...parent, maxWidth: 160 });
  assert.equal(background.source.windowId, windowId);
  assert.equal(background.source.captureMethod, "window-print");
  assert.equal(background.source.minimized, true);
  assert.equal(background.mimeType, "image/png");
  await assert.rejects(service.execute({ action: "screen.capture", ...parent }), /minimized/);
  assert.equal((await service.execute({ action: "control.status" })).state, "absent");
});

test("default I/O and active uploads remain usable beyond the hot history window",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-no-hidden-cap-"));const service=new ComputerService({maxUploadRecords:2,uploadHistoryRoot:path.join(root,"history")});
 t.after(async()=>{await service.stop();removePrivateFixture(root);});
 assert.equal(service.maxConcurrentIo,0);assert.equal(service.maxActiveUploads,0);
 const reads=[],originalRead=service.readFile;service.readFile=()=>new Promise(resolve=>reads.push(resolve));
 const pending=Array.from({length:9},()=>service.execute({action:"file.stat"}));assert.equal(service.pending,9);reads.forEach(resolve=>resolve({}));await Promise.all(pending);service.readFile=originalRead;
 const ids=[];for(let i=0;i<9;i++){const uploadId=randomUUID();ids.push(uploadId);await service.execute({action:"upload.begin",uploadId,path:path.join(root,i+".bin"),size:0,sha256:sha("")});}
 assert.equal(service.activeUploads(),9);assert.equal(service.uploads.size,9);for(const uploadId of ids)await service.execute({action:"upload.abort",uploadId});
});
