import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeQqHistoryWindow,qqHistoryRecord} from '../src/qqMessagePresentation';
import {qqPreviewRead} from '../src/qqPreviewQueue';

const selection={routeId:'review-route',kind:'group' as const,target:'12345'};
const rows=(first:number,last:number,time? :number)=>Array.from({length:last-first+1},(_,offset)=>{
  const n=first+offset;
  return qqHistoryRecord({messageId:String(n),sender:'67890',text:`message ${n}`,time:time??n},selection);
});

test('a reader above the bottom sees new arrivals even below the window limit',()=>{
  const current=rows(11,60),page=rows(12,61);
  const result=mergeQqHistoryWindow(current,page,false);
  assert.equal(result.entries.length,51);
  assert.equal(result.newerAvailable,true);
  assert.equal(result.entries[0]?.messageId,'11');
  assert.equal(result.entries.at(-1)?.messageId,'61');
  assert.equal(mergeQqHistoryWindow(current,page,true).newerAvailable,false);
  assert.equal(mergeQqHistoryWindow(current,rows(11,60),false).newerAvailable,false);
});

test('200 message refresh preserves the reading head or follows the tail with a usable older anchor',()=>{
  const current=rows(1,200),page=rows(152,201);
  const reading=mergeQqHistoryWindow(current,page,false);
  assert.equal(reading.entries.length,200);
  assert.equal(reading.entries[0]?.messageId,'1');
  assert.equal(reading.entries.at(-1)?.messageId,'200');
  assert.equal(reading.newerAvailable,true);
  const following=mergeQqHistoryWindow(current,page,true);
  assert.equal(following.entries.length,200);
  assert.equal(following.entries[0]?.messageId,'2');
  assert.equal(following.entries.at(-1)?.messageId,'201');
  assert.equal(new Set(following.entries.map(row=>row.id)).size,200);
  assert.equal(following.newerAvailable,false);
});

test('disjoint latest pages from the same second never replace an older reading window',()=>{
  const current=rows(1,50,100),page=rows(100,149,100);
  const result=mergeQqHistoryWindow(current,page,false);
  assert.deepEqual(result.entries,current);
  assert.equal(result.newerAvailable,true);
});

test('canceled queued media reads do not reach transport or poison later reconnect reads',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const calls:string[]=[];
  const first=qqPreviewRead(new AbortController().signal,async()=>{
    calls.push('first');started();await gate;return 'first';
  });
  await entered;
  const obsolete=new AbortController();
  const second=qqPreviewRead(obsolete.signal,async()=>{calls.push('obsolete');return 'obsolete';});
  const rejected=assert.rejects(second,{name:'AbortError'});
  obsolete.abort();
  const third=qqPreviewRead(new AbortController().signal,async()=>{calls.push('reconnected');return 'third';});
  assert.deepEqual(calls,['first']);
  release();
  assert.equal(await first,'first');await rejected;
  assert.equal(await third,'third');
  assert.deepEqual(calls,['first','reconnected']);
});
