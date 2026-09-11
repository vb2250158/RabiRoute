import test from "node:test";
import assert from "node:assert/strict";
import { peerServerDetail } from "../src/speech/peerServerPresentation";
import type { PeerConnectionStatus } from "../../src/shared/peerTunnelContract";
const peer: PeerConnectionStatus = { deviceId:"b",name:"B",online:true,supported:true,trusted:true,state:"connected",transport:"lan",latencyMs:3.2,measuredAt:1000 };
test("dropdown shows measured channel RTT, never a guessed or stale zero",()=>{
 assert.equal(peerServerDetail(peer,1001),"在线 · 局域网直连 · 3 ms");
 assert.equal(peerServerDetail({...peer,transport:"p2p",latencyMs:42.1},1001),"在线 · P2P直连 · 42 ms");
 assert.equal(peerServerDetail({...peer,transport:"relay",latencyMs:106},1001),"在线 · 服务器中转 · 106 ms");
 assert.equal(peerServerDetail(peer,31_001),"在线 · 局域网直连 · 延迟待检测");
 assert.equal(peerServerDetail({...peer,latencyMs:null},1001),"在线 · 局域网直连 · 延迟待检测");
 assert.equal(peerServerDetail({...peer,online:false},1001),"离线");
 assert.equal(peerServerDetail({...peer,state:"idle",transport:null},1001),"在线 · 待检测");
});
