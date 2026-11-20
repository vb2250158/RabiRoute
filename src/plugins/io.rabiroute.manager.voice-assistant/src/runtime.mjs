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
import {createWakeListener} from './wake-listener.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const payload=result=>{if(!result.ok)throw Object.assign(Error(result.data?.message||'RABI_OPERATION_FAILED'),{receipt:result});return result.data?.data??result.data};
const validSource=value=>['host','custom'].includes(value);
const mobileRequestId=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const mobileObservationValidators=Object.freeze({
  emotion:value=>typeof value==='string'&&/^[a-z][a-z_-]{0,31}$/i.test(value),
  gender:value=>typeof value==='string'&&/^[a-z][a-z_-]{0,31}$/i.test(value),
  age:value=>Number.isFinite(value)&&value>=0,
  language:value=>typeof value==='string'&&/^[a-z]{2,8}(?:-[a-z0-9]{2,8}){0,3}$/i.test(value),
  confidence:value=>Number.isFinite(value),
});

function mobileAsrDetails(observation){
  if(observation===undefined)return undefined;
  if(!observation||typeof observation!=='object'||Array.isArray(observation))throw Error('ASSISTANT_SPEECH_OBSERVATION_INVALID');
  const entries=Object.entries(observation);
  for(const [key,value] of entries){
    if(!Object.hasOwn(mobileObservationValidators,key)||!mobileObservationValidators[key](value))throw Error('ASSISTANT_SPEECH_OBSERVATION_INVALID');
  }
  return entries.length?{kind:'asr',result:Object.fromEntries(entries)}:undefined;
}
export async function createVoiceAssistantOwner({identity,stateRoot,speech,publish,signal,hostOptions={},clientFactory,deviceFactory,runtimeEntry,recognitionSampleUrl,createModel,modelCatalog=listProviderModels,customProviderFactory=createSpeechProviders,managerEndpoint,sendAgent,readOnly=()=>false}){
  const directory=join(stateRoot,'data','voice-assistant');await mkdir(directory,{recursive:true});
  let profile={personaId:'',asrSource:'host',ttsSource:'host',wakeEnabled:false},closed=false,runtime,opening,client,clientOpening,profileRevision=0,lastHostError=null;
  const profilePath=join(directory,'host-profile.json');
  try{profile={...profile,...JSON.parse(await readFile(profilePath,'utf8'))}}catch(error){if(error.code!=='ENOENT')throw Error('ASSISTANT_HOST_PROFILE_INVALID')}
  if(!validSource(profile.asrSource)||!validSource(profile.ttsSource)||typeof profile.wakeEnabled!=='boolean')throw Error('ASSISTANT_HOST_PROFILE_INVALID');
  try{hostOptions={...JSON.parse(await readFile(join(directory,'host-options.json'),'utf8')),...hostOptions}}catch(error){if(error.code!=='ENOENT')throw Error('ASSISTANT_HOST_OPTIONS_INVALID')}
  const connectionDirectory=join(directory,'connection');await mkdir(connectionDirectory,{recursive:true});
  // Preserve the first installed connection profile; only conversation context is persona-scoped.
  for(const source of [join(directory,'sessions',hash('default'),'settings.json'),join(directory,'sessions',hash(profile.personaId||'default'),'settings.json')]){
    try{await copyFile(source,join(connectionDirectory,'settings.json'),1);break}catch(error){if(error.code==='EEXIST')break;if(error.code!=='ENOENT')throw error}
  }
  const assertCurrent=()=>{if(closed)throw Error('ASSISTANT_CLOSED');signal.throwIfAborted()};
  const assertWritable=()=>{assertCurrent();if(readOnly())throw Error('ASSISTANT_READ_ONLY')};
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
  let armedRevision, arming, wakeError, activeWake, idleTimer, localFallback = false;
  const sleepAfterMs = 60000;
  let activeCapture, handoffRequested = false, handoffWrites = Promise.resolve(), passiveError;
  function setPassiveHandoff(capture, enabled) {
    handoffWrites = handoffWrites.then(async () => {
      await speech.speechRuntimeControl.setAssistantRealtime(capture, enabled, AbortSignal.timeout(2000));
      if(activeCapture===capture)passiveError=undefined;
    }).catch(() => { if(activeCapture===capture)passiveError='ASSISTANT_WAKE_HANDOFF_UNCONFIRMED'; });
  }
  function forgetActiveWake() {
    clearTimeout(idleTimer);
    if (activeCapture && handoffRequested) setPassiveHandoff(activeCapture, false);
    activeWake = undefined;
    activeCapture = undefined;
    handoffRequested = false;
    localFallback = false;
    passiveError = undefined;
  }
  function renewActiveWake() {
    const target = activeWake;
    if (!target) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      if (activeWake !== target || closed) return;
      if (target.conversation.activity().pending || target.host.captureHasWork() || target.host.captureState().phase === 'starting') {
        renewActiveWake();
        return;
      }
      forgetActiveWake();
      try { await target.host.command({action:'stop'}); }
      catch (error) { wakeError = error.message || 'ASSISTANT_WAKE_STOP_FAILED'; }
    }, sleepAfterMs);
    idleTimer.unref?.();
  }
  function noteWakeSpeech(hasText) {
    renewActiveWake();
    if (hasText && activeCapture && !localFallback && !handoffRequested) {
      handoffRequested = true;
      setPassiveHandoff(activeCapture, true);
    }
  }
  const wake = createWakeListener({speechRuntime:speech.speechRuntimeControl, async onWake({createRecording, createFallbackRecording, recentSpeech, cursor, signal: wakeSignal}) {
    assertWritable(); wakeSignal.throwIfAborted();
    const current = await open();
    assertWritable(); wakeSignal.throwIfAborted();
    if (['starting','running'].includes(current.host.captureState().phase)) return;
    if (current.hostSources.asrIssue || current.hostSources.ttsIssue) throw Error('ASSISTANT_WAKE_CONFIGURATION_REQUIRED');
    activeWake = current;
    activeCapture = cursor.captureId;
    renewActiveWake();
    try {
      const fallback = current.hostSources.asrSource === 'custom' ? {
        createRecording: createFallbackRecording,
        recognize: (audio, signal) => speech.speechRuntimeControl.transcribeAssistantAudio(audio, signal),
        onFallback: () => {
          if (activeWake !== current) return;
          localFallback = true;
          if(handoffRequested){setPassiveHandoff(activeCapture,false);handoffRequested=false;}
        },
      } : undefined;
      await current.host.startWithRecording(createRecording, {fallback, recentSpeech});
      wakeSignal.throwIfAborted();
      renewActiveWake();
    } catch (error) {
      if (activeWake === current) forgetActiveWake();
      throw error;
    }
  }});
  function armWake() {
    if (!profile.wakeEnabled || readOnly() || armedRevision === profileRevision || arming) return;
    const epoch = profileRevision, personaId = profile.personaId;
    armedRevision = epoch; wakeError = null;
    arming = (async () => {
      const current = await open();
      if (!current.host.voiceEnabled() || epoch !== profileRevision) return;
      if (!personaId) throw Error('ASSISTANT_WAKE_PERSONA_REQUIRED');
      const role = await call('manager.roles.detail', {pathParams:{roleId:personaId}});
      assertWritable();
      if (epoch !== profileRevision || !current.host.voiceEnabled()) return;
      const value = role.config?.speechTriggerKeywords ?? role.personaConfig?.speechTriggerKeywords;
      const aliases = Array.isArray(value) ? [...new Set(value.filter(item=>typeof item==='string')
        .map(item=>item.normalize('NFKC').trim()).filter(Boolean))] : [];
      if (aliases.length > 64) throw Error('ASSISTANT_WAKE_TOO_MANY_ALIASES');
      wake.arm(aliases);
    })().catch(error => {
      if (epoch === profileRevision && !closed) wakeError = error.message || 'ASSISTANT_WAKE_CONFIGURATION_REQUIRED';
    }).finally(() => { arming = undefined; });
  }
  function wakeSnapshot() {
    return {...wake.snapshot(), ...(arming?{phase:'starting'}:{}),
      ...(wakeError?{phase:'unavailable',error:wakeError}:{}), ...(passiveError?{passiveError}:{}), ...(activeWake&&['starting','running'].includes(activeWake.host.captureState().phase)?{phase:localFallback?'local-fallback':'active'}:{})};
  }
  async function retireWake() {
    forgetActiveWake();
    await wake.stop();
    await handoffWrites;
    await arming;
    armedRevision = undefined;
    wakeError = null;
  }
  async function open(){
    assertCurrent();if(runtime)return runtime;if(opening)return opening;
    opening=(async()=>{
      const bound=structuredClone(profile),epoch=profileRevision;
      const role=bound.personaId?await call('manager.personas.resources.reference.read',{pathParams:{roleId:bound.personaId}}):undefined;
      const personaLabel=(await personas()).find(item=>item.id===bound.personaId)?.label||bound.personaId;
      let models=[],modelsError,serviceStatus;
      try{models=await speech.speechControl.models()}catch(error){modelsError='HOST_SPEECH_UNAVAILABLE'}
      try{serviceStatus=await speech.speechControl.status?.()}catch{ /* The catalog can still expose a selectable available service. */ }
      const asrModel=bound.asrModel||hostSpeechDefaultModel('asr',models,serviceStatus);
      const readyModel=id=>models.some(item=>item.id===id&&item.enabled&&item.available);
      const asrIssue=bound.asrSource!=='host'?null:modelsError?'无法连接本机识别服务':!asrModel?'未找到可用的本机识别模型':!readyModel(asrModel)?'所选本机识别模型不可用，请重新选择':null;
      const hostVoice=()=>{
        // The route catalogue may publish the selected persona after the assistant opens.
        const persona=speech.speechControl.personas().find(item=>item.id===bound.personaId);
        const model=bound.ttsModel||hostSpeechDefaultModel('tts',models,serviceStatus,persona?.defaultModel);
        return {persona,model};
      };
      const hostVoiceSettings=()=>{
        const {persona,model}=hostVoice();
        return {ttsProvider:'compatible',ttsModel:model||'',ttsVoice:persona?.voiceReady?bound.personaId:'',ttsSpeed:persona?.speed||1};
      };
      const ownDirectory=join(directory,'sessions',hash(bound.personaId||'default'));
      const settings=await openSettingsStore(connectionDirectory);
      if(!settings.read().llmModel){
        const available=await modelCatalog({kind:'llm',provider:'workbuddy-cli',endpoint:'codebuddy://cn',workbuddyCli:hostOptions.workbuddyCli}).catch(()=>[]);
        const selected=available.find(item=>item.id===hostOptions.llmModel)||available.find(item=>item.isDefault);
        await settings.save({llmProvider:'workbuddy-cli',llmEndpoint:'codebuddy://cn',...(selected?{llmModel:selected.id}:{})});
      }
      const overlay=value=>({...value,...(role?{persona:role.document,assistantName:personaLabel}:{}),...(hostOptions.electronExecutable&&!value.electronExecutable?{electronExecutable:hostOptions.electronExecutable}:{}),
        ...(bound.asrSource==='host'?{asrMode:'compatible',asrModel:asrModel||''}:{}),
        ...(bound.ttsSource==='host'?hostVoiceSettings():{}),petId:bound.personaId});
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
            const {persona,model}=hostVoice();
            if(!persona?.voiceReady)throw Error('HOST_PERSONA_VOICE_REQUIRED');
            if(!model)throw Error('HOST_TTS_MODEL_REQUIRED');
            abort.throwIfAborted();assertCurrent();
            const command=hostSpeechCommand({model:models.find(item=>item.id===model)||{id:model},persona,text,expression,sessionId:runtime?.conversation.getSessionId()});
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
          if(presentation.responseId&&presentation.speechStatus==='ended'&&!seen.has(key)){seen.add(key);record({voice:bound.personaId,kind:'tts',id:key,text:presentation.speechText||presentation.text,time:Date.now()})}},
        async dispose(){if(bound.personaId)publish('voice_assistant_presentation',{personaId:bound.personaId,ownerId:identity.activationId,ownerStartedAt,revision:++presentationRevision,clear:true});await Promise.allSettled([...petPending]);seen.clear()}};
      const next=await openAssistantRuntime({directory:ownDirectory,settingsDirectory:connectionDirectory,hostOptions,settingsOverlay:overlay,providerFactory,pet,createModel,recognitionSampleUrl,
        ...(bound.ttsSource==='host'?{expressionPolicy:config=>hostSpeechExpressionPolicy(models.find(item=>item.id===config.ttsModel),config)}:{}),
        credentialDescription:(value,kind)=>bound[kind+'Source']==='host'?{configured:true,writable:false,mode:'host-service'}:value,
        onCaptureActivity:noteWakeSpeech, onCaptureStopped:forgetActiveWake,
        onSubmitted:(message,config)=>{if(config.petEnabled&&bound.personaId&&message.source==='speech')record({kind:'asr',source:'voice-assistant',id:message.id,text:message.text,time:Date.now()})},
        deviceFactory:options=>{assertWritable();return deviceFactory?deviceFactory(options):openDesktopDevice({...options,runtimeEntry})},capabilities:{host:'rabi',modelConfiguration:true,mobileVoiceSubmit:true},
        discoverTools:async()=>{const connection=await manager();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED');return createRabiOperationTools({sdk:connection.operations,sendAgent:sendAgent?request=>sendAgent(request,runtime.conversation.getSessionId()):undefined,assertCurrent:()=>{assertCurrent();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED')}})} });
      if(closed||epoch!==profileRevision){await next.dispose();throw Error('ASSISTANT_CONTEXT_CHANGED')}
      const hostModelSummary=models.map(hostSpeechModelSummary);
      runtime={...next,get hostSources(){
        const {persona,model}=hostVoice();
        const voiceReady=Boolean(persona?.voiceReady);
        const ttsIssue=bound.ttsSource!=='host'?null:modelsError?'无法连接本机播报服务':!voiceReady?'请选择具备本机声线的人格，或使用自定义播报':!model?'未找到可用的本机播报模型':!readyModel(model)?'所选本机播报模型不可用，请重新选择':null;
        return {...bound,personaLabel,asrModel:asrModel||'',ttsModel:model||'',asrIssue,ttsIssue,voiceReady,models:hostModelSummary,modelsError,identitySource:role?'Rabi 人格正文全文；声线由宿主管理':'自定义人设'};
      }};
      return runtime;
    })();try{return await opening}finally{opening=undefined}
  }
  return {
    startWake:armWake,
    async state(){const current=await open(),state=await current.state();armWake();return {...state,hostSettings:{...current.hostSources,wake:wakeSnapshot(),lastError:lastHostError,personas:await personas()},capabilities:{...state.capabilities,host:'rabi',tools:true,modelConfiguration:true}}},
    async messages(view){
      const current=await open();
      const messages=current.messages();
      if(view!=='mobile')return messages;
      const {status,requestId,responseId,tool}=current.conversation.activity();
      return {sessionId:current.conversation.getSessionId(),messages,activity:{status,requestId,responseId,tool}};
    },
    async command(request){
      assertWritable();const current=await open();assertWritable();
      if(request.action==='mobile-voice-submit'){
        if(!current.host.voiceEnabled())throw Error('ASSISTANT_VOICE_DISABLED');
        if(request.sessionId!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
        if(typeof request.requestId!=='string'||!mobileRequestId.test(request.requestId))throw Error('ASSISTANT_INPUT_INVALID');
        const details=mobileAsrDetails(request.observation);
        return current.conversation.submit(request.text,request.requestId,{source:'speech',details,conversationId:request.sessionId,output:'client'});
      }
      if(request.action==='start'&&(current.hostSources.asrIssue||current.hostSources.ttsIssue))throw Error(current.hostSources.asrIssue?'HOST_ASR_CONFIGURATION_REQUIRED':'HOST_TTS_CONFIGURATION_REQUIRED');
      if(request.action==='host-settings'){
        if(current.conversation.activity().pending)throw Error('ASSISTANT_CONTEXT_BUSY');
        const patch=request.patch||{};for(const key of Object.keys(patch))if(key==='wakeEnabled'?typeof patch[key]!=='boolean':!['personaId','asrSource','ttsSource','asrModel','ttsModel'].includes(key)||typeof patch[key]!=='string')throw Error('ASSISTANT_HOST_PROFILE_INVALID');
        const next={...profile,...patch};if(!validSource(next.asrSource)||!validSource(next.ttsSource))throw Error('ASSISTANT_HOST_PROFILE_INVALID');
        if(next.personaId&&!(await personas()).some(item=>item.id===next.personaId))throw Error('ASSISTANT_PERSONA_UNAVAILABLE');
        const old=profile;profileRevision++;
        const retirement=retireWake();
        await current.dispose();runtime=undefined;await retirement;profile=next;
        try{await open();const pending=profilePath+'.'+randomUUID()+'.tmp';await writeFile(pending,JSON.stringify(profile),{mode:0o600});await rename(pending,profilePath)}catch(error){profile=old;profileRevision++;armWake();throw error}lastHostError=null;armWake();return {saved:true,settingsScopeChanged:true};
      }
      if(['stop','exit'].includes(request.action))forgetActiveWake();
      if(request.action==='exit'){await current.host.command({action:'stop'});await handoffWrites;return {stopped:true}}
      if(request.action==='stop'){const result=await current.command(request);await handoffWrites;return result}
      if(request.action==='settings'){
        const previouslyEnabled=current.host.voiceEnabled();
        const result=await current.command(request);
        if(previouslyEnabled!==current.host.voiceEnabled()){
          await retireWake();
          if(current.host.voiceEnabled())armWake();
        }
        return result;
      }
      return current.command(request);
    },
    async session(){const current=await open();return {id:current.conversation.getSessionId(),name:current.hostSources.personaLabel||profile.personaId||'语音助手',cwd:directory,updatedAt:current.conversation.contextState().savedAt||null}},
    async submit(text,requestId,expectedSession){assertWritable();const current=await open();assertWritable();if(expectedSession&&expectedSession!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');return current.conversation.submit(text,requestId)},
    async recover(requestId,text){assertWritable();const current=await open();assertWritable();return current.conversation.acceptedRequest(requestId,text)},
    async dispose(){if(closed)return;closed=true;profileRevision++;await opening?.catch(()=>{});const retirement=retireWake();await runtime?.dispose();await retirement;await clientOpening?.catch(()=>{});await client?.close();runtime=undefined}
  };
}
