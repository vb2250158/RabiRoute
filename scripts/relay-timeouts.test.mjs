import test from 'node:test';
import assert from 'node:assert/strict';
import { relayTimeout,clientTimeout } from './lib/relay-timeouts.mjs';
import { RelayProxyRequestQueue } from './rabilink-proxy-request-queue.mjs';
test('Relay startup snapshot and client request budgets stay separate',()=>{
 const old=process.env.RABIROUTE_TIMEOUT_OVERRIDES;
 try { process.env.RABIROUTE_TIMEOUT_OVERRIDES=JSON.stringify({'relay.webguiWait':91000});
 assert.equal(relayTimeout('webguiWait',30000),91000);
 assert.equal(clientTimeout({headers:{'x-rabi-timeout-ms':'125000'}},30000),125000);
 assert.equal(clientTimeout({headers:{'x-rabi-timeout-ms':'bad'}},30000),30000);
 const queue=new RelayProxyRequestQueue({name:'Test',idPrefix:'test',requestWaitMs:30000,leaseMs:1000,retentionMs:1000});
 const first=queue.create({timeoutMs:125000});const second=queue.create({});
 assert.equal(first.expiresAt-first.createdAt,125000);assert.equal(second.expiresAt-second.createdAt,30000);
 } finally { if(old===undefined)delete process.env.RABIROUTE_TIMEOUT_OVERRIDES;else process.env.RABIROUTE_TIMEOUT_OVERRIDES=old; }
});
