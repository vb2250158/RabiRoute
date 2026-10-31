import assert from 'node:assert/strict';
import test from 'node:test';
import { apiRequestTimingPolicy, apiRequestDiagnosticPath, validateApiRequest } from './request.mjs';

const path = '/api/roles/synthetic/message-endpoint-history';
test('history timing is one attempt within the caller remaining budget', () => {
  assert.deepEqual(apiRequestTimingPolicy({ path }), { budgetMs: 3000, budgetParameterValid: true, maxAttempts: 1, pathTemplate: '/api/roles/:roleId/message-endpoint-history' });
  for (const [query, expected] of [['budgetMs=1', 1], ['budgetMs=73', 73], ['%62udgetMs=125', 125], ['budgetMs=100&budgetMs=200', 100]]) {
    assert.equal(apiRequestTimingPolicy({ path: path + '?' + query }).budgetMs, expected);
  }
});
test('invalid budget values cannot lengthen transport or replace Manager validation', () => {
  for (const value of ['0', '-1', '2147483648', '1.5', '', 'Infinity', 'NaN', '%203', '03']) {
    const policy = apiRequestTimingPolicy({ path: path + '?budgetMs=' + value });
    assert.equal(policy.budgetMs, 3000); assert.equal(policy.budgetParameterValid, false);
  }
});
test('other APIs and mutation behavior keep their transport defaults', () => {
  for (const request of [{ path: '/api/roles/synthetic/plans?budgetMs=1' }, { method: 'POST', path }, { path: '//api/roles/synthetic/message-endpoint-history' }, { path: path + '/extra' }]) {
    assert.equal(apiRequestTimingPolicy(request), undefined);
  }
});
test('history diagnostics omit role and query data while wire parameters remain intact', () => {
  const input = { method: 'GET', path: path + '?query=synthetic-private-query&sender=synthetic-person&budgetMs=700', headers: { accept: 'application/json' } };
  const validated = validateApiRequest(input);
  assert.equal(validated.path, input.path);
  assert.equal(validated.mutation, false);
  assert.equal(apiRequestDiagnosticPath(validated), '/api/roles/:roleId/message-endpoint-history');
  assert.equal(apiRequestDiagnosticPath({ path: '/api/health' }), '/api/health');
});

test("configured and caller budgets preserve single-attempt history semantics",()=>{ const path="/api/roles/example/message-endpoint-history"; assert.equal(apiRequestTimingPolicy({path},{defaultBudgetMs:91000}).budgetMs,91000); assert.equal(apiRequestTimingPolicy({path:path+"?budgetMs=120000"}).budgetMs,120000); assert.equal(apiRequestTimingPolicy({path}).maxAttempts,1); });
