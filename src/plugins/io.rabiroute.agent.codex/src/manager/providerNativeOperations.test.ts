import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { listCodexNativeSessionPage, listCodexDesktopThreads, readCodexDesktopThread } from "../codexDesktopBridge.js";
import { CodexNativeHistoryReader, createCodexNativeOperations } from "./providerNativeOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import { nativeHttpTestFetch as request } from "../../../../manager/nativeHttpTestClient.js";

const sessionId = "fixture-native-codex";
const metadata = JSON.stringify({ type: "session_meta", payload: { id: sessionId } });
function temporary(t: { after(fn: () => unknown): void }, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-history-"));
  const rollout = path.join(root, "native.jsonl");
  fs.writeFileSync(rollout, text);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    rollout,
    reader: new CodexNativeHistoryReader(id => id === sessionId ? { id, rolloutPath: rollout } : undefined)
  };
}

test("Codex history pages preserve native message/tool IDs, seek plain byte cursors and continue appended events", async t => {
  const records = [metadata, JSON.stringify({
    type: "response_item",
    payload: { id: "native-message-1", role: "user", content: [{ type: "input_text", text: "original" }] }
  }), JSON.stringify({
    type: "response_item",
    payload: { id: "native-tool-1", type: "function_call", call_id: "call-1", arguments: "{}" }
  })];
  const f = temporary(t, records.join("\r\n") + "\r\n");
  const starts: Array<number | undefined> = [], open = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), create = handle.createReadStream;
    handle.createReadStream = function(options) { starts.push(options?.start); return create.call(handle, options); };
    return handle;
  }) as typeof open;
  t.after(() => { fs.promises.open = open; });
  const first = await f.reader.read(sessionId, { limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal((first.entries[1]!.record as any).payload.id, "native-message-1");
  assert(first.nextCursor);
  const second = await f.reader.read(sessionId, { limit: 2, cursor: first.nextCursor });
  assert.equal((second.entries[0]!.record as any).payload.call_id, "call-1");
  assert.equal(second.entries[0]!.sequence, 3);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(starts, [0, JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()).offset]);
  fs.appendFileSync(f.rollout, JSON.stringify({ type: "response_item", payload: { id: "native-tool-result", call_id: "call-1", output: "kept" } }) + "\n");
  const appended = await f.reader.read(sessionId, { cursor: second.resumeCursor });
  assert.equal(appended.entries.length, 1);
  assert.equal(appended.entries[0]!.sequence, 4);
  assert.equal((appended.entries[0]!.record as any).payload.id, "native-tool-result");
});

test("Codex invalid rows stay local and an incomplete tail retains its exact restart cursor", async t => {
  const f = temporary(t, metadata + "\n" + "invalid-native-row".repeat(100) + "\n" + JSON.stringify({ type: "response_item", payload: { id: "kept" } }) + "\n" + '{"type":"response_item"');
  const page = await f.reader.read(sessionId, { maxBytes: 512 });
  assert.equal(page.entries.length, 2);
  assert.deepEqual(page.warnings, [{ sequence: 2, errorCode: "CODEX_HISTORY_ROW_INVALID" }]);
  assert.equal(page.coverage.pendingTail, true);
  assert.equal(page.coverage.lastSequence, 3);
  fs.appendFileSync(f.rollout, ',"payload":{"id":"finished"}}\n');
  const next = await f.reader.read(sessionId, { cursor: page.resumeCursor });
  assert.equal((next.entries[0]!.record as any).payload.id, "finished");
  assert.equal(next.entries[0]!.sequence, 4);
});

