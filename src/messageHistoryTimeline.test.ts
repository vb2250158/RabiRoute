import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { refreshMessageHistoryIndex, searchMessageHistoryIndexResult } from './messageHistorySearchIndex.js';
import { createPersonaHistoryOperations } from './manager/personaHistoryOperations.js';
import { ManagerPluginRouteRegistry } from './manager/managerPluginRouteRegistry.js';
import type { MessageContextRecord, RecentMessageContextQuery } from './messageContextStore.js';
import { nativeHttpTestFetch as fetch } from './manager/nativeHttpTestClient.js';

function fixture(t: test.TestContext, rows: MessageContextRecord[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-channel-'));
  const directory = path.join(root, 'role'), current = path.join(directory, 'conversation/current.jsonl'), index = path.join(root, 'index.sqlite');
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  refreshMessageHistoryIndex(directory, index);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, current, index, read: (query: RecentMessageContextQuery) => searchMessageHistoryIndexResult(directory, query, index) };
}
const row = (n: number, adapter = 'napcat', text = `消息 😀 ${n}`): MessageContextRecord => ({ schemaVersion: 1, id: `id-${n}`, sequence: 0, time: 1000 + n, direction: n % 2 ? 'inbound' : 'outbound', adapter, conversationKey: 'room', text });

test('conversation catalog covers system, timer, speech and future plugins without crossing adapters',t=>{
  const adapters=['system','heartbeat','speech','future-plugin'];
  const f=fixture(t,adapters.flatMap((adapter,index)=>[{...row(index*2,adapter,'[CQ:image,file=literal-plugin-text]'),conversationKey:'shared-key',target:adapter},{...row(index*2+1,adapter),conversationKey:'old-key',target:adapter+' old'}]));
  for(const adapter of adapters){const page=f.read({adapter,limit:1,includeArchives:true,page:{catalogOnly:true,conversations:true}});assert.equal(page.entries.length,0);assert.equal(page.page?.conversations?.length,2);assert.equal(page.page?.conversations?.find(c=>c.conversationKey==='shared-key')?.title,adapter);assert.equal(page.page?.conversations?.find(c=>c.conversationKey==='shared-key')?.preview,'[CQ:image,file=literal-plugin-text]');}
});

test('channel pages traverse physical writes without omissions across duplicate and sequence-less legacy rows and concurrent appends', t => {
  const rows = Array.from({ length: 151 }, (_, n) => row(n, n % 3 ? 'napcat' : 'other'));
  const f = fixture(t, [...rows, { ...rows[1]!, text: 'later duplicate' }]);
  const query = { limit: 7, includeArchives: true, adapter: 'napcat', page: {} };
  const first = f.read(query);
  const seen = [...first.entries].reverse();
  assert.ok(first.page?.nextCursor);
  fs.appendFileSync(f.current, JSON.stringify(row(999)) + '\n'); refreshMessageHistoryIndex(f.directory, f.index);
  let cursor: string | null = first.page!.nextCursor;
  while (cursor) { const page = f.read({ ...query, page: { cursor } }); seen.push(...page.entries.slice().reverse()); cursor = page.page!.nextCursor; }
  assert.deepEqual(seen.map(item => item.id), rows.filter(item => item.adapter === 'napcat').reverse().map(item => item.id));
  assert.equal(new Set(seen.map(item => item.id)).size, seen.length);
  assert.equal(seen.find(item => item.id === rows[1]!.id)?.text, rows[1]!.text);
});

test('channel budgets preserve a large unconsumed row; cursors bind filters and source replacement', t => {
  const f = fixture(t, [row(1), row(2, 'napcat', '大'.repeat(4000)), row(3)]);
  const query = { limit: 50, maxChars: 500, includeArchives: true, adapter: 'napcat', page: {} };
  const first = f.read(query); assert.deepEqual(first.entries.map(item => item.id), ['id-3']);
  const second = f.read({ ...query, page: { cursor: first.page!.nextCursor! } }); assert.deepEqual(second.entries.map(item => item.id), ['id-2']);
  const third = f.read({ ...query, page: { cursor: second.page!.nextCursor! } }); assert.deepEqual(third.entries.map(item => item.id), ['id-1']);
  assert.equal(third.page!.nextCursor, null);
  assert.throws(() => f.read({ ...query, adapter: 'other', page: { cursor: first.page!.nextCursor! } }), /CURSOR_EXPIRED/);
  assert.throws(() => f.read({ ...query, page: { cursor: 'invalid' } }), /CURSOR_INVALID/);
  fs.writeFileSync(f.current, JSON.stringify(row(900)) + '\n'); refreshMessageHistoryIndex(f.directory, f.index);
  assert.throws(() => f.read({ ...query, page: { cursor: first.page!.nextCursor! } }), /CURSOR_EXPIRED/);
});

