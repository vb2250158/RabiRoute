import test from "node:test";
import assert from "node:assert/strict";
import { orderedAsrWorkers, selectAsrWorker, validateAsrPriority } from "./lib/rabilink-asr-priority.mjs";

const workers = [
  { id: "a", capabilities: ["speech", "asr"], online: true },
  { id: "b", capabilities: ["speech", "asr"], online: false },
  { id: "tts", capabilities: ["speech"], online: true },
];
test("offline preferred ASR falls back, then recovers its priority", () => {
  assert.equal(selectAsrWorker(workers,["b","a"]).id,"a");
  assert.equal(selectAsrWorker(workers.map(w => ({...w,online:true})),["b","a"]).id,"b");
  assert.deepEqual(orderedAsrWorkers(workers,["b"]).map(w=>w.id),["b","a"]);
});
test("no eligible online ASR does not select a TTS-only worker", () => {
  assert.equal(selectAsrWorker(workers,["b","a"],["a"]),null);
  assert.equal(selectAsrWorker(workers.map(w=>({...w,online:false}))),null);
});
test("priority rejects duplicates and workers outside the application ASR list", () => {
  assert.throws(()=>validateAsrPriority(["a","a"],workers));
  assert.throws(()=>validateAsrPriority(["other-account"],workers));
  assert.throws(()=>validateAsrPriority(["tts"],workers));
  assert.deepEqual(validateAsrPriority(["b","a"],workers),["b","a"]);
});
