import assert from "node:assert/strict";
import test from "node:test";
import { messageHistoryObservationProven } from "./messageHistorySourceVersion.js";

test("an intermediate file stat is accepted only inside a completed owner append window", () => {
  const proof = { layoutVersion: "layout", commits: [
    { stamp: "1:2:100:10:10", records: 1 },
    { stamp: "1:2:200:20:20", records: 2, startedAt: 1000, committedAt: 1010 }
  ] };
  assert.equal(messageHistoryObservationProven(proof, "1:2:150:10:20", 1005, 0), true);
  assert.equal(messageHistoryObservationProven(proof, "1:2:150:10:20", 999, 0), false);
  assert.equal(messageHistoryObservationProven(proof, "1:3:150:10:20", 1005, 0), false);
  assert.equal(messageHistoryObservationProven(proof, "1:2:250:10:20", 1005, 0), false);
  assert.equal(messageHistoryObservationProven(proof, "1:2:150:10:20", 1005, 1), false);
});
