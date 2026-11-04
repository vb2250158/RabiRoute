import assert from 'node:assert/strict';
import test from 'node:test';
import {qqDisplayParts,qqHistoryRecord,mergeQqHistoryWindow} from '../src/qqMessagePresentation';
import {qqPreviewRead} from '../src/qqPreviewQueue';
const selection={routeId:'test',kind:'group' as const,target:'10001'};
const row=(id:number)=>qqHistoryRecord({messageId:String(id),time:id,sender:'20002',text:`message ${id}`},selection);

test('legacy text/@/reply are not files; unnamed real media and old files remain readable',()=>{
  const parts=qqDisplayParts('晚一点',undefined,[{kind:'text'},{kind:'at'},{kind:'reply'},{name:'old.pdf'},{kind:'image'},{kind:'audio'}]);
  assert.deepEqual(parts.map(p=>p.kind),['text','media','media','media']);
  assert.deepEqual(parts.filter(p=>p.kind==='media').map(p=>[p.index,p.mediaKind]),[[0,'file'],[1,'image'],[2,'record']]);
  assert.deepEqual(qqDisplayParts('[CQ:image,file=literal]',[{kind:'text',text:'[CQ:image,file=literal]'}],[{kind:'file',name:'not-an-extra-file'}]),[{kind:'text',text:'[CQ:image,file=literal]'}]);
});
test('new messages merge without dropping a loaded older page or inventing a bridge across a gap',()=>{
  const current=Array.from({length:60},(_,i)=>row(i+1));
  const merged=mergeQqHistoryWindow(current,Array.from({length:50},(_,i)=>row(i+12)),true);
  assert.equal(merged.entries.length,61);assert.equal(merged.entries[0]?.messageId,'1');assert.equal(merged.entries.at(-1)?.messageId,'61');
  const gap=mergeQqHistoryWindow(current,[row(90),row(91)],false);
  assert.equal(gap.entries,current);assert.equal(gap.newerAvailable,true);
  const sameSecond=mergeQqHistoryWindow([row(1),row(2)].map(r=>({...r,time:100})),[row(3),row(4)].map(r=>({...r,time:100})),false);
  assert.equal(sameSecond.newerAvailable,true);
  const bounded=mergeQqHistoryWindow(Array.from({length:200},(_,i)=>row(i+1)),[row(200),row(201)],false);
  assert.equal(bounded.entries[0]?.messageId,'1');assert.equal(bounded.entries.at(-1)?.messageId,'200');assert.equal(bounded.newerAvailable,true);
});
test('preview lane releases rejected work and skips cancelled queued requests',async()=>{
  let release!:()=>void,started=false,third=false;
  const first=qqPreviewRead(new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve;}));
  await Promise.resolve();
  const aborted=new AbortController();
  const second=qqPreviewRead(aborted.signal,async()=>{started=true;});
  const rejection=assert.rejects(second);aborted.abort();
  const last=qqPreviewRead(new AbortController().signal,async()=>{third=true;});
  release();await first;await rejection;await last;assert.equal(started,false);assert.equal(third,true);
});
