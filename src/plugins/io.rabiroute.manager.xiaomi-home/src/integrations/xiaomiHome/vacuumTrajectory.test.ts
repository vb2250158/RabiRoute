import assert from "node:assert/strict";
import test from "node:test";
import {parseVacuumTrajectory, VacuumTrajectoryParseError} from "./vacuumTrajectory.js";

test("trajectory rejects malformed, oversized, duplicate and non-finite feedback instead of creating a pose",()=>{
  const invalid = ["null","{}",'{"points":[{"pose_id":1,"x":0,"y":0},{"pose_id":1,"x":1,"y":0}]}',
    '{"points":[{"pose_id":1,"x":1e999,"y":0}]}',JSON.stringify({points:Array(1025).fill({pose_id:1,x:0,y:0})})," ".repeat(128*1024+1)];
  for(const output of invalid) assert.throws(()=>parseVacuumTrajectory(output));
});
test("trajectory diagnostics distinguish missing points and malformed JSON without echoing device payloads",()=>{
  assert.throws(()=>parseVacuumTrajectory('{}'), (error: unknown)=>error instanceof VacuumTrajectoryParseError&&error.reason==='points_type');
  assert.throws(()=>parseVacuumTrajectory('{"privateToken":"never-echo-this" invalid}'), (error: unknown)=>error instanceof VacuumTrajectoryParseError&&error.reason==='invalid_json'&&!error.message.includes('never-echo-this'));
});
