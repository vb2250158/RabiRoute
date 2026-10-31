import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { VacuumVideoTransport, holdVideoStream, safeVideoFailure } from "./vacuumVideo.js";

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
