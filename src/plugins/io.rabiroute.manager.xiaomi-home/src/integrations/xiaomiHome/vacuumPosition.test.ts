import assert from "node:assert/strict";
import test from "node:test";
import {parseVacuumPosition} from "./vacuumPosition.js";
test("position parser bounds data and keeps missing coordinates distinct from an origin",()=>{
 assert.equal(parseVacuumPosition("  "),undefined);
 assert.deepEqual(parseVacuumPosition('{"x":0,"y":0}'),{x:0,y:0});
 for(const value of [null,{},'null','[]','{}','{"x":"1","y":0}','{"x":0,"y":0,"yaw":null}','{"x":1e10,"y":0}',"x".repeat(4097)])assert.throws(()=>parseVacuumPosition(value));
});
