import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendPersonaChatReply,readPersonaChatHistory,readPersonaHistoryTasks } from './personaChatHistory.js';
import { personaHistoryTaskKey,type PersonaChatTaskOwner } from './shared/personaChatHistory.js';

async function fixture(t:test.TestContext){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'persona-task-history-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function send(dir:string,from:string,to:string,n:number,owner?:PersonaChatTaskOwner){return appendPersonaChatReply(dir,{sessionId:from,sessionTitle:from.toUpperCase(),targetSessionId:to,targetSessionTitle:to.toUpperCase(),text:`message ${n}`,kind:'agent_delivery',deliveryId:`delivery-${n}`,sourceTaskOwner:owner});}

test('one task aggregates both directions with all peers, including receive-only tasks',async t=>{
  const dir=await fixture(t);await send(dir,'a','b',1);await send(dir,'c','a',2);await send(dir,'a','c',3);
  const tasks=await readPersonaHistoryTasks(dir,{category:'agent'});assert.deepEqual(new Set(tasks.items.map(task=>task.sessionId)),new Set(['a','b','c']));
  const key=personaHistoryTaskKey('a');
  const history=await readPersonaChatHistory(dir,undefined,50,{taskKey:key,category:'agent',summary:true});
  assert.deepEqual(history.entries.map(row=>row.text),['message 3','message 2','message 1']);
  assert.deepEqual(new Set((await readPersonaHistoryTasks(dir,{category:'agent',peerOf:key})).items.map(task=>task.sessionId)),new Set(['b','c']));
  assert.equal((await readPersonaChatHistory(dir,undefined,50,{taskKey:personaHistoryTaskKey('b'),category:'agent'})).entries.length,1);
});
test('task pages cover old tasks beyond the message window and paginate tied positions without duplication',async t=>{
  const dir=await fixture(t);for(let n=0;n<115;n++)await send(dir,`task-${n}`,'common',n);
  const seen=new Set<string>();let cursor:string|undefined;
  do{const page=await readPersonaHistoryTasks(dir,{category:'agent',cursor,limit:7});for(const task of page.items){assert(!seen.has(task.key));seen.add(task.key);}cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(seen.size,116);
  let offset:number|undefined;const ids:string[]=[];
  do{const page=await readPersonaChatHistory(dir,offset,7,{taskKey:personaHistoryTaskKey('common'),category:'agent',summary:true});ids.push(...page.entries.map(row=>row.id));offset=page.nextCursor??undefined;}while(offset!==undefined);
  assert.equal(ids.length,115);assert.equal(new Set(ids).size,115);
  const peers=await readPersonaHistoryTasks(dir,{category:'agent',peerOf:personaHistoryTaskKey('common'),limit:100});assert.equal(peers.items.length,100);assert.ok(peers.nextCursor);
  assert.equal((await readPersonaHistoryTasks(dir,{category:'agent',peerOf:personaHistoryTaskKey('common'),cursor:peers.nextCursor!,limit:100})).items.length,15);
});
test('equal thread IDs on distinct hosts remain separate, and self-deliveries do not duplicate rows',async t=>{
  const dir=await fixture(t),owner:PersonaChatTaskOwner={kind:'instance',provider:'codex',agentId:'codex',nodeId:'remote'};
  await send(dir,'same','other',1);await send(dir,'same','other',2,owner);await send(dir,'self','self',3);
  const tasks=await readPersonaHistoryTasks(dir,{category:'agent'});assert.equal(tasks.items.filter(task=>task.sessionId==='same').length,2);
  assert.equal((await readPersonaChatHistory(dir,undefined,50,{taskKey:personaHistoryTaskKey('same',owner)})).entries[0]?.text,'message 2');
  assert.equal((await readPersonaChatHistory(dir,undefined,50,{taskKey:personaHistoryTaskKey('self')})).entries.length,1);
  assert.equal((await readPersonaHistoryTasks(dir,{peerOf:personaHistoryTaskKey('self')})).items.length,0);
});
test('categories, partial corruption, full-body expansion and indexed refresh preserve original records',async t=>{
  const dir=await fixture(t);await send(dir,'a','b',1);
  await appendPersonaChatReply(dir,{sessionId:'a',turnId:'turn',text:'long '.repeat(1000)});
  const file=path.join(dir,'chat-history/final-replies.jsonl');await fs.appendFile(file,'{broken}\n');
  const tasks=await readPersonaHistoryTasks(dir,{category:'replies'});assert.equal(tasks.items.length,1);assert.equal(tasks.invalidRecords,1);
  const page=await readPersonaChatHistory(dir,undefined,50,{category:'replies',taskKey:personaHistoryTaskKey('a'),summary:true});const row=page.entries[0]!;
  assert.equal(row.text.length,2000);assert.equal(row.textTruncated,true);
  const body=await readPersonaChatHistory(dir,row.historyCursor,1,{direction:'newer',id:row.id});assert.equal(body.entries[0]?.text.length,5000);
  assert.equal((await readPersonaHistoryTasks(dir,{category:'agent',query:'B'})).items[0]?.sessionId,'b');
  const first=await readPersonaHistoryTasks(dir,{category:'agent',limit:1});assert.ok(first.nextCursor);
  await assert.rejects(readPersonaHistoryTasks(dir,{category:'replies',cursor:first.nextCursor!}),/cursor/);
});


test('a malformed optional kind is isolated while future string kinds retain physical write order', async t => {
  const dir = await fixture(t);
  const row = (await appendPersonaChatReply(dir, { sessionId: 'original', turnId: 'turn', text: 'healthy' }))!;
  const file = path.join(dir, 'chat-history/final-replies.jsonl');
  await fs.appendFile(file, [JSON.stringify({ ...row, id: 'bad-kind', kind: 17 }),
    JSON.stringify({ ...row, id: 'future-kind', kind: 'future_plugin_reply', text: 'future' })].join('\n') + '\n');
  const original = await fs.readFile(file);
  const tasks = await readPersonaHistoryTasks(dir, { category: 'replies' });
  assert.equal(tasks.invalidRecords, 1);
  assert.equal(tasks.items.length, 1);
  const history = await readPersonaChatHistory(dir, undefined, 50, { taskKey: personaHistoryTaskKey('original'), summary: true });
  assert.deepEqual(history.entries.map(record => record.id), ['future-kind', row.id]);
  assert.equal(history.invalidRecords, 1);
  assert.deepEqual(await fs.readFile(file), original);
});
