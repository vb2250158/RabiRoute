import type { AllDayEvent } from "../../src/shared/allDayRecording";

/** A local step is safe only inside an untrimmed, fully loaded time range. */
export function adjacentLoadedEvent(events: readonly AllDayEvent[], cursor: { time: number; id: string }, direction: "older" | "newer", range: { start: number; end: number }, complete: boolean) {
  if (!complete || cursor.time < range.start || cursor.time >= range.end) return;
  const compare = (a: AllDayEvent, b: AllDayEvent) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  let candidate: AllDayEvent | undefined;
  for (const event of events) {
    const order = event.startedAt - cursor.time || event.id.localeCompare(cursor.id);
    if (direction === "older" ? order >= 0 : order <= 0) continue;
    if (!candidate || (direction === "older" ? compare(event,candidate) > 0 : compare(event,candidate) < 0)) candidate = event;
  }
  return candidate && candidate.startedAt >= range.start && candidate.startedAt < range.end ? candidate : undefined;
}

/** Interval maximums prune offscreen events without losing long overlapping audio. */
export function reviewIndex(events: readonly AllDayEvent[]) {
  let leaves = 1; while(leaves < events.length) leaves *= 2;
  const ends = new Float64Array(leaves * 2).fill(-Infinity);
  for(let i = 0; i < events.length; i++) ends[leaves+i] = events[i].endedAt;
  for(let i = leaves - 1; i > 0; i--) ends[i] = Math.max(ends[i*2],ends[i*2+1]);
  return { events, ends, leaves, byId: new Map(events.map(event => [event.id,event])) };
}
export function reviewWindow(index: ReturnType<typeof reviewIndex>, start: number, end: number) {
  const rows: AllDayEvent[] = [];
  function visit(node: number, low: number, high: number) {
    if(low >= index.events.length || index.events[low].startedAt > end || index.ends[node] < start) return;
    if(high - low === 1) { rows.push(index.events[low]); return; }
    const middle = (low + high) >>> 1;
    visit(node*2,low,middle); visit(node*2+1,middle,high);
  }
  visit(1,0,index.leaves);
  return rows;
}
export function latestReviewEvent(events: readonly AllDayEvent[], source = "all") {
  let fallback: AllDayEvent | undefined;
  let newest: AllDayEvent | undefined;
  for(let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if(source !== "all" && event.source !== source) continue;
    newest ??= event;
    if(!fallback && event.kind !== "status") fallback = event;
    if(event.source === "screen" && event.kind === "image") return event;
  }
  return fallback ?? newest;
}