test('channel catalog discovers older adapters without projecting message bodies', t => {
  const f = fixture(t, [row(1, 'historic-plugin'), row(2, 'napcat')]);
  const result = f.read({ limit: 1, includeArchives: true, page: { includeAdapters: true, catalogOnly: true } });
  assert.deepEqual(result.page?.adapters, ['historic-plugin', 'napcat']); assert.deepEqual(result.entries, []);
  assert.equal(f.read({ limit: 1 }).page, undefined);
});

test('HTTP channel tabs follow configured endpoints while explicit historic queries and the Agent excerpt contract remain available', async t => {
  const f = fixture(t, [row(1), row(2, 'historic-plugin'), row(3)]);
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('fixture', createPersonaHistoryOperations({ roleDir: () => f.directory,
    configuredHistoryAdapters: () => ['speech', 'napcat'], queryHistory: async (_dir, query) => f.read(query) }));
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, 'http://fixture.invalid'), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await registration.dispose(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/roles/Example/`;
  const catalog = await (await fetch(base + 'message-history-channels')).json() as any;
  assert.deepEqual(catalog.data.adapters.sort(), ['napcat', 'speech']);
  const historic = await (await fetch(base + 'message-endpoint-timeline?adapter=historic-plugin&limit=1&includeArchives=1')).json() as any;
  assert.equal(historic.data.entries[0].id, 'id-2');
  assert.equal(historic.data.entries[0].adapter, 'historic-plugin');
  const page = await (await fetch(base + 'message-endpoint-timeline?adapter=napcat&limit=1&includeArchives=1')).json() as any;
  assert.equal(page.data.coverage.paginationSupported, true); assert.equal(page.data.entries[0].id, 'id-3');
  const older = await (await fetch(base + 'message-endpoint-timeline?adapter=napcat&limit=1&includeArchives=1&cursor=' + page.data.nextCursor)).json() as any;
  assert.equal(older.data.entries[0].id, 'id-1');
  assert.equal((await fetch(base + 'message-endpoint-history?cursor=1')).status, 400);
});


test('QQ conversation discovery groups exact accounts, preserves private targets, and pages past a hundred conversations', t => {
  const records = Array.from({length:125},(_,n)=>({...row(n),gatewayId:'route-a',instanceId:'account-a',conversationKey:'napcat:gateway:route-a:instance:account-a:group:'+String(10000+n)}));
  records.push({...row(300),gatewayId:'route-a',instanceId:'account-a',conversationKey:'napcat:gateway:route-a:instance:account-a:private:20002'});
  records.push({...row(301),gatewayId:'route-b',instanceId:'account-b',conversationKey:'napcat:gateway:route-b:instance:account-b:group:10000'});
  records.push({...records[0]!,id:'latest-room',time:9999,text:'Latest room preview'});
  records.push({...records[0]!,id:'latest-room',time:10000,text:'Conflicting replay must not replace the preview'});
  const f=fixture(t,records);
  const query={limit:1,includeArchives:true,page:{conversations:true,catalogOnly:true}};
  const first=f.read(query),second=f.read({...query,page:{...query.page,conversationCursor:first.page!.nextConversationCursor!}});
  const conversations=[...first.page!.conversations!,...second.page!.conversations!];
  assert.equal(conversations.length,127);assert.equal(new Set(conversations.map(item=>item.conversationKey)).size,127);
  assert.equal(conversations.find(item=>item.target==='20002')?.kind,'private');
  assert.equal(conversations.filter(item=>item.target==='10000').length,2);
  assert.equal(conversations.find(item=>item.conversationKey===records[0]!.conversationKey)?.preview,'Latest room preview');
  assert.deepEqual(first.entries,[]);
});
