import { adoptTimeoutSettings, requestTimeout, configureTimeoutStorage } from "../utils/timeout-settings.js";
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintApiRequest, sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { createHash } from 'node:crypto';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
const source = await fs.readFile(new URL('../utils/rabilink-api.js', import.meta.url), 'utf8');
const phoneSource=await fs.readFile(new URL('../utils/phone-eye-transport.js',import.meta.url),'utf8');
const storeSource=await fs.readFile(new URL('../utils/rabilink-store.js',import.meta.url),'utf8');
function fixture() {
  const requests = [], storage = new Map(); let outcome = { code: 0, data: {} }, uncertain = false;
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,structuredClone(value)), request(input) {
    requests.push(structuredClone({ ...input, success: undefined, fail: undefined }));
    if(input.url.endsWith('/devices/connections')) input.success({ statusCode: 200, data: { code: 0, data: { devices: [{ id: 'fixture-glasses', connectionTargetDeviceId: 'pc-owner' }] } } });
    else if(input.url.endsWith('/mobile/state')) input.success({ statusCode: 200, data: { code: 0, connectionOwnerDeviceId: 'pc-owner', selectedTargetDeviceId: 'pc-owner', workers: [{ id: 'pc-owner', guid: 'guid-owner' }] } });
    else input.success({ statusCode: 200, data: { code: 0, data: { structuredContent: { ok: !uncertain, uncertain, statusCode: uncertain ? 504 : 200, headers: { etag: 'fixture-etag' }, data: outcome } } } });
  } };
  const names = [...source.matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
  const context=vm.createContext({adoptTimeoutSettings,requestTimeout,configureTimeoutStorage,wx,URL,URLSearchParams,Date,Math,fingerprintApiRequest});
  context.tokenStorageKey=vm.runInContext('(()=>{'+storeSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';return tokenStorageKey})()',context);
  const phone=vm.runInContext('(()=>{'+phoneSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';return {phoneEyeHttpRequest,pairPhoneEyeTransport,phoneEyeTransportStatus}})()',context);
  context.phoneEyeHttpRequest=phone.phoneEyeHttpRequest;
  const api = vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replaceAll('export ', '') + '\n({' + names.join(',') + ',AIUI_HTTP_TRANSPORT_CAPABILITIES})', context);
  return { api, requests, storage, result(value) { outcome = value; }, uncertain(value) { uncertain = value; }, config: { relayBaseUrl: 'https://relay.invalid', token: 'synthetic', targetDeviceId: 'pc-owner' } };
}
test('future APIs and profile operations share one transport without Relay persona metadata', async () => {
  const f=fixture(); f.result({ code: 0, data: { profile: null, savedRevision: 0 } });
  await f.api.getDeviceAgentProfile(f.config);
  assert.equal(f.requests.at(-1).data.request.path,'/api/rabilink/agent-devices/self/profile');
  assert.equal(f.requests.at(-1).data.targetDeviceId,'pc-owner');
  await f.api.getMobileWebgui(f.config,'/api/new-after-client-release?option=1','pc-other');
  const request=f.requests.at(-1); assert.equal(request.url,'https://relay.invalid/api/rabilink/device/api');
  assert.equal(request.data.targetDeviceId,'pc-other'); assert.equal(request.data.request.path,'/api/new-after-client-release?option=1');
  assert.ok(!Object.hasOwn(request.data,'profileRevision'));
  assert.deepEqual(JSON.parse(JSON.stringify(f.api.AIUI_HTTP_TRANSPORT_CAPABILITIES)),{transport:'relay',bufferedHttp:true,lan:false,p2p:false,streaming:false,websocket:false});
});

test('authenticated profile timeout applies to the same PC and restores defaults', async () => {
  const f = fixture();
  f.result({ code: 0, data: { profile: null, timeoutOverrides: { 'aiui.http.request': 91000 } } });
  await f.api.getDeviceAgentProfile(f.config);
  f.result({ code: 0, data: {} });
  await f.api.getMobileWebgui(f.config, '/api/test', 'pc-owner');
  assert.equal(f.requests.at(-1).timeout, 91000);
  assert.equal(f.requests.at(-1).header['X-Rabi-Timeout-Ms'], '91000');
  await f.api.getMobileWebgui({...f.config,token:'other-account'}, '/api/test', 'pc-owner');
  assert.equal(f.requests.at(-1).timeout, 30000);
  await f.api.getMobileWebgui(f.config, '/api/test', 'pc-other');
  assert.equal(f.requests.at(-1).timeout, 30000);
  f.result({ code: 0, data: { profile: null, timeoutOverrides: {} } });
  await f.api.getDeviceAgentProfile(f.config);
  await f.api.getMobileWebgui(f.config, '/api/test', 'pc-owner');
  assert.equal(f.requests.at(-1).timeout, 30000);
});

