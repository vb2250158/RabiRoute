import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sign, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createTunnelHandshake, loadTunnelIdentity } from "./security.js";
import { establishTunnel, type TunnelSession } from "./session.js";
import type { TunnelChannel } from "./channel.js";
import { serveTunnel, serviceEndpoint, tunnelFetch } from "./http.js";
import { PeerConnections, type TunnelCandidate } from "./connections.js";
import { TunnelRtc } from "./rtc.js";
import { APPLICATION_ACCESS_CAPABILITY, PeerTunnelRuntime } from "./runtime.js";
import { createCorePublicOperations, type CorePublicOperationsContext } from "../manager/corePublicOperations.js";
import { validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { createPeerProxyHttpOperations } from "./apiProxyHttpOperations.js";
import { createPeerControlOperations } from "./apiControlOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";

function peerHttpRoutes(t: test.TestContext, runtime: PeerTunnelRuntime) {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerHttpProxies("fixture-peer", createPeerProxyHttpOperations(runtime));
  const controls = registry.registerOperations("fixture-peer-control", createPeerControlOperations(runtime));
  t.after(() => registration.dispose());
  t.after(() => controls.dispose());
  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url!, "http://owner.fixture");
    return registry.handle(request, url, response);
  };
}

function channelPair(): [TunnelChannel, TunnelChannel] {
  const a = new EventEmitter() as TunnelChannel, b = new EventEmitter() as TunnelChannel;
  let closed = false;
  a.send = async data => { setImmediate(() => { if (!closed) b.emit("data", data); }); };
  b.send = async data => { setImmediate(() => { if (!closed) a.emit("data", data); }); };
  a.close = b.close = () => { if (!closed) { closed = true; a.emit("close"); b.emit("close"); } };
  return [a,b];
}

