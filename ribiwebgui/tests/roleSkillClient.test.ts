import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoleSkillBrowser, roleSkillPath, type RoleSkillState } from '../src/roleSkillClient.ts';
const state = (): RoleSkillState => ({ roleId: '', items: [], detail: null, loading: false, detailLoading: false, error: false, detailError: false });
const skill = (id = 'one') => ({ id, title: '<script>unsafe</script>', summary: 'summary', keywords: [], status: 'active', updatedAt: '', content: '<b>plain text</b>' });
const response = (data: unknown) => Response.json({ code: 0, data });
test('paths encode both resource parameters', () => {
  assert.equal(roleSkillPath('a/b', 'c ?'), '/api/roles/a%2Fb/skills/c%20%3F');
  assert.throws(() => roleSkillPath(''));
});
test('loading, empty, failure, detail identity and plain text data', async () => {
  const s = state(); let reply = response([]);
  const browser = createRoleSkillBrowser(s, (async () => reply) as typeof fetch);
  const pending = browser.load('role'); assert.equal(s.loading, true); await pending;
  assert.equal(s.loading, false); assert.deepEqual(s.items, []); assert.equal(s.error, false);
  reply = new Response('', { status: 403 }); await browser.load('role'); assert.equal(s.error, true);
  reply = response([skill()]); await browser.load('role'); assert.equal(s.items[0].title, '<script>unsafe</script>');
  reply = response(skill()); await browser.select('one'); assert.equal(s.detail?.content, '<b>plain text</b>');
  reply = response(skill('wrong')); await browser.select('one'); assert.equal(s.detailError, true); assert.equal(s.detail, null);
});
test('role changes discard stale list and detail even when transport ignores abort', async () => {
  const s = state(); const calls: Array<{ resolve: (value: Response) => void; signal: AbortSignal }> = [];
  const browser = createRoleSkillBrowser(s, ((_url, init) => new Promise(resolve => calls.push({ resolve, signal: init?.signal as AbortSignal }))) as typeof fetch);
  const first = browser.load('old'); const second = browser.load('new');
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve(response([skill('new')])); await second;
  calls[0].resolve(response([skill('old')])); await first;
  assert.equal(s.items[0].id, 'new');
  const detail = browser.select('new'); const third = browser.load('third');
  calls[3].resolve(response([])); await third;
  calls[2].resolve(response(skill('new'))); await detail;
  assert.equal(s.detail, null); assert.equal(s.detailLoading, false); assert.equal(s.roleId, 'third');
});
test('dispose aborts outstanding work and prevents stale error state', async () => {
  const s = state(); let reject!: (e: Error) => void;
  const browser = createRoleSkillBrowser(s, (() => new Promise((_resolve, fail) => { reject = fail; })) as typeof fetch);
  const pending = browser.load('role'); browser.dispose(); reject(new Error('old error')); await pending;
  assert.equal(s.error, false);
});
