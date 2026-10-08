import assert from "node:assert/strict";
import test from "node:test";
import { vacuumVideoClient } from "../src/homeDeviceClient.js";

const identity = { applicationGenerationId: "generation", managerInstanceId: "instance" };
test("recover existing camera session through the provider without another hardware start", async () => {
 const calls: string[] = [];
 const original = globalThis.fetch;
 globalThis.fetch = async (input) => {
  const url = String(input); calls.push(url);
  return Response.json(url === "/meta" ? identity : {code:0,data:{sessionId:"existing",deviceId:"123",region:"cn",state:"streaming",audio:false}});
 };
 try {
  assert.equal((await vacuumVideoClient.current("123"))?.sessionId, "existing");
  assert.deepEqual(calls, ["/meta", "/api/agent/xiaomi-home/vacuum-cloud/video/status", "/meta"]);
 } finally { globalThis.fetch = original; }
});
test("idle and stopped sessions cannot be resurrected; foreign active cameras are not taken over", async () => {
 const original = globalThis.fetch;
 let data: Record<string, unknown> = {state:"idle",audio:false};
 globalThis.fetch = async input => Response.json(String(input) === "/meta" ? identity : {code:0,data});
 try {
  assert.equal(await vacuumVideoClient.current("123"), undefined);
  data={sessionId:"old",deviceId:"123",region:"cn",state:"stopped",audio:false};
  assert.equal(await vacuumVideoClient.current("123"), undefined);
  data={...data,state:"streaming",deviceId:"456"};
  await assert.rejects(vacuumVideoClient.current("123"), /另一台设备/);
  data={...data,deviceId:"123",region:"us"};
  await assert.rejects(vacuumVideoClient.current("123"), /另一台设备/);
 } finally { globalThis.fetch = original; }
});
test("a provider generation change invalidates camera recovery", async () => {
 const original = globalThis.fetch;
 let metaReads=0;
 globalThis.fetch = async input => Response.json(String(input) === "/meta" ? {...identity,managerInstanceId:++metaReads===1?"instance":"new-instance"} : {code:0,data:{sessionId:"existing",deviceId:"123",region:"cn",state:"streaming",audio:false}});
 try { await assert.rejects(vacuumVideoClient.current("123"), /运行版本已变化/); }
 finally { globalThis.fetch = original; }
});
