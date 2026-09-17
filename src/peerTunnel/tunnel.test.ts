import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createTunnelHandshake, loadTunnelIdentity } from "./security.js";
import { establishTunnel, type TunnelSession } from "./session.js";
import type { TunnelChannel } from "./channel.js";
import { serveTunnel, serviceEndpoint, tunnelFetch } from "./http.js";
import { PeerConnections, type TunnelCandidate } from "./connections.js";
import { TunnelRtc } from "./rtc.js";
import { PeerTunnelRuntime } from "./runtime.js";

function channelPair(): [TunnelChannel, TunnelChannel] {
  const a = new EventEmitter() as TunnelChannel, b = new EventEmitter() as TunnelChannel;
  let closed = false;
  a.send = async data => { setImmediate(() => { if (!closed) b.emit("data", data); }); };
  b.send = async data => { setImmediate(() => { if (!closed) a.emit("data", data); }); };
  a.close = b.close = () => { if (!closed) { closed = true; a.emit("close"); b.emit("close"); } };
  return [a,b];
}

test("application-authenticated speech bootstrap pins identity and grants only speech", async t => {
  const { a, b, folder } = identities(t);
  const directory = path.join(folder,"bootstrap");
  const runtime = new PeerTunnelRuntime({ dataDir:directory,deviceId:"pc",generation:"test",allowSpeechBootstrap:()=>true,
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:""}),services:()=>({}),onStatus:()=>{} });
  t.after(()=>runtime.stop());
  const request = (identity: typeof a, expiresAt = Date.now()+30_000) => {
    const fields={source:"phone",publicKey:identity.publicKey,target:"pc",expiresAt};
    return {...fields,kind:"bootstrap-speech",signature:sign(null,Buffer.from("rabi-speech-bootstrap-v1"+JSON.stringify(fields)),identity.privateKey).toString("base64")};
  };
  const response = await runtime.offer(request(a)) as { deviceId:string; publicKey:string };
  assert.equal(response.deviceId,"pc");
  const config=JSON.parse(readFileSync(path.join(directory,"tunnel.json"),"utf8"));
  assert.equal(config.trustedDevices[0].publicKey,a.publicKey);
  assert.deepEqual(config.trustedDevices[0].services,["speech"]);
  assert.match(config.trustedDevices[0].bootstrapScope,/^[a-f0-9]{64}$/);
  await runtime.offer(request(a));
  await assert.rejects(runtime.offer(request(b)),/peer_identity_changed/);
  await assert.rejects(runtime.offer(request(a,Date.now()-1)),/peer_bootstrap_denied/);
  await assert.rejects(runtime.offer({...request(a),signature:"invalid"}),/peer_signature_denied/);
});
test("resource bootstrap is independent of speech and cannot grant Manager", async t => {
  const { a, folder } = identities(t);
  const directory=path.join(folder,"resource-bootstrap");
  const runtime=new PeerTunnelRuntime({dataDir:directory,deviceId:"pc",generation:"test",allowResourceBootstrap:()=>true,
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:""}),services:()=>({}),onStatus:()=>{}});
  t.after(()=>runtime.stop());
  const fields={source:"phone",publicKey:a.publicKey,target:"pc",expiresAt:Date.now()+30000};
  const request={...fields,kind:"bootstrap-resources",signature:sign(null,Buffer.from("rabi-resources-bootstrap-v1"+JSON.stringify(fields)),a.privateKey).toString("base64")};
  await runtime.offer(request);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory,"tunnel.json"),"utf8")).trustedDevices[0].services,["resources"]);
  await assert.rejects(runtime.offer({...request,kind:"bootstrap-speech"}),/peer_service_denied/);
  await assert.rejects(runtime.offer({...request,signature:"invalid"}),/peer_signature_denied/);
});
function identities(t: test.TestContext) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "rabi-tunnel-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const a = loadTunnelIdentity(path.join(folder, "a.json"), "a", "a-generation");
  const b = loadTunnelIdentity(path.join(folder, "b.json"), "b", "b-generation");
  return { a,b,folder, ga: { deviceId: a.deviceId, publicKey: a.publicKey, services: ["test"] }, gb: { deviceId: b.deviceId, publicKey: b.publicKey, services: ["test"] } };
}
async function sessions(t: test.TestContext) {
  const { a,b,ga,gb } = identities(t); const [ac,bc] = channelPair();
  const signal = AbortSignal.timeout(2_000);
  const pair = await Promise.all([establishTunnel(ac, a, gb, true, signal), establishTunnel(bc, b, ga, false, signal)]);
  t.after(() => pair.forEach(session => session.close())); return pair;
}
async function fixtureServer(t: test.TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler); server.listen(0, "127.0.0.1"); await once(server,"listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, url: "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port };
}
test("session keys are pinned, direction-specific, encrypted and replay protected", t => {
  const { a,b,ga,gb } = identities(t);
  const ah = createTunnelHandshake(a,"b"), bh = createTunnelHandshake(b,"a");
  const ac = ah.accept(bh.hello,gb,true), bc = bh.accept(ah.hello,ga,false);
  const packet = ac.encode({ text: "private audio metadata" });
  assert.ok(!packet.toString().includes("private audio metadata"));
  assert.deepEqual(bc.decode(packet),{ text: "private audio metadata" });
  assert.throws(() => bc.decode(packet));
  assert.throws(() => ah.accept({ ...bh.hello, generation: "changed" },gb,true));
  assert.throws(() => ah.accept(bh.hello,{ ...gb, publicKey: a.publicKey },true));
});
test("generic HTTP forwards new endpoints and large streaming bodies without operation registration", { timeout: 15_000 }, async t => {
  const [caller, receiver] = await sessions(t);
  const upstream = await fixtureServer(t,(request,response) => {
    if (request.url === "/new-endpoint?value=1") { response.writeHead(201,{"x-new-api":"yes"}); request.pipe(response); }
    else { response.writeHead(404); response.end(); }
  });
  serveTunnel(receiver,()=>({ test:{ baseUrl: upstream.url } }));
  const body = Buffer.alloc(2_000_000,77);
  const response = await tunnelFetch(caller,"test","/new-endpoint?value=1",{method:"POST",body});
  assert.equal(response.status,201); assert.equal(response.headers.get("x-new-api"),"yes");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
  const ping = await caller.ping(); assert.ok(ping >= 0 && ping < 1000);
});
test("service grants and paths fail closed", { timeout: 5_000 }, async t => {
  const [caller,receiver] = await sessions(t); let calls = 0;
  const upstream = await fixtureServer(t,(_req,res)=>{calls++;res.end("no");});
  serveTunnel(receiver,()=>({ test:{baseUrl:upstream.url} }));
  const denied = await tunnelFetch(caller,"ungranted","/private"); assert.equal(denied.status,403); await denied.text(); assert.equal(calls,0);
  assert.throws(()=>serviceEndpoint({baseUrl:upstream.url},"//other-host/private"));
  assert.throws(()=>serviceEndpoint({baseUrl:upstream.url,pathPrefix:"/safe"},"/../private"));
  assert.throws(()=>serviceEndpoint({baseUrl:upstream.url},"/api/rabilink/peer/selection"));
});
test("automatic selection uses LAN then P2P then relay and clears RTT after disconnect", async t => {
  const [session] = await sessions(t);
  const calls: string[]=[];
  const manager = new PeerConnections(async (_peer,transport)=>{calls.push(transport);if(transport!=="relay")throw new Error("offline");return session;});
  t.after(()=>manager.stop());
  const peer: TunnelCandidate = {id:"b",name:"B",online:true,supported:true,trusted:true,peerUrls:["http://127.0.0.1"]};
  assert.equal(await manager.get(peer),session); assert.deepEqual(calls,["lan","p2p","relay"]);
  assert.equal(manager.snapshot(peer).transport,"relay"); assert.ok(manager.snapshot(peer).latencyMs! >=0);
  await manager.get(peer); assert.equal(calls.length,3);
  session.close(); assert.equal(manager.snapshot(peer).transport,null); assert.equal(manager.snapshot(peer).latencyMs,null);
});
test("real WebRTC persistent tunnel carries multiple requests and RTT", {timeout: 15_000},async t=>{
  const {a,b,ga,gb}=identities(t); const callerRtc=new TunnelRtc([]),receiverRtc=new TunnelRtc([]);
  t.after(()=>{callerRtc.stop();receiverRtc.stop();});
  let incoming: Promise<TunnelSession> | undefined;
  const signal=AbortSignal.timeout(10_000);
  const channel=await callerRtc.connect(offer=>receiverRtc.offer(offer.sdp,channel=>{incoming=establishTunnel(channel,b,ga,false,signal); void incoming.catch(()=>{});}),signal);
  const callerPromise=establishTunnel(channel,a,gb,true,signal);
  const caller=await callerPromise; const receiver=await incoming!; t.after(()=>{caller.close();receiver.close();});
  const upstream=await fixtureServer(t,(_req,res)=>res.end("rtc")); serveTunnel(receiver,()=>({test:{baseUrl:upstream.url}}));
  assert.equal(await (await tunnelFetch(caller,"test","/one")).text(),"rtc");
  assert.equal(await (await tunnelFetch(caller,"test","/two")).text(),"rtc");
  assert.ok(await caller.ping()>=0);
});
test("runtime LAN discovery uses pinned identity and selection is persisted",{timeout:10_000},async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"rabi-runtime-test-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const upstream=await fixtureServer(t,(_req,res)=>res.end("remote"));
  let b:PeerTunnelRuntime; const lan=await fixtureServer(t,(_req,res)=>res.end());
  const options={generation:"generation",relay:()=>({url:"http://127.0.0.1",token:"test-token"}),services:()=>({test:{baseUrl:upstream.url}}),onStatus:()=>{}};
  b=new PeerTunnelRuntime({...options,dataDir:path.join(dir,"b"),deviceId:"b",discover:async()=>[],signal:async()=>{throw new Error("unused");}});
  lan.server.on("upgrade",(req,socket,head)=>b.upgrade(req,socket,head));
  const a=new PeerTunnelRuntime({...options,dataDir:path.join(dir,"a"),deviceId:"a",discover:async()=>[{id:"b",name:"B",deviceKind:"pc",online:true,capabilities:["peer-tunnel-v1"],peerUrls:[lan.url]}],signal:async()=>{throw new Error("LAN must win");}});
  t.after(()=>{a.stop();b.stop();});
  writeFileSync(path.join(dir,"a","tunnel.json"),JSON.stringify({selectedDeviceId:"",trustedDevices:[{deviceId:"b",publicKey:b.identity.publicKey,services:[]}]}));
  writeFileSync(path.join(dir,"b","tunnel.json"),JSON.stringify({selectedDeviceId:"",trustedDevices:[{deviceId:"a",publicKey:a.identity.publicKey,services:["test"]}]}));
  await a.select("b"); assert.equal(a.selected(),"b");
  assert.equal(await (await a.fetch("b","test","/fresh-api")).text(),"remote");
  const directory=await a.directory();assert.equal(directory.peers[0].transport,"lan");assert.ok(directory.peers[0].latencyMs!>=0);
});

