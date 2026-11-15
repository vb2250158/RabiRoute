import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentAdapterProvider } from '@rabiroute/plugin-sdk';
import { createOwnedServiceAgentSender } from './ownedServiceAgentSender.js';

test('native sender binds the published provider reference, injects its current session and preserves the original receipt', async () => {
  let sessionId='current',accepting=true,retired=false,calls=0,endpointPatch:Record<string,unknown>={};
  const original={statusCode:202,data:{deliveryId:'owned-call',status:'accepted',originalReceipt:'keep'}};
  const provider={type:'voice-assistant',identity:{managerInstanceId:'http-manager-identity'},inspect:()=>({accepting}),runAcceptedWork:async(operation:()=>unknown)=>operation(),
    async invoke(name:string,_payload:unknown,invocation?:{nativeArgs?:unknown[]}) {
      if(name==='binding.read')return {sessionId};
      assert.equal(name,'service.resolveTarget');assert.deepEqual(invocation?.nativeArgs,[{agentAdapter:'voice-assistant',threadId:sessionId}]);
      return {endpoint:{kind:'service',provider:'voice-assistant',managerInstanceId:'manager',agentId:'native-owner',sessionId,authorizationIncarnation:'activation',...endpointPatch},threadName:'Voice session'};
    }} as unknown as AgentAdapterProvider;
  let providers=[provider];
  const port=createOwnedServiceAgentSender({providers:()=>providers,deliveryAuthorityId:()=>'manager',assertCurrent(){if(retired)throw Error('host retired')},async dispatch(request,source,guard){guard();calls++;
    assert.equal(request.sourceThreadId,sessionId);assert.equal(request.messageSource?.type,'agent');assert.equal(source.authorizationIncarnation,'activation');assert.equal(source.agentId,'native-owner');return original;
  }});
  const send=port.bind(provider),request={action:'send' as const,agentAdapter:'voice-assistant',threadId:'target',prompt:'hello',deliveryId:'owned-call'};
  assert.equal(await send(request,'current'),original);
  await assert.rejects(port.bind({...provider})(request,'current'),/OWNER_RETIRED/);
  await assert.rejects(send({...request,messageSource:{type:'agent',agentAdapter:'codex',sessionId:'fake',sessionName:'forged'}},'current'),/NOT_CALLER_SETTABLE/);
  for(const patch of [{agentId:undefined},{authorizationIncarnation:''},{managerInstanceId:'different-manager'}]){endpointPatch=patch;await assert.rejects(send(request,'current'),/ENDPOINT_INVALID/)}endpointPatch={};
  sessionId='new-context';await assert.rejects(send(request,'current'),/CONTEXT_CHANGED/);
  accepting=false;await assert.rejects(send(request,sessionId),/OWNER_RETIRED/);accepting=true;
  providers=[];await assert.rejects(send(request,sessionId),/OWNER_RETIRED/);providers=[provider];
  retired=true;await assert.rejects(send(request,sessionId),/host retired/);assert.equal(calls,1);
});