test("Codex complete large events require an explicit larger page budget without losing the event", async t => {
  const f = temporary(t, metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "large", content: "x".repeat(2000) } }) + "\n");
  const first = await f.reader.read(sessionId, { limit: 1 });
  await assert.rejects(f.reader.read(sessionId, { cursor: first.nextCursor!, maxBytes: 500 }), /requires .* bytes/);
  const next = await f.reader.read(sessionId, { cursor: first.nextCursor!, maxBytes: 4000 });
  assert.equal((next.entries[0]!.record as any).payload.content.length, 2000);
  await assert.rejects(f.reader.read("another-session", { cursor: first.nextCursor! }), /not found/);
  await assert.rejects(f.reader.read(sessionId, { signal: AbortSignal.abort() }), /abort/i);
  fs.writeFileSync(f.rollout, JSON.stringify({ type: "session_meta", payload: { id: "wrong-task" } }) + "\n");
  await assert.rejects(f.reader.read(sessionId), /does not belong/);
});

test("message-view filtering advances through large hidden events without exhausting the visible page budget", async t => {
  const rows = [metadata, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(4000) } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Final reply" } })];
  const f = temporary(t, rows.join("\n") + "\n");
  const page = await f.reader.read(sessionId, { maxBytes: 512, includeRecord: (value: any) => value.type === "event_msg" });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]!.sequence, 3);
  assert.equal(page.coverage.scannedRecords, 3);
  assert.equal(page.nextCursor, null);
});

test("Codex compressed native histories reuse the same decoded archive for subsequent pages", { skip: !(zlib as any).zstdCompressSync }, async t => {
  const f = temporary(t, metadata + "\n"), archived = f.rollout + ".zst";
  fs.writeFileSync(archived, (zlib as any).zstdCompressSync(Buffer.from(metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "archive-original" } }) + "\n")));
  fs.unlinkSync(f.rollout);
  const open = fs.promises.open;
  let archiveReads = 0;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === archived) archiveReads++;
    return handle;
  }) as typeof open;
  t.after(() => { fs.promises.open = open; });
  const first = await f.reader.read(sessionId, { limit: 1 });
  const second = await f.reader.read(sessionId, { cursor: first.nextCursor! });
  assert.equal((second.entries[0]!.record as any).payload.id, "archive-original");
  assert.equal(second.coverage.lastSequence, 2);
  assert.equal(archiveReads, 1);
});

test("Codex public operations expose real history through the normal registered HTTP contract", async t => {
  const f = temporary(t, metadata + "\n" + JSON.stringify({ type: "response_item", payload: { id: "http-native" } }) + "\n");
  const registry = new ManagerPluginRouteRegistry();
  const operations = createCodexNativeOperations({ history: f.reader, listSessions: () => ({ items: [{ id: sessionId }], nextOffset: 1 }) });
  const registration = registry.registerOperations("fixture.codex", operations);
  const server = http.createServer(async (req, res) => {
    markAuthenticatedConnectionRequest(req);
    if (!await registry.handle(req, new URL(req.url!, "http://localhost"), res)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await registration.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/providers/codex/sessions`;
  const listed = await request(root + "?limit=1");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.nextOffset, 1);
  const response = await request(root + `/${sessionId}/history?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.source, "codex-native-rollout");
  assert(body.data.nextCursor);
  const next = await request(root + `/${sessionId}/history?cursor=${encodeURIComponent(body.data.nextCursor)}`);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).data.entries[0].record.payload.id, "http-native");
  const missing = await request(root + "/missing/history");
  assert.equal(missing.status, 404);
});


test("Codex native session pages reach rows beyond the legacy ten-thousand scan budget", t => {
  const f = temporary(t, metadata + "\n");
  const databasePath = path.join(f.root, "native-state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT)`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, 'native title', 'fixture', '', 1, ?, 1, ?, 0, '')");
  db.exec("BEGIN");
  for (let index = 0; index < 10003; index++) insert.run(`native-session-${index}`, 20000 - index, 20000 - index);
  db.exec("COMMIT"); db.close();
  const page = listCodexNativeSessionPage({ databasePath, sessionIndexPath: path.join(f.root, "no-sidebar-index"), offset: 10000, limit: 2 });
  assert.deepEqual(page.items.map(row => row.id), ["native-session-10000", "native-session-10001"]);
  assert.equal(page.nextOffset, 10002);
  const last = listCodexNativeSessionPage({ databasePath, sessionIndexPath: path.join(f.root, "no-sidebar-index"), offset: page.nextOffset!, limit: 2 });
  assert.deepEqual(last.items.map(row => row.id), ["native-session-10002"]); assert.equal(last.nextOffset, null);
});


