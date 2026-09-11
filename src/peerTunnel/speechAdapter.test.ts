import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createPeerSpeechAdapter, speechUsesLocalDevice } from "./speechAdapter.js";

test("speech compute uses selected peer and remote WAV is queued locally without replay",async t=>{
  const localPaths:string[]=[];
  const server=http.createServer((req,res)=>{localPaths.push(req.url!);req.resume();res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"local-job"}));});
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();server.close();});
  const url="http://127.0.0.1:"+(server.address() as import("node:net").AddressInfo).port;
  let requests=0;
  const adapter=createPeerSpeechAdapter(()=>({selected:()=>"b",fetch:async(id,service,pathname,init)=>{
    requests++;assert.equal(id,"b");assert.equal(service,"speech");assert.equal(pathname,"/v1/audio/speech");assert.equal(JSON.parse(String(init?.body)).play,false);
    return new Response("WAV",{headers:{"content-type":"audio/wav"}});
  }}));
  const result=await adapter.requestBinary(url,"/v1/audio/speech",{method:"POST",body:JSON.stringify({input:"text",play:true})});
  assert.equal(result.headers["x-rabispeech-playback-job"],"local-job");assert.equal(requests,1);assert.deepEqual(localPaths,["/v1/playback/audio"]);
  assert.ok(speechUsesLocalDevice("/v1/microphone/start"));assert.ok(speechUsesLocalDevice("/v1/playback/status"));assert.ok(!speechUsesLocalDevice("/v1/models"));
});
test("failed remote compute never silently invokes local inference",async()=>{
  let requests=0;
  const adapter=createPeerSpeechAdapter(()=>({selected:()=>"b",fetch:async()=>{requests++;throw new Error("peer offline");}}));
  await assert.rejects(adapter.requestBinary("http://127.0.0.1","/v1/audio/speech",{method:"POST",body:"{}"}),/peer offline/);assert.equal(requests,1);
});
