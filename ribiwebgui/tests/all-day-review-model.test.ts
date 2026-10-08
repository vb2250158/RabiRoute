import test from "node:test";
import assert from "node:assert/strict";
import { reviewIndex, reviewWindow, latestReviewEvent, adjacentLoadedEvent, mergeReviewEvents } from "../src/allDayReviewModel";
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

test("an empty live range keeps the latest saved frame outside the viewport", () => {
  const recent = [event("saved-screen", 100, 100)];
  const range = [event("new-status", 200, 200, "session")];
  const recentFirst = mergeReviewEvents([], recent);
  assert.equal(latestReviewEvent(recentFirst)?.id, "saved-screen");
  assert.equal(latestReviewEvent(mergeReviewEvents(range, recent))?.id, "saved-screen");
  assert.equal(latestReviewEvent(mergeReviewEvents([], recent))?.id, "saved-screen");
  assert.deepEqual(mergeReviewEvents(range, recent).map(row => row.id), ["saved-screen", "new-status"]);
  assert.deepEqual(mergeReviewEvents([], []), []);
});

test("merged live records deduplicate IDs, update delayed ASR and preserve time ordering", () => {
  const old = { ...event("same", 200, 200), text: "old" };
  const updated = { ...old, text: "new" };
  const rows = mergeReviewEvents([old, event("earlier", 100, 100)], [updated]);
  assert.deepEqual(rows.map(row => row.id), ["earlier", "same"]);
  assert.equal(rows[1].text, "new");
  assert.equal(old.text, "old");
});

test("adjacent cached steps preserve same-time identity and reject incomplete history", () => {
 const rows=[event("a",100,100),event("b",100,100,"camera"),event("c",200,200)];
 const range={start:50,end:250};
 assert.equal(adjacentLoadedEvent(rows,{time:100,id:"b"},"older",range,true)?.id,"a");
 assert.equal(adjacentLoadedEvent(rows,{time:100,id:"b"},"newer",range,true)?.id,"c");
 assert.equal(adjacentLoadedEvent(rows,{time:100,id:"a"},"newer",range,true)?.id,"b");
 assert.equal(adjacentLoadedEvent(rows,{time:100,id:"b"},"older",range,false),undefined);
 assert.equal(adjacentLoadedEvent(rows,{time:100,id:"b"},"newer",{start:50,end:150},true),undefined);
 assert.equal(adjacentLoadedEvent(rows.filter(x=>x.source==="screen"),{time:100,id:"a"},"newer",range,true)?.id,"c");
});