test("conversation pages exclude Guardian origins before pagination and preserve direct history reads", t => {
  const f = temporary(t, metadata + "\n");
  const databasePath = path.join(f.root, "approval-state.sqlite");
  const sessionIndexPath = path.join(f.root, "session_index.jsonl");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT, source TEXT)`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, 'fixture', '', 1, ?, 1, ?, 0, '', ?)");
  for (let index = 0; index < 60; index++) insert.run('approval-'+index,'Renamed approval',1000-index,1000-index,JSON.stringify({subagent:{other:'guardian'}}));
  insert.run('user-a','Guardian review',100,100,'vscode');
  insert.run('worker','Worker',90,90,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'user-a'}}}));
  insert.run('user-b','Another task',80,80,'cli');
  db.close();
  fs.writeFileSync(sessionIndexPath, ['user-a','worker','user-b'].map(id => JSON.stringify({id,thread_name:id==='user-a'?'Guardian review':id,updated_at:'1970-01-01T00:00:00Z'})).join('\n'));
  const first = listCodexNativeSessionPage({databasePath,sessionIndexPath,limit:2});
  assert.deepEqual(first.items.map(row=>row.id), ['user-a','worker']);
  assert.equal(first.nextOffset,2);
  const second = listCodexNativeSessionPage({databasePath,sessionIndexPath,limit:2,offset:first.nextOffset!});
  assert.deepEqual(second.items.map(row=>row.id), ['user-b']);
  assert.equal(second.nextOffset,null);
  assert.deepEqual(listCodexDesktopThreads({databasePath,sessionIndexPath,limit:10}).map(row=>row.id), ['user-a','worker','user-b']);
  assert.deepEqual(listCodexDesktopThreads({databasePath,sessionIndexPath,query:'Guardian review'}).map(row=>row.id), ['user-a']);
  assert.equal(readCodexDesktopThread('approval-0',databasePath,sessionIndexPath)?.id,'approval-0');
});


test("root pages exclude workers before pagination and a parent roster follows the native descendant graph",t=>{
  const f=temporary(t,metadata+"\n"), databasePath=path.join(f.root,'relations.sqlite'),sessionIndexPath=path.join(f.root,'names.jsonl');
  const db=new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,recency_at INTEGER,recency_at_ms INTEGER,archived INTEGER,first_user_message TEXT,source TEXT,agent_nickname TEXT,agent_role TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY,status TEXT);`);
  const insert=db.prepare("INSERT INTO threads VALUES(?,?,'fixture','',1,?,1,?,0,'',?,?,?)");
  const add=(id:string,time:number,source:string,nickname:string|null=null)=>insert.run(id,id,time,time,source,nickname,nickname?'worker':null);
  add('root-a',100,'vscode');add('root-b',90,'vscode');
  const edge=db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,'closed')");
  for(let index=0;index<60;index++){const id='child-'+index;add(id,1000-index,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'root-a'}}}),'Worker '+index);edge.run('root-a',id);}
  add('grandchild',800,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'child-0'}}}),'Nested worker');edge.run('child-0','grandchild');
  add('legacy-child',700,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'root-a',agent_nickname:'Legacy worker'}}}));
  add('other-child',600,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'root-b'}}}));edge.run('root-b','other-child');
  add('approval',2000,JSON.stringify({subagent:{other:'guardian'}}));edge.run('root-a','approval');
  db.close();
  const first=listCodexNativeSessionPage({databasePath,sessionIndexPath,rootsOnly:true,limit:1});
  assert.deepEqual(first.items.map(item=>item.id),['root-a']);assert.equal(first.nextOffset,1);
  const second=listCodexNativeSessionPage({databasePath,sessionIndexPath,rootsOnly:true,offset:1,limit:1});
  assert.deepEqual(second.items.map(item=>item.id),['root-b']);assert.equal(second.nextOffset,null);
  const all=listCodexNativeSessionPage({databasePath,sessionIndexPath,limit:1});assert.equal(all.items[0].id,'child-0');
  const members=listCodexNativeSessionPage({databasePath,sessionIndexPath,parentSessionId:'root-a',limit:100});
  assert.equal(members.items.length,62);assert(members.items.some(item=>item.id==='grandchild'));assert(members.items.some(item=>item.id==='legacy-child'));
  assert(!members.items.some(item=>item.id==='other-child'||item.id==='approval'||item.id==='root-a'));
  assert.equal(members.items.find(item=>item.id==='child-0')?.agentNickname,'Worker 0');
  assert.equal(members.items.find(item=>item.id==='grandchild')?.parentThreadId,'child-0');
  assert.equal(listCodexDesktopThreads({databasePath,sessionIndexPath,limit:100}).some(item=>item.id==='child-0'),true,'configured task lookup still discovers workers');
});

