import test from "node:test";
import assert from "node:assert/strict";
import { peerServerDetail, speechServerOptions } from "../src/speech/peerServerPresentation";
import type { PeerConnectionStatus } from "../../src/shared/peerTunnelContract";
const peer: PeerConnectionStatus = { deviceId:"b",name:"B",online:true,supported:true,trusted:true,state:"connected",transport:"lan",latencyMs:3.2,measuredAt:1000 };
test("dropdown shows measured channel RTT, never a guessed or stale zero",()=>{
 assert.equal(peerServerDetail(peer,1001),"在线 · 局域网直连 · 3 ms");
 assert.equal(peerServerDetail({...peer,transport:"p2p",latencyMs:42.1},1001),"在线 · P2P直连 · 42 ms");
 assert.equal(peerServerDetail({...peer,transport:"relay",latencyMs:106},1001),"在线 · 服务器中转 · 106 ms");
 assert.equal(peerServerDetail(peer,31_001),"在线 · 局域网直连 · 延迟待检测");
 assert.equal(peerServerDetail({...peer,latencyMs:null},1001),"在线 · 局域网直连 · 延迟待检测");
 assert.equal(peerServerDetail({...peer,online:false},1001),"离线");
 assert.equal(peerServerDetail({...peer,supported:false,trusted:false},1001),"在线 · 需要升级");
 assert.equal(peerServerDetail({...peer,trusted:false,state:"idle",transport:null},1001),"在线 · 将自动连接");
 assert.equal(peerServerDetail({...peer,state:"idle",transport:null},1001),"在线 · 待检测");
});
test("an online supported application peer can be selected before its automatic handshake", () => {
 const options = speechServerOptions([
  {...peer,deviceId:"new-peer",trusted:false,state:"idle",transport:null},
  {...peer,deviceId:"old-peer",supported:false,trusted:false},
  {...peer,deviceId:"offline-peer",online:false}
 ],"saved-peer",1001);
 assert.equal(options[0].value,"");
 assert.equal(options[0].props.disabled,false);
 assert.equal(options[1].value,"new-peer");
 assert.equal(options[1].detail,"在线 · 将自动连接");
 assert.equal(options[1].props.disabled,false);
 assert.equal(options[2].props.disabled,true);
 assert.equal(options[3].props.disabled,true);
 assert.equal(options[4].value,"saved-peer");
 assert.equal(options[4].detail,"未发现设备");
 assert.equal(options[4].props.disabled,true);
});
