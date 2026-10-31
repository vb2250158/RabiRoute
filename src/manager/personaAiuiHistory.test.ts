import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchChatHistoryFixture } from './personaHistoryOperationTestFixtures.js';
test('AIUI transcript ingestion uses persona history, supports user-first sync, replay and conflicting-turn rejection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-persona-history-'));
  let desktopReads = 0;
  const server = http.createServer((req, res) => {
    if (dispatchChatHistoryFixture(req, new URL(req.url!, 'http://localhost'), res, id => {
      if (!['One', 'Two'].includes(id)) throw new Error('UNKNOWN_ROLE');
      return path.join(root, id);
    }, ids => { desktopReads += ids.length; return []; })) return;
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const input = { sessionId: 'glasses-session', turnId: 'turn-1', userText: '帮忙查询计划' };
  const post = (body: unknown) => fetch(base + '/api/roles/One/chat-history/aiui', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(input)).status, 200);
  const finished = { ...input, assistantText: '已返回计划。' };
  assert.equal((await post(finished)).status, 200);
  assert.equal((await (await post(finished)).json()).data.receipt.deduplicated, true);
  assert.equal((await post({ ...finished, userText: '不同原请求' })).status, 400);
  const history = await (await fetch(base + '/api/roles/One/chat-history')).json();
  assert.deepEqual(history.data.entries.map((entry: { kind: string }) => entry.kind), ['aiui_assistant', 'aiui_user']);
  assert.equal(desktopReads, 0);
  assert.equal((await (await fetch(base + '/api/roles/Two/chat-history')).json()).data.entries.length, 0);
  assert.equal((await post({ ...finished, roleId: 'Two' })).status, 400);
  // Read-only route stays read-only; explicit ingestion never dispatches an Agent turn.
  assert.equal((await fetch(base + '/api/roles/One/chat-history', { method: 'POST' })).status, 405);
});
