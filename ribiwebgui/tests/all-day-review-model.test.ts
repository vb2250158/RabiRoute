import test from "node:test";
import assert from "node:assert/strict";
import { reviewIndex, reviewWindow, latestReviewEvent } from "../src/allDayReviewModel";
import type { AllDayEvent } from "../../src/shared/allDayRecording";
const event = (id: string, start: number, end: number, source: AllDayEvent["source"] = "screen"): AllDayEvent => ({id,startedAt:start,endedAt:end,source,kind:source === "session" ? "status" : "image",state:"saved",deviceId:"test"});
test("large timeline window includes long overlapping recordings and boundary events", () => {
  const rows = Array.from({length:100000},(_,i) => event(String(i),i*1000,i*1000+100));
  rows[0] = event("long",0,90000000,"microphone");
  const result = reviewWindow(reviewIndex(rows),89999900,90001000);
  assert.deepEqual(result.map(row=>row.id),["long","90000","90001"]);
  assert.equal(reviewWindow(reviewIndex(rows),100000001,100000100).length,0);
});
test("initial preview chooses a screenshot rather than a newer status, and respects source filters", () => {
  const rows=[event("screen",1,1),event("camera",2,2,"camera"),event("status",3,3,"session")];
  assert.equal(latestReviewEvent(rows)?.id,"screen");
  assert.equal(latestReviewEvent(rows,"camera")?.id,"camera");
  assert.equal(latestReviewEvent([]),undefined);
});