test('transport success preserves business failure for the client to interpret',async()=>{
  const f=fixture();f.result({code:'DEVICE_AGENT_OWNER_ALREADY_LOADED',message:'original business conflict'});
  await assert.rejects(f.api.getMobileWebgui(f.config,'/api/device-agents/glasses/session'),error=>error.code==='DEVICE_AGENT_OWNER_ALREADY_LOADED' && error.response.message==='original business conflict');
  f.result({ok:false,message:'business not ready'});await assert.rejects(f.api.getMobileWebgui(f.config,'/api/future'),/business not ready/);
});
test('route convenience methods resolve PC identity at the client and retain write fences', async () => {
  const f=fixture(), hash='a'.repeat(64); f.result({ code: 0, receipt: { state: 'committed', operationId: 'original-op', contentHash: hash } });
  await f.api.setMobileAgentBinding(f.config,'route/one',{ adapter: 'dsh' },{operationId:'original-op',expectedContentHash:hash},'pc-owner');
  const packet=f.requests.at(-1).data; assert.equal(packet.request.path,'/api/rabi/instances/guid-owner/routes/route%2Fone/agent-binding');
  assert.equal(packet.request.headers['If-Match'],hash); assert.equal(packet.request.operationId,'original-op');
});
test('battery status uses the connection owner PC even when persona tools select another PC', async () => {
  const f=fixture(); f.result({code:0,deviceStatus:{batteryLevel:42,source:'cxr-l',receivedAt:new Date().toISOString()}});
  const status=await f.api.getMobileDeviceStatus({...f.config,targetDeviceId:'pc-persona'});
  assert.equal(status.deviceStatus.batteryLevel,42);
  assert.equal(f.requests.at(-1).data.targetDeviceId,'pc-owner');
  assert.equal(f.requests.at(-1).data.request.path,'/api/rabilink/mobile/device-status');
});
test('conversation retains old persona PC and validates the actual history receipt', async () => {
  const f=fixture(); f.result({ code: 0, data: { receipt: { state: 'committed', turnId: 'turn-one', recordIds: ['real-receipt'] } } });
  const receipt=await f.api.recordAiuiConversation(f.config,{ personaRef:{roleId:'Old',sourceDeviceId:'pc-old'},profileRevision:2,sessionId:'session',turnId:'turn-one',userText:'用户',assistantText:'回复' });
  const packet=f.requests.at(-1).data; assert.equal(packet.targetDeviceId,'pc-old'); assert.equal(packet.request.path,'/api/roles/Old/chat-history/aiui');
  assert.ok(!Object.hasOwn(packet.request.body,'personaRef')); assert.ok(!Object.hasOwn(packet.request.body,'profileRevision')); assert.equal(receipt.sourceDeviceId,'pc-old');
});
test('unknown generic UI write retains its original intent and never retries', async () => {
  const f=fixture(); f.uncertain(true);
  await assert.rejects(f.api.postMobileWebgui(f.config,'/api/future/write',{value:1}),/MANAGER_REQUEST_UNCONFIRMED/);
  assert.equal(f.requests.length,1); const rows=f.storage.get('rabilink-aiui-http-operations-v1').rows;
  assert.equal(rows.length,1); assert.equal(rows[0].operationId,f.requests[0].data.request.operationId);
});
test('request digests match SHA-256 and never retain raw confidential bodies', () => {
  for(const text of ['', 'abc', '中文😀', 'x'.repeat(262145)]) assert.equal(sha256Text(text),createHash('sha256').update(text).digest('hex'));
});
test('one operation cannot be replayed on another PC, including restored durable rows', async () => {
  let rows=[], calls=0;
  const dependencies={defaultTargetDeviceId:'pc-one',sessionId:'fixture',storage:{load:()=>rows,save:value=>{rows=structuredClone(value);}},call:async request=>{calls++;return {structuredContent:{ok:true,data:{target:request.targetDeviceId}}};}};
  const runtime=createApiToolRuntime(dependencies);
  const event={callId:'one',functionName:'rabi_api_call',isComplete:true,arguments:{method:'PUT',path:'/api/future',operationId:'original',body:{secret:'synthetic-private-value'}}};
  await runtime.handleToolCall(event); assert.equal(calls,1);
  assert.ok(!JSON.stringify(rows).includes('synthetic-private-value'));
  await assert.rejects(runtime.handleToolCall({...event,callId:'two',arguments:{...event.arguments,targetDeviceId:'pc-two'}}),/TOOL_OPERATION_TARGET_CONFLICT/);
  const restored=createApiToolRuntime(dependencies);
  await assert.rejects(restored.handleToolCall({...event,callId:'three',arguments:{...event.arguments,targetDeviceId:'pc-two'}}),/TOOL_OPERATION_TARGET_CONFLICT/);
  await restored.handleToolCall({...event,callId:'four',arguments:{...event.arguments,targetDeviceId:'pc-one'}}); assert.equal(calls,1);
});