test("application bootstrap pins identity for all services", async t => {
  const { a, b, folder } = identities(t);
  const directory = path.join(folder,"bootstrap");
  const runtime = new PeerTunnelRuntime({ dataDir:directory,deviceId:"pc",generation:"test",allowApplicationConnection:()=>true,
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:"application-token"}),services:()=>({}),onStatus:()=>{} });
  t.after(()=>runtime.stop());
  const request = (identity: typeof a, expiresAt = Date.now()+30_000) => {
    const fields={source:"phone",publicKey:identity.publicKey,target:"pc",expiresAt};
    return {...fields,kind:"bootstrap-application",signature:sign(null,Buffer.from("rabi-application-bootstrap-v1"+JSON.stringify(fields)),identity.privateKey).toString("base64")};
  };
  const response = await runtime.offer(request(a)) as { deviceId:string; publicKey:string };
  assert.equal(response.deviceId,"pc");
  const config=JSON.parse(readFileSync(path.join(directory,"tunnel.json"),"utf8"));
  assert.equal(config.trustedDevices[0].publicKey,a.publicKey);
  assert.deepEqual(config.trustedDevices[0].services,[]);
  assert.match(config.trustedDevices[0].bootstrapScope,/^[a-f0-9]{64}$/);
  await runtime.offer(request(a));
  await assert.rejects(runtime.offer(request(b)),/peer_identity_changed/);
  await assert.rejects(runtime.offer(request(a,Date.now()-1)),/peer_bootstrap_denied/);
  await assert.rejects(runtime.offer({...request(a),signature:"invalid"}),/peer_signature_denied/);
});
test("obsolete service-specific bootstrap wire kinds are rejected", async t => {
  const { a, folder } = identities(t);
  const directory=path.join(folder,"resource-bootstrap");
  const runtime=new PeerTunnelRuntime({dataDir:directory,deviceId:"pc",generation:"test",allowApplicationConnection:()=>true,
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:"application-token"}),services:()=>({}),onStatus:()=>{}});
  t.after(()=>runtime.stop());
  const fields={source:"phone",publicKey:a.publicKey,target:"pc",expiresAt:Date.now()+30000};
  for (const service of ["speech", "resources", "persona"]) {
    const request = { ...fields, kind: "bootstrap-" + service, signature: sign(null, Buffer.from("rabi-" + service + "-bootstrap-v1" + JSON.stringify(fields)), a.privateKey).toString("base64") };
    await assert.rejects(runtime.offer(request), /peer_bootstrap_kind_denied/);
  }
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
test("verified opens arriving before the server listener are delivered once and cleared on close", async t => {
  const [caller, receiver] = await sessions(t);
  const arrived = once(receiver, "activity"), stream = caller.open({ service: "test", method: "GET", path: "/first", headers: {} });
  stream.end(); await arrived;
  let delivered = 0;
  receiver.on("request", incoming => {
    ++delivered; assert.equal(incoming.id, stream.id);
    incoming.resume(); void incoming.reply({ status: 204, headers: {} }).then(() => incoming.end());
  });
  assert.equal((await stream.response).status, 204); stream.resume(); assert.equal(delivered, 1);
  const [nextCaller, nextReceiver] = await sessions(t), nextArrived = once(nextReceiver, "activity");
  nextCaller.open({ service: "test", method: "GET", path: "/closed", headers: {} }); await nextArrived;
  nextReceiver.close(); let stale = 0; nextReceiver.on("request", () => ++stale);
  await new Promise<void>(resolve => queueMicrotask(resolve)); assert.equal(stale, 0);
});

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
  assert.equal(serviceEndpoint({baseUrl:upstream.url},"/api/rabilink/peer/selection").pathname,"/api/rabilink/peer/selection");
});
test("an authorized service alias cannot impersonate a local identity reset request", async t => {
  const [caller, receiver] = await sessions(t);
  let resets = 0;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("fixture-alias-reset", createCorePublicOperations({
    identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }),
    identityReset: {
      service: { available: () => true, enqueue: async (input: { operationId: string }) => { ++resets; return { operationId: input.operationId, state: "queued" as const }; }, status: async () => undefined },
      currentGuid: () => "647f6388-a4dc-4327-ab17-3ccbd43ef9e2"
    }
  } as unknown as CorePublicOperationsContext).filter(value => value.contract.pathTemplate.startsWith("/api/rabi/identity/reset-instance-id")));
  t.after(() => registration.dispose());
  const upstream = await fixtureServer(t, (request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  serveTunnel(receiver, () => ({ alias: { baseUrl: upstream.url, headers: { "x-rabiroute-peer-proxy": "" } } }), service => service === "alias");
  const response = await tunnelFetch(caller, "alias", "/api/rabi/identity/reset-instance-id", {
    method: "POST", headers: { "content-type": "application/json", "x-rabiroute-peer-proxy": "" }, body: "{}"
  });
  assert.equal(response.status, 403);
  await response.text();
  assert.equal(resets, 0);
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
  const options={generation:"generation",relay:()=>({url:"http://127.0.0.1",token:"test-token"}),allowApplicationConnection:()=>true,services:()=>({test:{baseUrl:upstream.url}}),onStatus:()=>{}};
  b=new PeerTunnelRuntime({...options,dataDir:path.join(dir,"b"),deviceId:"b",discover:async()=>[],signal:async()=>{throw new Error("unused");}});
  lan.server.on("upgrade",(req,socket,head)=>b.upgrade(req,socket,head));
  const a=new PeerTunnelRuntime({...options,dataDir:path.join(dir,"a"),deviceId:"a",discover:async()=>[{id:"b",name:"B",deviceKind:"pc",online:true,capabilities:["peer-tunnel-v1",APPLICATION_ACCESS_CAPABILITY],peerUrls:[lan.url]}],signal:async call=>{assert.equal((call.input as {kind:string}).kind,"bootstrap-application");return b.offer(call.input);}});
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
    allowApplicationConnection:()=>false,
    discover:async()=>[], signal:async()=>{}, relay:()=>({url:"http://127.0.0.1",token:""}), services:()=>({}), onStatus:()=>{} });
  t.after(()=>runtime.stop());
  await assert.rejects(runtime.select(""), /manager_read_only/);
  await assert.rejects(runtime.offer({}), /manager_read_only/);
  const handle = peerHttpRoutes(t, runtime);
  const server = await fixtureServer(t, (req,res) => { handle(req,res); });
  assert.equal((await fetch(server.url+"/api/rabilink/peer/selection",{method:"PUT",body:JSON.stringify({deviceId:""})})).status,423);
  assert.equal((await fetch(server.url+"/api/rabilink/peer/http/b/test/any")).status,423);
  assert.equal((await fetch(server.url+"/api/rabilink/peer/selection")).status,200);
});


