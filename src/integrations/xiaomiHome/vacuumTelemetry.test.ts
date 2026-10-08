import assert from "node:assert/strict";
import test from "node:test";
import {parseVacuumTelemetry, vacuumTelemetryContracts} from "./vacuumTelemetry.js";

const contract=vacuumTelemetryContracts["xiaomi.vacuum.pv11cn"];
const fixture=()=>({code:0,result:contract.map((p,index)=>({did:"123",...p,code:0,value:[8,0,false,1][index]}))});
test("telemetry validates the whole property set independent of order",()=>{
 const input=fixture(); input.result.reverse();
 assert.deepEqual(parseVacuumTelemetry(input,"123",contract),{statusCode:8,status:"remote",faultCode:0,locating:false,lidarCode:1,lidar:"top"});
 input.result.find(p=>p.piid===2)!.value=255;
 assert.equal(parseVacuumTelemetry(input,"123",contract).status,"unknown");
});
test("telemetry rejects foreign, missing, duplicate, rejected and mistyped values",()=>{
 for(const mutate of [
  (b:ReturnType<typeof fixture>)=>{b.code=-1;},
  (b:ReturnType<typeof fixture>)=>{b.result.pop();},
  (b:ReturnType<typeof fixture>)=>{b.result[3]=b.result[0];},
  (b:ReturnType<typeof fixture>)=>{b.result[0].did="456";},
  (b:ReturnType<typeof fixture>)=>{b.result[0].siid=3;},
  (b:ReturnType<typeof fixture>)=>{b.result[0].code=-1;},
  (b:ReturnType<typeof fixture>)=>{b.result[0].value=256;},
  (b:ReturnType<typeof fixture>)=>{b.result[1].value=-1;},
  (b:ReturnType<typeof fixture>)=>{b.result[1].value=4294967296;},
  (b:ReturnType<typeof fixture>)=>{b.result[2].value=0;},
  (b:ReturnType<typeof fixture>)=>{b.result[3].value=4;}
 ]) {const input=fixture();mutate(input);assert.throws(()=>parseVacuumTelemetry(input,"123",contract),/Invalid telemetry/);}
 assert.throws(()=>parseVacuumTelemetry(null,"123",contract),/Invalid telemetry/);
});
