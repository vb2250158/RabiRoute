import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureApiContract } from './apiOperationContractFixtures.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard } from './lanAgentBodyAuthority.js';
import type { ApiOperationResult } from './apiOperationContract.js';

for (const phase of ['prepare-not-started', 'handler-not-started', 'handler-unknown', 'no-owner-evidence', 'invalid-owner-evidence', 'normal-result'] as const) {
  test('authority failure preserves only trusted mutation evidence: ' + phase, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mutation-evidence-'));
    const authority = new LanAgentAuthority({ statePath: path.join(root, 'authority.json') });
    const credential = authority.enroll(authority.issueBootstrapTicket().ticket, 'evidence-node');
    const registry = new ManagerPluginRouteRegistry();
    const revoke = () => authority.revokeNode(credential.nodeId);
    let executions = 0;
    const registration = registry.registerOperations('evidence', [{ contract: fixtureApiContract(), prepare: () => {
      if (phase !== 'prepare-not-started') return input => {
        executions++;
        if (phase !== 'normal-result') revoke();
        return { status: 200, body: { ok: true, value: 7 },
          ...(phase === 'no-owner-evidence' ? {} : { mutationOutcome: phase === 'handler-unknown' ? 'unknown' : phase === 'invalid-owner-evidence' ? 'forged-stage' : 'not_started' }) } as ApiOperationResult;
      };
      revoke(); return { status: 403, body: { privateReceipt: 'MUST_NOT_DISCLOSE' }, mutationOutcome: 'not_started' };
    }, handler: () => { throw new Error('Request-bound handler required'); } }]);
    const server = http.createServer((request, response) => {
      if (evaluateLanAgentRequest(request, authority, true).kind !== 'agent') { response.writeHead(401).end(); return; }
      markAuthenticatedConnectionRequest(request);
      registerLanAgentBodyGuard(request, () => {});
      if (!registry.handle(request, new URL(request.url!, 'http://fixture'), response)) response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: (server.address() as import('node:net').AddressInfo).port, method: 'POST', path: '/api/example/records/one',
        headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json', 'x-client-mutation-outcome': 'not_started' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on('error', reject); request.end(JSON.stringify({ value: 1 }));
    });
    if (phase === 'normal-result') { assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true, value: 7 }); return; }
    assert.equal(result.status, phase === 'invalid-owner-evidence' ? 500 : 403);
    assert.equal(executions, phase === 'prepare-not-started' ? 0 : 1);
    assert.equal(result.body.errorCode, phase === 'invalid-owner-evidence' ? 'API_OPERATION_OUTCOME_INVALID' : 'API_REQUEST_AUTHORITY_REVOKED');
    assert.equal(Object.hasOwn(result.body, 'privateReceipt'), false); assert.equal(Object.hasOwn(result.body, 'value'), false); assert.equal(Object.hasOwn(result.body, 'data'), false);
    if (phase === 'prepare-not-started' || phase === 'handler-not-started') { assert.equal(result.body.mutationOutcome, 'not_started'); assert.equal(result.body.uncertain, false); }
    else { assert.equal(result.body.uncertain, true); assert.equal(result.body.mutationOutcome, phase === 'handler-unknown' ? 'unknown' : undefined); }
  });
}

for (const action of ["status", "execute"] as const) test(`mixed operation ${action} failure describes the selected request effect`, async t => {
  const original = fixtureApiContract();
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("mixed-effect", [{ contract: { ...original,
    request: { ...original.request, body: {kind:"json", maxBytes:4096, schema:{type:"object",required:["action"],properties:{action:{enum:["status","execute"]}},additionalProperties:false}} },
    effects: {mode:"write",description:"Request effect belongs to its declared action.",request:{bodyPath:["action"],modes:{status:"read",execute:"write"}}} },
    handler: () => { throw new Error("fixture interrupted"); } }]);
  const server = http.createServer((request,response)=>{markAuthenticatedConnectionRequest(request);if(!registry.handle(request,new URL(request.url!,"http://fixture"),response))response.writeHead(404).end();});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await registration.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const response=await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/example/records/one`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action})});
  const data=await response.json() as {uncertain?:boolean;repair:string};
  assert.equal(response.status,500);assert.equal(data.uncertain===true,action==="execute");
  if(action==="status")assert.doesNotMatch(data.repair,/Inspect the original operation receipt/);
});
