import {definePlugin,ownAgentAdapter} from "@rabiroute/plugin-sdk";
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createImplementation,hostModules} from './manager-runtime.mjs';
export const activate=definePlugin({async activate(context){
  const host=context.services.require('host.agent-adapters@1');await host.prepareModules(hostModules);
  const api=context.services.require('host.manager.operations@1');
  const speech=context.services.require('manager.speech@1');
  const managerPort=context.services.require('host.manager.voice-assistant@2');
  const managerEndpoint=managerPort.endpoint;let agentSender;
  const implementation=createImplementation(host);
  const owner=await implementation.createVoiceAssistantOwner({identity:context.identity,stateRoot:host.environment.RABIROUTE_STATE_ROOT,speech,managerEndpoint,signal:context.lifecycle.signal,readOnly:host.manager.readOnly,
    publish:host.manager.publishManagerEvent,publishDesktopPresentation:managerPort.publishDesktopPresentation,
    sendAgent:(request,sessionId)=>{if(!agentSender)throw Error('AGENT_SOURCE_OWNER_NOT_READY');return agentSender(request,sessionId)},runtimeEntry:fileURLToPath(new URL('./native-device/main.cjs',import.meta.url)),
    recognitionSampleUrl:new URL('./diagnostic-assets/recognition-zh-CN.wav',import.meta.url)});
  context.effects.adopt(()=>owner.dispose(),'dispose owned voice assistant audio/model client');
  const assertCurrent=()=>context.lifecycle.signal.throwIfAborted();
  const descriptor=JSON.parse(await readFile(new URL('./agent-adapter.json',import.meta.url),'utf8'));
  owner.agent=implementation.createVoiceAssistantAgent(owner,context.identity,assertCurrent,managerPort.deliveryAuthorityId());
  const provider=ownAgentAdapter(context,{...descriptor,...owner.agent,dispose:()=>owner.dispose()});
  agentSender=managerPort.bindAgentSender(provider);
  context.services.provide('manager.voice-assistant@1',Object.freeze({instanceId:context.identity.instanceId,state:owner.state,command:owner.command}));
  context.contributions.register({kind:'page',id:'voice-assistant-page',value:{surface:'web.pages',label:{fallback:'语音助手'},routeId:'global.voice-assistant',rendererId:'builtin.web-page.voice-assistant.v1',slot:'route',hosts:['web'],order:51}});
  context.contributions.register({kind:'navigation',id:'voice-assistant',value:{surface:'web.navigation',label:{fallback:'语音助手'},routeId:'global.voice-assistant',icon:'mdi-microphone-message',slot:'utility',hosts:['web'],order:51}});
  context.effects.add(async()=>{const registration=await api.registerOperationsAsync(implementation.createVoiceAssistantOperations(owner,operation=>provider.runAcceptedWork(operation),context.identity),context.lifecycle.signal);return()=>registration.dispose()},'register voice assistant operations');
  context.publication.add({
    publish(){}, rollback(){},
    async afterPublish({previousRetirement,signal}){
      await previousRetirement;
      signal.throwIfAborted();
      owner.startWake();
    }
  },'restore voice assistant capture after publication');
}}).activate;
