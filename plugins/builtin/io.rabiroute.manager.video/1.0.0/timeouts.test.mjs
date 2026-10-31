import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { VideoService } from "./service.mjs";
import { RemoteVideoCompute } from "./remoteCompute.mjs";

test("video runtime uses configured request deadline through body consumption", async t => {
  const server = createServer((_request,response) => {response.writeHead(200,{"content-type":"application/json"});response.flushHeaders();response.write('{"value":');});
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const calls=[];
  const runtime={getTimeoutMs(key,fallback){calls.push([key,fallback]);return 100;}};
  const service=new VideoService(runtime,{},()=>{});service.endpoint="http://127.0.0.1:"+server.address().port;
  await assert.rejects(service.request("/test"),/abort|timeout/i);
  assert.deepEqual(calls,[["video.runtime.request",20000]]);
});
test("remote event and ordinary requests use separate runtime settings", async () => {
  const keys=[];
  const compute=new RemoteVideoCompute({getTimeoutMs(key){keys.push(key);return 1000;},peerFetch:async()=>Response.json({ok:true})},{},()=>{});
  await compute.json("device","/status");await compute.json("device","/events");
  assert.deepEqual(keys,["video.peer.request","video.peer.events"]);
});
