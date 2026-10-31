import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ComputerService } from "../lib/computer-service.mjs";
import { computerRequestSchema } from "../lib/interactive-protocol.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
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
  const code = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $form=New-Object System.Windows.Forms.Form; $form.Text='${title}'; $form.Width=420; $form.Height=260; $form.StartPosition='Manual'; $form.Location=New-Object System.Drawing.Point(30000,30000); $form.ShowInTaskbar=$false; $form.BackColor=[System.Drawing.Color]::Crimson; $form.Add_Shown({[Console]::WriteLine('READY');[Console]::Out.Flush()});[System.Windows.Forms.Application]::Run($form)`;
  const child = spawn(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const exited = new Promise(resolve => child.once("close",resolve));
  const service = new ComputerService(); t.after(async()=>{service.stop();child.kill();await exited;});
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error("Window fixture timed out")),30000);child.stdout.once("data",()=>{clearTimeout(deadline);resolve();});child.once("error",reject);});
  const queried = await service.execute({ action:"windows.list",query:title });
  assert.equal(queried.windows.length,1); const window = queried.windows[0];
  assert.equal(window.pid,child.pid);
  const captured = await service.execute({ action:"screen.capture",windowId:window.windowId,pid:window.pid,maxWidth:320 });
  const png = Buffer.from(captured.data,"base64");
  assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  assert.equal(captured.mimeType,"image/png"); assert.equal(captured.width,320);
  assert.ok(captured.height>100);assert.ok(png.length<8388608);
  await assert.rejects(service.execute({ action:"screen.capture",windowId:window.windowId,pid:window.pid+1 }),/changed/);
  const desktop = await service.execute({ action:"screen.capture",maxWidth:320 });
  assert.equal(desktop.width,320); assert.equal(desktop.mimeType,"image/png");
});