test("control endpoints use the injected WebGUI authorization without bypassing denials", async t => {
  const {folder} = identities(t);
  const runtime = new PeerTunnelRuntime({dataDir:path.join(folder,"authorized"),deviceId:"test",generation:"test",
    allowApplicationConnection:()=>false,
    discover:async()=>[],signal:async()=>{},relay:()=>({url:"http://127.0.0.1",token:""}),services:()=>({}),onStatus:()=>{},
    allowControl:(request)=>request.headers["x-test-authorized"]==="yes"});
  t.after(()=>runtime.stop());
  const handle = peerHttpRoutes(t, runtime);
  const server=await fixtureServer(t,(req,res)=>{handle(req,res);});
  const url=server.url+"/api/rabilink/peer/selection";
  assert.equal((await fetch(url)).status,403);
  assert.equal((await fetch(url,{headers:{"x-test-authorized":"yes"}})).status,200);
  assert.equal((await fetch(url,{method:"PUT",body:JSON.stringify({deviceId:""})})).status,403);
  assert.equal((await fetch(url,{method:"PUT",headers:{"x-test-authorized":"yes"},body:JSON.stringify({deviceId:""})})).status,200);
});


test("revoked trust closes a reused session and prevents background upgrades", async t => {
  const [session] = await sessions(t); let starts = 0;
  const manager = new PeerConnections(async () => { starts++; return session; }); t.after(() => manager.stop());
  const peer: TunnelCandidate = { id: "b", name: "B", online: true, supported: true, trusted: true, peerUrls: ["http://127.0.0.1"] };
  await manager.get(peer); const revoked = { ...peer, trusted: false };
  await manager.reconsider(revoked); assert.equal(session.closed, true); assert.equal(starts, 1);
  await assert.rejects(manager.get(revoked), /trust_required/); assert.equal(starts, 1);
});


test("public peer APIs remain reachable while recursive and private wire paths fail closed", { timeout: 5000 }, async t => {
  const [caller, receiver] = await sessions(t); const reached: string[] = [];
  const upstream = await fixtureServer(t, (request, response) => { reached.push(request.url!); response.end("public"); });
  serveTunnel(receiver, () => ({ test: { baseUrl: upstream.url } }));
  for (const path of ["/api/rabilink/peer/list", "/api/rabilink/peer/servers", "/api/rabilink/peer/selection", "/api/rabilink/peer/http/c/manager/api/new-endpoint"]) {
    const response = await tunnelFetch(caller, "test", path); assert.equal(response.status, 200); await response.text();
  }
  for (const path of ["/api/rabilink/peer/tunnel/socket", "/api/rabilink/peer/receive", "/api/rabilink/peer/http/b/manager/api/new-endpoint",
    "/api/rabilink/peer/http/c/manager/api/rabilink/peer/http/c/manager/api/new-endpoint",
    ["c", "d", "e", "f", "g"].map(id => "/api/rabilink/peer/http/" + id + "/manager").join("") + "/api/new-endpoint"]) {
    const response = await tunnelFetch(caller, "test", path); assert.equal(response.status, 403, path); await response.text();
  }
  assert.equal(reached.length, 4);
});

