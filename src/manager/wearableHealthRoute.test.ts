import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaHealthOperations } from './personaHealthOperations.js';
import { compileApiOperation,apiPathParameters } from './apiOperationContract.js';

test('exact health contracts preserve both prefixes, encoded role IDs and the summary compatibility path',()=>{
  const operations=createPersonaHealthOperations({roleDirectory:()=>'.',lifecycleFence:null,managerPort:0,deliverAlert:async()=>[]});
  assert.equal(operations.length,14);
  const state=compileApiOperation(operations.find(item=>item.contract.operationId==='manager.personas.health.state')!);
  assert.deepEqual({...apiPathParameters(state,'/api/roles/Example/health/state')},{roleId:'Example'});
  const history=compileApiOperation(operations.find(item=>item.contract.operationId==='manager.personas.health.history.alias')!);
  assert.deepEqual({...apiPathParameters(history,'/roles/Example%20Active/health/history')},{roleId:'Example Active'});
  assert.equal(apiPathParameters(state,'/api/roles/Example/plans'),undefined);
  assert.equal(operations.find(item=>item.contract.pathTemplate==='/api/roles/:roleId/health')!.contract.operationId,'manager.personas.health.summary.compat');
});
