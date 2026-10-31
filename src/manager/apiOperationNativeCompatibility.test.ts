import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureApiContract } from './apiOperationContractFixtures.js';
import { compileApiContract, apiPathParameters, type ApiOperationContract } from './apiOperationContract.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { apiCatalogOpenApi } from './apiOperationCatalog.js';

const base = fixtureApiContract();
const flexible: ApiOperationContract = { ...base, request: { ...base.request, pathCaseInsensitiveLiterals: ['records'] } };
test('only declared literal segments fold case and captured object identity stays exact', () => {
  const compiled = compileApiContract({ contract: flexible });
  assert.deepEqual({ ...apiPathParameters(compiled, '/api/example/ReCoRdS/MiXeD') }, { recordId: 'MiXeD' });
  assert.equal(apiPathParameters(compiled, '/API/example/records/MiXeD'), undefined);
  assert.equal(apiPathParameters(compiled, '/api/EXAMPLE/records/MiXeD'), undefined);
  assert.equal(apiPathParameters(compileApiContract({ contract: base }), '/api/example/ReCoRdS/mixed'), undefined);
  for (const values of [['missing'], ['records', 'records'], ['../records']]) assert.throws(() => compileApiContract({ contract: { ...base, request: { ...base.request, pathCaseInsensitiveLiterals: values } } }));
});
test('case-aware route equivalence and raw-tail overlap reject ambiguous publication', async () => {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('original', [{ contract: flexible, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  try {
    assert.throws(() => registry.registerOperations('duplicate', [{ contract: { ...base, operationId: 'example.duplicate', pathTemplate: '/api/example/ReCoRdS/:another' }, handler: () => ({ status: 200 }) }]), /overlap/);
    const tailRegistry = new ManagerPluginRouteRegistry();
    const tail = tailRegistry.registerOperations('tail', [{ contract: { ...flexible, operationId: 'example.tail', pathTemplate: '/api/example/records/:recordId', request: { ...flexible.request, pathRemainder: 'recordId' } }, handler: () => ({ status: 200 }) }]);
    try { assert.throws(() => tailRegistry.registerOperations('fixed', [{ contract: { ...base, operationId: 'example.fixed', pathTemplate: '/api/example/RECORDS/fixed' }, handler: () => ({ status: 200 }) }]), /overlap/); }
    finally { await tail.dispose(); }
  } finally { await registration.dispose(); }
});
test('OpenAPI publishes ignored-body and literal matching policies from the same executable definition', async () => {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('native', [{ contract: { ...flexible, request: { ...flexible.request, body: { kind: 'none', allowIgnoredBody: true } } }, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  try {
    const openapi = (await apiCatalogOpenApi(registry.catalogSnapshot())) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const operation = openapi.paths['/api/example/records/{recordId}'].post;
    assert.equal(operation['x-rabiroute-ignored-request-body'], true);
    assert.deepEqual(operation['x-rabiroute-case-insensitive-path-literals'], ['records']); assert.equal(operation.requestBody, undefined);
    assert.throws(() => compileApiContract({ contract: { ...base, request: { ...base.request, body: { kind: 'none', allowIgnoredBody: 'yes' } as unknown as ApiOperationContract['request']['body'] } } }));
  } finally { await registration.dispose(); }
});