test("third-PC generic Manager forwarding preserves an unknown API and public headers without business registration", { timeout: 10000 }, async t => {
  const { folder } = identities(t); const runtimes = new Map<string, PeerTunnelRuntime>(); const lans = new Map<string, string>();
  let ownerWrites = 0, ownerIdentity = "";
  const owners = new Map<string, string>();
  const handlers = new Map<string, ReturnType<typeof peerHttpRoutes>>();
  for (const id of ["a", "b", "c"]) {
    const owner = await fixtureServer(t, (request, response) => {
      const principal = validateInternalManagerHop(request, { generation: id + "-generation",
        scope: createHash("sha256").update("http://127.0.0.1\nfixture-application").digest("hex") });
      assert.ok(principal, "actual runtime must attest each local Manager request");
      assert.equal(principal.deviceId, id === "b" ? "a" : "b");
      if (id === "b" && handlers.get(id)!(request, response)) return;
      if (id === "c" && request.url === "/api/future-capability?fresh=1") {
        ownerWrites++; ownerIdentity = String(request.headers["x-rabilink-tunnel-device-id"]);
        assert.equal(request.headers["x-rabiroute-new-contract-field"], "future-value");
        assert.equal(request.headers["if-match"], '"current"'); assert.equal(request.headers["idempotency-key"], "original-operation");
        response.writeHead(201, { "x-rabiroute-future-result": "retained" }); request.pipe(response); return;
      }
      response.writeHead(404); response.end();
    });
    owners.set(id, owner.url);
    const lan = await fixtureServer(t, (_request, response) => response.end()); lans.set(id, lan.url);
    const runtime = new PeerTunnelRuntime({ dataDir: path.join(folder, "three", id), deviceId: id, generation: id + "-generation",
      allowApplicationConnection: () => true, allowControl: () => true,
      discover: async () => [...lans].filter(([peerId]) => peerId !== id).map(([peerId, url]) => ({ id: peerId, name: peerId, online: true, deviceKind: "pc", peerUrls: [url], capabilities: ["peer-tunnel-v1", APPLICATION_ACCESS_CAPABILITY] })),
      signal: async call => runtimes.get(call.targetDeviceId)!.offer(call.input), relay: () => ({ url: "http://127.0.0.1", token: "fixture-application" }),
      services: () => ({ manager: { baseUrl: owners.get(id)! } }), onStatus: () => {} });
    runtimes.set(id, runtime); t.after(() => runtime.stop());
    handlers.set(id, peerHttpRoutes(t, runtime));
    lan.server.on("upgrade", (request, socket, head) => runtime.upgrade(request, socket, head));
  }
  const body = Buffer.alloc(100000, 42);
  const result = await runtimes.get("a")!.fetch("b", "manager", "/api/rabilink/peer/http/c/manager/api/future-capability?fresh=1", {
    method: "PUT", headers: { "x-rabiroute-new-contract-field": "future-value", "if-match": '"current"', "idempotency-key": "original-operation", "x-rabilink-tunnel-device-id": "forged" }, body });
  assert.equal(result.status, 201); assert.equal(result.headers.get("x-rabiroute-future-result"), "retained");
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), body); assert.equal(ownerWrites, 1); assert.equal(ownerIdentity, "b");
  assert.equal((await runtimes.get("a")!.directory()).peers.find(peer => peer.deviceId === "b")?.transport, "lan");
  assert.equal((await runtimes.get("b")!.directory()).peers.find(peer => peer.deviceId === "c")?.transport, "lan");
});


test("WebSocket ingress revocation stops new frames without forwarding or reconnecting", { timeout: 5000 }, async t => {
  const { WebSocketServer, WebSocket } = await import("ws"); const { proxyTunnelUpgrade } = await import("./http.js");
  const [caller, receiver] = await sessions(t); let allowed = true, frames = 0;
  const upstream = await fixtureServer(t, (_request, response) => response.end());
  const wss = new WebSocketServer({ server: upstream.server }); t.after(() => wss.close());
  wss.on("connection", ws => ws.on("message", data => { frames++; ws.send(data); }));
  serveTunnel(receiver, () => ({ test: { baseUrl: upstream.url } }));
  const front = await fixtureServer(t, (_request, response) => response.end());
  front.server.on("upgrade", (request, socket, head) => { void proxyTunnelUpgrade(caller, "test", "/future-socket", request, socket, head, () => { if (!allowed) throw new Error("revoked"); }); });
  const ws = new WebSocket(front.url.replace("http:", "ws:") + "/future-socket"); t.after(() => ws.terminate());
  await once(ws, "open"); const echo = once(ws, "message"); ws.send("allowed"); await echo;
  allowed = false; const closed = once(ws, "close"); ws.send("denied"); await closed;
  assert.equal(frames, 1); assert.equal(caller.streams.size, 0);
});
