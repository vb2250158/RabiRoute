import assert from "node:assert/strict";
import test from "node:test";
import { deviceDirectory, HOME_DEVICE_DIRECTORY_TEMPLATE } from "./deviceDirectory.js";
import { normalizeHomeAssistantState, XiaomiHomeManagerApiClient } from "./managerApi.js";
const resources=["vacuum.test","sensor.battery","light.other","script.scene"].map(entity_id=>normalizeHomeAssistantState({entity_id,state:"idle"}));
test("device registry groups exact IDs, keeps duplicate names separate and retains unassigned entities",()=>{
 const result=deviceDirectory(resources,[{entityId:"vacuum.test",deviceId:"device-a",displayName:"Same",token:"not-returned"},{entityId:"sensor.battery",deviceId:"device-a",displayName:"Same"},{entityId:"sensor.battery",deviceId:"device-a"},{entityId:"light.other",deviceId:"device-b",displayName:"Same"},{entityId:"sensor.no_current_state",deviceId:"device-b"}]);
 assert.equal(result.devices.length,2);assert.equal(result.devices[0]!.resources.length,2);assert.deepEqual(result.unassignedResources.map(r=>r.entityId),["script.scene"]);assert.ok(!JSON.stringify(result).includes("not-returned"));
 assert.throws(()=>deviceDirectory(resources,{}));assert.throws(()=>deviceDirectory(resources,[{deviceId:"../../path",entityId:"vacuum.test"}]));
});
test("directory reads use only provider-owned fixed registry template and states",async()=>{
 const calls:string[]=[];
 const client=new XiaomiHomeManagerApiClient({baseUrl:"http://127.0.0.1:8123"},(async(input,init)=>{
  const url=String(input);calls.push(url);if(url.endsWith("/api/states"))return Response.json([{entity_id:"vacuum.test",state:"docked"}]);
  assert.ok(url.endsWith("/api/template"));assert.equal(init!.method,"POST");assert.deepEqual(JSON.parse(String(init!.body)),{template:HOME_DEVICE_DIRECTORY_TEMPLATE});
  return new Response(JSON.stringify([{entityId:"vacuum.test",deviceId:"device-a",displayName:"Vacuum"}]));
 }) as typeof fetch,"fixture-private-token");
 const result=await client.listDevices();assert.equal(result.devices[0]!.resources[0]!.state,"docked");assert.equal(calls.length,2);assert.ok(calls.every(url=>!url.includes("services")));
});