test("Relay broker carries encrypted generic requests without inspecting the application payload", {timeout:10_000},async t=>{
  const { pathToFileURL }=await import("node:url");
  const { attachTunnelBroker }=await import(pathToFileURL(path.resolve("scripts/lib/rabilink-tunnel-broker.mjs")).href);
  const relay=await fixtureServer(t,(_req,res)=>res.end());
  const broker=attachTunnelBroker(relay.server,(req:http.IncomingMessage)=>req.headers["x-rabilink-token"]==="app-token"?"app-one":null);t.after(()=>broker.close());
  const {connectWebsocket}=await import("./channel.js");
  const {a,b,ga,gb}=identities(t);
  const endpoint=relay.url.replace("http:","ws:")+"/api/rabilink/tunnel/socket?room=12345678-1234-1234-1234-123456789abc";
  const signal=AbortSignal.timeout(5_000);
  const ac=await connectWebsocket(endpoint,{"x-rabilink-token":"app-token"},signal);
  const af=establishTunnel(ac,a,gb,true,signal);void af.catch(()=>{});
  const bc=await connectWebsocket(endpoint,{"x-rabilink-token":"app-token"},signal);
  const [caller,receiver]=await Promise.all([af,establishTunnel(bc,b,ga,false,signal)]);
  t.after(()=>{caller.close();receiver.close();});
  const upstream=await fixtureServer(t,(_req,res)=>res.end("relay body"));serveTunnel(receiver,()=>({test:{baseUrl:upstream.url}}));
  assert.equal(await(await tunnelFetch(caller,"test","/any-future-api")).text(),"relay body");
  assert.ok(await caller.ping()>=0);
});
test("generic WebSocket upgrade preserves duplex data",{timeout:8_000},async t=>{
  const {WebSocketServer,WebSocket}=await import("ws");
  const {proxyTunnelUpgrade}=await import("./http.js");
  const [caller,receiver]=await sessions(t);
  const upstream=await fixtureServer(t,(_req,res)=>res.end());
  const wss=new WebSocketServer({server:upstream.server});t.after(()=>wss.close());
  wss.on("connection",ws=>ws.on("message",data=>ws.send(data)));
  serveTunnel(receiver,()=>({test:{baseUrl:upstream.url}}));
  const front=await fixtureServer(t,(_req,res)=>res.end());
  front.server.on("upgrade",(req,socket,head)=>{void proxyTunnelUpgrade(caller,"test",req.url||"/",req,socket,head);});
  const ws=new WebSocket(front.url.replace("http:","ws:")+"/new-websocket");t.after(()=>ws.terminate());
  await once(ws,"open");const result=once(ws,"message");ws.send("new api, same tunnel");assert.equal((await result)[0].toString(),"new api, same tunnel");ws.close();
});
test("HTTP cancellation reaches target and does not replay an accepted write",{timeout:5_000},async t=>{
  const [caller,receiver]=await sessions(t);let writes=0;
  let closedResolve!:()=>void;const closed=new Promise<void>(resolve=>{closedResolve=resolve;});
  const upstream=await fixtureServer(t,(req,res)=>{writes++;res.writeHead(200);res.write("started");res.on("close",closedResolve);req.resume();});
  serveTunnel(receiver,()=>({test:{baseUrl:upstream.url}}));
  const control=new AbortController();const response=await tunnelFetch(caller,"test","/write",{method:"POST",body:"submit",signal:control.signal});
  const reader=response.body!.getReader();await reader.read();control.abort();await closed;assert.equal(writes,1);await reader.cancel().catch(()=>{});
});