test("native session scopes are declared and conflicting root/parent requests fail locally",async()=>{
  const calls:unknown[]=[];
  const operations=createCodexNativeOperations({listSessions:options=>{calls.push(options);return{items:[],nextOffset:null};}});
  const list=operations.find(item=>item.contract.operationId==='agent.providers.codex.sessions.list')!;
  const invoke=(query:string)=>list.handler({url:new URL('http://fixture.invalid/api/agent/providers/codex/sessions?'+query),path:{}} as any) as Promise<any>;
  assert.equal((await invoke('view=roots&previews=1')).status,200);
  assert.equal((calls[0] as any).rootsOnly,true);assert.equal((calls[0] as any).previews,true);
  assert.equal((await invoke('parentSessionId=root')).status,200);assert.equal((calls[1] as any).parentSessionId,'root');
  assert.equal((await invoke('view=roots&parentSessionId=root')).status,400);
});


test("public message history advances through hidden native records within one visible page",async t=>{
  const rows=[metadata,...Array.from({length:250},()=>JSON.stringify({type:'response_item',payload:{type:'function_call',arguments:'hidden'}})),JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Visible final'}]}})];
  const f=temporary(t,rows.join('\n')+'\n');
  const operations=createCodexNativeOperations({history:f.reader});
  const read=operations.find(op=>op.contract.operationId==='agent.providers.codex.sessions.history.read')!;
  const response=await read.handler({url:new URL('http://fixture.invalid?limit=2&maxBytes=2048&view=messages'),path:{sessionId}} as any) as any;
  assert.equal(response.status,200);assert.equal(response.body.data.entries.length,1);assert.equal(response.body.data.entries[0].record.payload.content[0].text,'Visible final');assert.equal(response.body.data.nextCursor,null);
});


test("message pages bound malformed-row warnings while retaining the next visible message",async t=>{
  const f=temporary(t,[metadata,'bad-1','bad-2',JSON.stringify({type:'event_msg',payload:{type:'task_complete',last_agent_message:'Final'}})].join('\n')+'\n');
  const includeRecord=(record:any)=>record.type==='event_msg';
  const first=await f.reader.read(sessionId,{limit:2,includeRecord});assert.equal(first.warnings.length,2);assert.equal(first.entries.length,0);assert(first.nextCursor);
  const second=await f.reader.read(sessionId,{limit:2,includeRecord,cursor:first.nextCursor!});assert.equal(second.entries.length,1);assert.equal((second.entries[0].record as any).payload.last_agent_message,'Final');
});
