import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ComputerService } from "../lib/computer-service.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");

test("binary files transfer in checked chunks, commit once and preserve existing files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-computer-"));
  const service = new ComputerService(); t.after(() => { service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
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