test("failed latency validation closes the candidate before fallback", async t => {
  const [bad] = await sessions(t), [good] = await sessions(t);
  bad.ping = async () => { throw new Error("probe failed"); };
  const manager = new PeerConnections(async (_peer, transport) => transport === "lan" ? bad : good);
  t.after(() => manager.stop());
  const peer: TunnelCandidate = { id:"b", name:"B", online:true, supported:true, trusted:true, peerUrls:["http://127.0.0.1"] };
  assert.equal(await manager.get(peer), good); assert.equal(bad.closed, true);
  assert.equal(manager.snapshot(peer).transport, "p2p");
});
test("upgrade drains old streams and stop closes both generations", async t => {
  const [old] = await sessions(t), [fresh] = await sessions(t);
  let upgraded = false;
  const manager = new PeerConnections(async (_peer, transport) => {
    if (upgraded && transport === "lan") return fresh;
    if (transport === "relay") return old;
    throw new Error("unavailable");
  });
  t.after(() => manager.stop());
  const peer: TunnelCandidate = { id:"b", name:"B", online:true, supported:true, trusted:true, peerUrls:["http://127.0.0.1"] };
  await manager.get(peer);
  const stream = old.open({ service:"test", method:"GET", path:"/held", headers:{} });
  upgraded = true; await manager.reconsider(peer);
  assert.equal(await manager.get(peer), fresh); assert.equal(old.closed, false);
  manager.stop(); assert.equal(old.closed, true); assert.equal(fresh.closed, true);
  stream.on("error", () => {});
});
test("read-only runtime rejects selection and proxy access", async t => {
  const { folder } = identities(t);
  const runtime = new PeerTunnelRuntime({ dataDir:path.join(folder,"readonly"), deviceId:"readonly", generation:"test", readOnly:true,
    discover:async()=>[], signal:async()=>{}, relay:()=>({url:"http://127.0.0.1",token:""}), services:()=>({}), onStatus:()=>{} });
  t.after(()=>runtime.stop());
  await assert.rejects(runtime.select(""), /manager_read_only/);
  await assert.rejects(runtime.offer({}), /manager_read_only/);
  const server = await fixtureServer(t, (req,res) => { runtime.handler(req,new URL(req.url!,"http://localhost"),res,async()=>({deviceId:""})); });
  assert.equal((await fetch(server.url+"/api/rabilink/peer/selection",{method:"PUT"})).status,423);
  assert.equal((await fetch(server.url+"/api/rabilink/peer/http/b/test/any")).status,423);
  assert.equal((await fetch(server.url+"/api/rabilink/peer/selection")).status,200);
});


test("control endpoints use the injected WebGUI authorization without bypassing denials", async t => {
  const {folder} = identities(t);
  const runtime = new PeerTunnelRuntime({dataDir:path.join(folder,"authorized"),deviceId:"test",generation:"test",
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:""}),services:()=>({}),onStatus:()=>{},
    allowControl:(request)=>request.headers["x-test-authorized"]==="yes"});
  t.after(()=>runtime.stop());
  const server=await fixtureServer(t,(req,res)=>{runtime.handler(req,new URL(req.url!,"http://localhost"),res,async()=>({deviceId:""}));});
  const url=server.url+"/api/rabilink/peer/selection";
  assert.equal((await fetch(url)).status,403);
  assert.equal((await fetch(url,{headers:{"x-test-authorized":"yes"}})).status,200);
  assert.equal((await fetch(url,{method:"PUT"})).status,403);
  assert.equal((await fetch(url,{method:"PUT",headers:{"x-test-authorized":"yes"}})).status,200);
});
