import {hostSpeechDefaultModel,hostSpeechExpressionPolicy,hostSpeechCommand,hostSpeechModelSummary} from './host-speech.mjs';
import {mkdir,readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openAssistantRuntime} from '../../../../apps/desktop-assistant/src/runtime.mjs';
import {openSettingsStore} from '../../../../apps/desktop-assistant/src/settings-store.mjs';
import {createHostEndpointSession} from '../../../../apps/rabi-agent/lib/host-endpoint.mjs';
import {createManagerClient} from '../../../../apps/rabi-agent/lib/manager-client.mjs';
import {createSpeechProviders} from '@rabilink/desktop-voice-service/speech-providers';
import {listProviderModels} from '@rabilink/desktop-voice-service/model-providers';
import {openDesktopDevice} from '@rabilink/desktop-voice-service/node';
import {createRabiOperationTools} from './operation-tools.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const payload=result=>{if(!result.ok)throw Object.assign(Error(result.data?.message||'RABI_OPERATION_FAILED'),{receipt:result});return result.data?.data??result.data};
const validSource=value=>['host','custom'].includes(value);
export async function createVoiceAssistantOwner({identity,stateRoot,speech,publish,signal,hostOptions={},clientFactory,deviceFactory,runtimeEntry,recognitionSampleUrl,createModel,modelCatalog=listProviderModels,customProviderFactory=createSpeechProviders,managerEndpoint,sendAgent}){
  const directory=join(stateRoot,'data','voice-assistant');await mkdir(directory,{recursive:true});
  let profile={personaId:'',asrSource:'host',ttsSource:'host'},closed=false,runtime,opening,client,clientOpening,profileRevision=0,lastHostError=null;
  const profilePath=join(directory,'host-profile.json');
  try{profile={...profile,...JSON.parse(await readFile(profilePath,'utf8'))}}catch(error){if(error.code!=='ENOENT')throw Error('ASSISTANT_HOST_PROFILE_INVALID')}
  if(!validSource(profile.asrSource)||!validSource(profile.ttsSource))throw Error('ASSISTANT_HOST_PROFILE_INVALID');
  try{hostOptions={...JSON.parse(await readFile(join(directory,'host-options.json'),'utf8')),...hostOptions}}catch(error){if(error.code!=='ENOENT')throw Error('ASSISTANT_HOST_OPTIONS_INVALID')}
  const connectionDirectory=join(directory,'connection');await mkdir(connectionDirectory,{recursive:true});
  // Preserve the first installed connection profile; only conversation context is persona-scoped.
  for(const source of [join(directory,'sessions',hash('default'),'settings.json'),join(directory,'sessions',hash(profile.personaId||'default'),'settings.json')]){
    try{await copyFile(source,join(connectionDirectory,'settings.json'),1);break}catch(error){if(error.code==='EEXIST')break;if(error.code!=='ENOENT')throw error}
  }
  const assertCurrent=()=>{if(closed)throw Error('ASSISTANT_CLOSED');signal.throwIfAborted()};
  async function manager(){
    assertCurrent();if(client)return client;if(clientOpening)return clientOpening;
    clientOpening=(async()=>{
      const session=clientFactory?undefined:managerEndpoint?{async ensure(){
        const captured=managerEndpoint();
        if(captured.applicationGenerationId!==identity.applicationGenerationId||captured.managerInstanceId!==identity.managerInstanceId)throw Error('ASSISTANT_MANAGER_IDENTITY_CHANGED');
        const response=await fetch(new URL('/meta',captured.managerUrl),{signal,redirect:'error'});if(!response.ok)throw Error('ASSISTANT_MANAGER_UNAVAILABLE');
        const raw=await response.json(),meta=raw.code===0?raw.data:raw;assertCurrent();
        if(meta.applicationGenerationId!==captured.applicationGenerationId||meta.managerInstanceId!==captured.managerInstanceId)throw Error('ASSISTANT_MANAGER_IDENTITY_CHANGED');
        return {managerUrl:captured.managerUrl,meta};
      }}:createHostEndpointSession();
      if(session){const ensure=session.ensure;session.ensure=async options=>{const endpoint=await ensure(options);if(endpoint.meta.applicationGenerationId!==identity.applicationGenerationId||endpoint.meta.managerInstanceId!==identity.managerInstanceId)throw Error('ASSISTANT_MANAGER_IDENTITY_CHANGED');return endpoint}}
      const endpoint=await session?.ensure({diagnostic:true});
      if(endpoint&&(endpoint.meta.applicationGenerationId!==identity.applicationGenerationId||endpoint.meta.managerInstanceId!==identity.managerInstanceId))throw Error('ASSISTANT_MANAGER_IDENTITY_CHANGED');
      const next=clientFactory?await clientFactory():createManagerClient({managerUrl:endpoint.managerUrl,endpointSession:session,localHost:true});
      if(closed){await next.close();throw Error('ASSISTANT_CLOSED')}client=next;return next;
    })();try{return await clientOpening}finally{clientOpening=undefined}
  }
  const call=async(operation,input={})=>{
    try{return payload(await (await manager()).operations.call(operation,input,{signal}))}
    catch(error){const receipt=error.receipt,details=error.details||receipt?.bodyJson||error.receipt?.data||{};
      lastHostError={operationId:operation,statusCode:receipt?.statusCode,errorCode:details.errorCode||error.code||'RABI_OPERATION_FAILED',...(typeof details.repair==='string'?{repair:details.repair.slice(0,1200)}:{})};
      throw Object.assign(Error(operation.includes('personas.resources.reference')?'ASSISTANT_PERSONA_READ_FAILED':'ASSISTANT_HOST_OPERATION_FAILED'),{details:lastHostError});
    }
  };
  async function personas(){
    const rows=[],seen=new Set();let cursor;
    do{const result=await call('manager.roles.list',{query:{...(cursor?{cursor}:{}),limit:200}});rows.push(...(Array.isArray(result)?result:result.roles||result.personas||[]));cursor=result.nextCursor;if(cursor&&seen.has(cursor))throw Error('ASSISTANT_PERSONA_CATALOG_INVALID');seen.add(cursor)}while(cursor);
    return rows.filter(item=>!item.archivedAt).map(item=>({id:item.roleId||item.personaId||item.id,label:item.title||item.name||item.roleId||item.personaId||item.id})).filter(item=>item.id)
  }
  async function open(){
    assertCurrent();if(runtime)return runtime;if(opening)return opening;
    opening=(async()=>{
      const bound=structuredClone(profile),epoch=profileRevision;
      const role=bound.personaId?await call('manager.personas.resources.reference.read',{pathParams:{roleId:bound.personaId}}):undefined;
      const personaLabel=(await personas()).find(item=>item.id===bound.personaId)?.label||bound.personaId;
      const local=speech.speechControl.personas().find(item=>item.id===bound.personaId);
      let models=[],modelsError,serviceStatus;
      try{models=await speech.speechControl.models()}catch(error){modelsError='HOST_SPEECH_UNAVAILABLE'}
      try{serviceStatus=await speech.speechControl.status?.()}catch{ /* The catalog can still expose a selectable available service. */ }
      const asrModel=bound.asrModel||hostSpeechDefaultModel('asr',models,serviceStatus);
      const ttsModel=bound.ttsModel||hostSpeechDefaultModel('tts',models,serviceStatus,local?.defaultModel);
      const readyModel=id=>models.some(item=>item.id===id&&item.enabled&&item.available);
      const asrIssue=bound.asrSource!=='host'?null:modelsError?'无法连接本机识别服务':!asrModel?'未找到可用的本机识别模型':!readyModel(asrModel)?'所选本机识别模型不可用，请重新选择':null;
      const ttsIssue=bound.ttsSource!=='host'?null:modelsError?'无法连接本机播报服务':!local?.voiceReady?'请选择具备本机声线的人格，或使用自定义播报':!ttsModel?'未找到可用的本机播报模型':!readyModel(ttsModel)?'所选本机播报模型不可用，请重新选择':null;
      const ownDirectory=join(directory,'sessions',hash(bound.personaId||'default'));
      const settings=await openSettingsStore(connectionDirectory);
      if(!settings.read().llmModel){
        const available=await modelCatalog({kind:'llm',provider:'workbuddy-cli',endpoint:'codebuddy://cn',workbuddyCli:hostOptions.workbuddyCli}).catch(()=>[]);
        const selected=available.find(item=>item.id===hostOptions.llmModel)||available.find(item=>item.isDefault);
        await settings.save({llmProvider:'workbuddy-cli',llmEndpoint:'codebuddy://cn',...(selected?{llmModel:selected.id}:{})});
      }
      const overlay=value=>({...value,...(role?{persona:role.document,assistantName:personaLabel}:{}),...(hostOptions.electronExecutable&&!value.electronExecutable?{electronExecutable:hostOptions.electronExecutable}:{}),
        ...(bound.asrSource==='host'?{asrMode:'compatible',asrModel:asrModel||''}:{}),
        ...(bound.ttsSource==='host'?{ttsProvider:'compatible',ttsModel:ttsModel||'',ttsVoice:local?.voiceReady?bound.personaId:'',ttsSpeed:local?.speed||1}:{}),petId:bound.personaId});
      const providerFactory=options=>{
        const provider=customProviderFactory(options);
        if(bound.asrSource==='host'){
          delete provider.createAsr;provider.asrFeedback={mode:'utterance',label:'整句转录'};
          provider.recognize=async(audio,abort)=>{
            if(!asrModel)throw Error('HOST_ASR_MODEL_REQUIRED');abort.throwIfAborted();assertCurrent();
            const form=new FormData();form.set('file',new Blob([audio],{type:'audio/wav'}),'speech.wav');form.set('model',asrModel);
            const request=new Request('http://localhost/',{method:'POST',body:form});
            const result=await speech.speechControl.transcribe(request.headers.get('content-type'),Buffer.from(await request.arrayBuffer()),()=>{assertCurrent();abort.throwIfAborted()},abort);
            if(result.status<200||result.status>=300)throw Error('HOST_ASR_FAILED');return JSON.parse(Buffer.from(result.body).toString('utf8'));
          };
        }
        if(bound.ttsSource==='host'){
          delete provider.openSpeechStream;
          provider.synthesize=async(text,abort,expression,trace={})=>{
            if(!local?.voiceReady)throw Error('HOST_PERSONA_VOICE_REQUIRED');if(!ttsModel)throw Error('HOST_TTS_MODEL_REQUIRED');abort.throwIfAborted();assertCurrent();
            const command=hostSpeechCommand({model:models.find(item=>item.id===ttsModel)||{id:ttsModel},persona:local,text,expression,sessionId:runtime?.conversation.getSessionId()});
            const requestId=randomUUID(),notify=(stage,error)=>trace.onRequest?.({requestId,protocol:'rabi-host-speech',stage,parameters:command,...(error?{error}:{})});notify('sent');
            try{const result=await speech.speechControl.synthesize(command,()=>{assertCurrent();abort.throwIfAborted()},abort);
              if(result.status<200||result.status>=300)throw Error('HOST_TTS_FAILED');notify('accepted');return new Uint8Array(result.body);
            }catch(error){notify('failed','HOST_TTS_FAILED');throw error}
          };
        }
        return provider;
      };
      const seen=new Set(),petPending=new Set(),ownerStartedAt=Date.now();let presentationRevision=0;
      const record=value=>{const work=call('manager.desktop-pet.transcripts.append',{pathParams:{roleId:bound.personaId},body:{personaId:bound.personaId,...value}});petPending.add(work);void work.catch(()=>{}).finally(()=>petPending.delete(work))};
      const pet={state:()=>({available:Boolean(bound.personaId),pets:bound.personaId?[{id:bound.personaId,name:bound.personaId}]:[]}),
        present(config,presentation){if(!config.petEnabled||!bound.personaId)return;publish('voice_assistant_presentation',{personaId:bound.personaId,ownerId:identity.activationId,ownerStartedAt,revision:++presentationRevision,...presentation});
          const key=presentation.responseId+':'+presentation.playbackId;
          if(presentation.responseId&&presentation.speechStatus==='ended'&&!seen.has(key)){seen.add(key);record({voice:bound.personaId,kind:'tts',id:key,text:presentation.text,time:Date.now()})}},
        async dispose(){if(bound.personaId)publish('voice_assistant_presentation',{personaId:bound.personaId,ownerId:identity.activationId,ownerStartedAt,revision:++presentationRevision,clear:true});await Promise.allSettled([...petPending]);seen.clear()}};
      const next=await openAssistantRuntime({directory:ownDirectory,settingsDirectory:connectionDirectory,hostOptions,settingsOverlay:overlay,providerFactory,pet,createModel,recognitionSampleUrl,
        ...(bound.ttsSource==='host'?{expressionPolicy:config=>hostSpeechExpressionPolicy(models.find(item=>item.id===ttsModel),config)}:{}),
        credentialDescription:(value,kind)=>bound[kind+'Source']==='host'?{configured:true,writable:false,mode:'host-service'}:value,
        onSubmitted:(message,config)=>{if(config.petEnabled&&bound.personaId&&message.source==='speech')record({kind:'asr',source:'voice-assistant',id:message.id,text:message.text,time:Date.now()})},
        deviceFactory:deviceFactory||((options)=>openDesktopDevice({...options,runtimeEntry})),capabilities:{host:'rabi',modelConfiguration:true},
        discoverTools:async()=>{const connection=await manager();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED');return createRabiOperationTools({sdk:connection.operations,sendAgent:sendAgent?request=>sendAgent(request,runtime.conversation.getSessionId()):undefined,assertCurrent:()=>{assertCurrent();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED')}})} });
      if(closed||epoch!==profileRevision){await next.dispose();throw Error('ASSISTANT_CONTEXT_CHANGED')}
      runtime=next;runtime.hostSources={...bound,personaLabel,asrModel:asrModel||'',ttsModel:ttsModel||'',asrIssue,ttsIssue,voiceReady:Boolean(local?.voiceReady),models:models.map(hostSpeechModelSummary),modelsError,identitySource:role?'Rabi 人格正文全文；声线由宿主管理':'自定义人设'};
      return runtime;
    })();try{return await opening}finally{opening=undefined}
  }
  return {
    async state(){const current=await open(),state=await current.state();return {...state,hostSettings:{...current.hostSources,lastError:lastHostError,personas:await personas()},capabilities:{...state.capabilities,host:'rabi',tools:true,modelConfiguration:true}}},
    async messages(){return (await open()).messages()},
    async command(request){
      const current=await open();
      if(request.action==='start'&&(current.hostSources.asrIssue||current.hostSources.ttsIssue))throw Error(current.hostSources.asrIssue?'HOST_ASR_CONFIGURATION_REQUIRED':'HOST_TTS_CONFIGURATION_REQUIRED');
      if(request.action==='host-settings'){
        if(current.conversation.activity().pending)throw Error('ASSISTANT_CONTEXT_BUSY');
        const patch=request.patch||{};for(const key of Object.keys(patch))if(!['personaId','asrSource','ttsSource','asrModel','ttsModel'].includes(key)||typeof patch[key]!=='string')throw Error('ASSISTANT_HOST_PROFILE_INVALID');
        const next={...profile,...patch};if(!validSource(next.asrSource)||!validSource(next.ttsSource))throw Error('ASSISTANT_HOST_PROFILE_INVALID');
        if(next.personaId&&!(await personas()).some(item=>item.id===next.personaId))throw Error('ASSISTANT_PERSONA_UNAVAILABLE');
        await current.dispose();runtime=undefined;const old=profile;profile=next;profileRevision++;
        try{await open();const pending=profilePath+'.'+randomUUID()+'.tmp';await writeFile(pending,JSON.stringify(profile),{mode:0o600});await rename(pending,profilePath)}catch(error){profile=old;profileRevision++;throw error}lastHostError=null;return {saved:true,settingsScopeChanged:true};
      }
      if(request.action==='exit'){await current.host.command({action:'stop'});return {stopped:true}}
      return current.command(request);
    },
    async session(){const current=await open();return {id:current.conversation.getSessionId(),name:current.hostSources.personaLabel||profile.personaId||'语音助手',cwd:directory,updatedAt:current.conversation.contextState().savedAt||null}},
    async submit(text,requestId,expectedSession){const current=await open();if(expectedSession&&expectedSession!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');return current.conversation.submit(text,requestId)},
    async recover(requestId,text){return (await open()).conversation.acceptedRequest(requestId,text)},
    async dispose(){if(closed)return;closed=true;await opening?.catch(()=>{});await runtime?.dispose();await clientOpening?.catch(()=>{});await client?.close();runtime=undefined}
  };
}
