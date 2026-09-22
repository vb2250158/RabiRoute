import assert from 'node:assert/strict';
import test from 'node:test';
import { paginateRolePlans } from './roleKnowledgePagination.js';
import { parseWorkspacePlanQuery, planWorkspaceIdentity } from './planWorkspaceQuery.js';
const presentation = { status: 'active', label: 'Active', labelEn: 'Active', description: '', descriptionEn: '', tone: 'active', statusLevel: 0, views: ['current'], roles: [], palette: { accent: '#00a', background: '#fff', foreground: '#000' }, importance: { level: 1 }, urgency: { level: 1 }, approval: { state: 'none' as const } };
const binding = { agentType: 'dsh', workspace: 'C:\\Project\\Game', sessionId: 'a' };
const item = (id: string) => ({ id, title: 'Needle ' + id, currentStep: 'test', status: 'active', updatedAt: '2026-01-01', keywords: ['keyword'], presentation, taskBinding: binding });
test('workspace and real session scope apply before totals, facets and pagination', () => {
  const plans = [item('one'), { ...item('wrong-agent'), taskBinding: { ...binding, agentType: 'codex' } }, { ...item('wrong-workspace'), taskBinding: { ...binding, workspace: 'C:/Project/Other' } }, { ...item('missing-session'), taskBinding: { ...binding, sessionId: 'deleted' } }, { ...item('two'), secretaryBinding: binding }];
  const filter = { bindingScope: { agentType: 'dsh', workspace: 'c:/project/game/', sessionIds: ['a'] }, query: 'keyword' };
  const page = paginateRolePlans(plans, '', 1, filter);
  assert.equal(page.total, 2); assert.equal(page.counts.total, 2); assert.equal(page.facets.statuses[0].count, 2);
  assert.deepEqual(page.items.map(x => x.id), ['one']);
  assert.deepEqual(paginateRolePlans(plans, page.nextCursor, 1, filter).items.map(x => x.id), ['two']);
  assert.equal(paginateRolePlans(plans, '', 20, { ...filter, bindingScope: { ...filter.bindingScope, sessionIds: [] } }).total, 0);
  const scoped = plans.filter(x => ['one', 'two'].includes(x.id));
  assert.deepEqual(paginateRolePlans(plans, '', 20, filter), paginateRolePlans(scoped, '', 20, { query: 'keyword' }));
});
test('rejects malformed scope and keeps Windows versus POSIX workspace semantics', () => {
  assert.throws(() => parseWorkspacePlanQuery({}));
  assert.throws(() => parseWorkspacePlanQuery({ bindingScope: { ...binding, sessionIds: ['a', 1] } }));
  assert.throws(() => parseWorkspacePlanQuery({ bindingScope: { ...binding, sessionIds: ['a'] }, sort: 'unknown' }));
  assert.equal(planWorkspaceIdentity('\\\\?\\C:\\Project\\Game\\'), 'c:/project/game');
  assert.notEqual(planWorkspaceIdentity('/Project/Game'), planWorkspaceIdentity('/project/game'));
});
test('workspace identity is idempotent including Windows drive roots', () => {
  for (const value of ['C:/', 'C:/work/..', '//?/C:/', 'C:/work/', '//server/share/', '/', '/work/']) {
    const canonical = planWorkspaceIdentity(value);
    assert.ok(canonical, value);
    assert.equal(planWorkspaceIdentity(canonical), canonical, value);
  }
  assert.equal(planWorkspaceIdentity('C:/'), 'c:/');
  assert.equal(planWorkspaceIdentity('C:'), '');
});
test('100000 plans produce a bounded scoped summary page without a full body response', () => {
  const plans = Array.from({ length: 100000 }, (_, i) => ({ ...item(String(i)), taskBinding: { ...binding, sessionId: i % 10 === 0 ? 'a' : 'other' } }));
  const start = performance.now();
  const page = paginateRolePlans(plans, '', 20, { bindingScope: { ...binding, sessionIds: ['a'] }, query: 'Needle' });
  assert.equal(page.total, 10000); assert.equal(page.items.length, 20);
  assert.ok(performance.now() - start < 5000);
});
