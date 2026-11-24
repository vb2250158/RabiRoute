import {hostAsrDictionaryPolicy,hostAsrDictionaryPrompt,hostSpeechDefaultModel,hostSpeechExpressionPolicy,hostSpeechCommand,hostSpeechModelSummary} from './host-speech.mjs';
import {mkdir,readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openAssistantRuntime} from '../../../../apps/desktop-assistant/src/runtime.mjs';
import {snapshotRecentSpeech} from '../../../../packages/assistant-runtime/src/speech-observation.js';
import {openSettingsStore} from '../../../../apps/desktop-assistant/src/settings-store.mjs';
import {createHostEndpointSession} from '../../../../apps/rabi-agent/lib/host-endpoint.mjs';
import {createManagerClient} from '../../../../apps/rabi-agent/lib/manager-client.mjs';
import {asrDictionaryPolicy,createSpeechProviders} from '@rabilink/desktop-voice-service/speech-providers';
import {listProviderModels} from '@rabilink/desktop-voice-service/model-providers';
import {openDesktopDevice} from '@rabilink/desktop-voice-service/node';
import {createRabiOperationTools} from './operation-tools.mjs';
import {createResidentWake,normalizeWakeAliases} from '../../../../packages/desktop-voice-service/src/resident-wake.mjs';
import {mobileAsrSampleRate,openMobileAsrStream} from './mobile-asr-stream.mjs';
import {createMobileTts,mobileCustomTtsReady} from './mobile-tts.mjs';

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
function mobileProviderObservation(values){
  const observation={};
  for(const [key,validate] of Object.entries(mobileObservationValidators)){
    const raw=values?.[key];
    const value=(key==='age'||key==='confidence')&&typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw.trim())?Number(raw):raw;
    if(validate(value))observation[key]=value;
  }
  return Object.keys(observation).length?observation:undefined;
}
export async function createVoiceAssistantOwner({identity,stateRoot,speech,publish,publishDesktopPresentation,signal,hostOptions={},clientFactory,deviceFactory,runtimeEntry,recognitionSampleUrl,createModel,modelCatalog=listProviderModels,customProviderFactory=createSpeechProviders,managerEndpoint,sendAgent,readOnly=()=>false}){
  const directory=join(stateRoot,'data','voice-assistant');await mkdir(directory,{recursive:true});
  let profile={personaId:'',asrSource:'host',ttsSource:'host',wakeEnabled:false},closed=false,runtime,opening,client,clientOpening,profileRevision=0,lastHostError=null;
  let lastPresentationStartedAt=0;
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
  let armedRevision, arming, wakeError;
  let mobileAsr, mobileBatch;
  async function stopMobileAsr(){
    const lease=mobileAsr;
    mobileBatch?.abort();
    if(!lease)return;
    try{await lease.cancel()}finally{if(mobileAsr===lease)mobileAsr=undefined}
  }
  const wake = createResidentWake({
    speechRuntime:speech.speechRuntimeControl,
    acquireTarget:open,
    assertCurrent:assertWritable,
    canStart:target=>!target.hostSources.asrIssue&&!target.hostSources.ttsIssue,
    shouldUseFallback:target=>target.hostSources.asrSource==='custom',
  });
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
      wake.arm(normalizeWakeAliases(value));
    })().catch(error => {
      if (epoch === profileRevision && !closed) wakeError = error.message || 'ASSISTANT_WAKE_CONFIGURATION_REQUIRED';
    }).finally(() => { arming = undefined; });
  }
  function wakeSnapshot() {
    return {...wake.snapshot(), ...(arming?{phase:'starting'}:{}),
      ...(wakeError?{phase:'unavailable',error:wakeError}:{})};
  }
  async function retireWake() {
    await wake.stop();
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
      const aliases=normalizeWakeAliases(role?.personaConfig?.speechTriggerKeywords);
      const wakeAliases=aliases.length<=64?aliases:[];
      async function mobileLocalState(){
        const deadline=AbortSignal.timeout(200);
        try{
          const passiveModel=await speech.speechRuntimeControl?.assistantLocalAsrModel?.(AbortSignal.any([signal,deadline]));
          return passiveModel?{passiveModel,dictionary:null}:{};
        }catch(error){return error===deadline.reason&&!signal.aborted?{passiveAsrStatus:'checking'}:{};}
      }
      const keywordOwner=speech.speechRuntimeControl;
      let keywordProfile, keywordRequest, keywordRetryAfter=0;
      async function mobileWakeSettings(){
        const localState=mobileLocalState();
        if(wakeAliases.length&&keywordOwner&&!keywordProfile&&!keywordRequest&&Date.now()>=keywordRetryAfter){
          const timeout=AbortSignal.any([signal,AbortSignal.timeout(2500)]);
          keywordRequest=Promise.resolve().then(()=>keywordOwner.assistantKeywordProfile?.(wakeAliases,timeout))
            .catch(()=>undefined).then(value=>{
              keywordProfile=value;
              if(!value)keywordRetryAfter=Date.now()+30_000;
            })
            .finally(()=>{keywordRequest=undefined;});
        }
        const [local]=await Promise.all([localState,keywordRequest]);
        return {wakeAliases:local.passiveModel||keywordProfile?wakeAliases:[],...local,
          ...(keywordProfile?{kws:keywordProfile}:{})};
      }
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
      async function hostRecognize(model, dictionary, audio, abort) {
        if(!model) throw Error('HOST_ASR_MODEL_REQUIRED');
        const prompt = hostAsrDictionaryPrompt(models.find(item=>item.id===model), dictionary);
        abort.throwIfAborted();assertCurrent();
        const form=new FormData();form.set('file',new Blob([audio],{type:'audio/wav'}),'speech.wav');form.set('model',model);
        if (prompt) form.set('prompt',prompt);
        const request=new Request('http://localhost/',{method:'POST',body:form});
        const result=await speech.speechControl.transcribe(request.headers.get('content-type'),Buffer.from(await request.arrayBuffer()),()=>{assertCurrent();abort.throwIfAborted()},abort);
        if(result.status<200||result.status>=300)throw Error('HOST_ASR_FAILED');
        return JSON.parse(Buffer.from(result.body).toString('utf8'));
      }
      const providerFactory=options=>{
        const provider=customProviderFactory(options);
        if(bound.asrSource==='host'){
          delete provider.createAsr;provider.asrFeedback={mode:'utterance',label:'整句转录'};
          provider.recognize=(audio,abort)=>hostRecognize(asrModel,options.config.asrDictionary,audio,abort);
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
      const seen=new Set(),petPending=new Set();
      const ownerStartedAt=lastPresentationStartedAt=Math.max(Date.now(),lastPresentationStartedAt+1);
      let presentationRevision=0,companionPresentation=false,presentationScope;
      const emitPet=(data,scope)=>{
        const event={personaId:bound.personaId,ownerId:identity.activationId,ownerStartedAt,revision:++presentationRevision,...data};
        if(publishDesktopPresentation)publishDesktopPresentation(event,scope==='public');
        else if(scope==='public'){
          const {inputPreview,...publicData}=event;
          publish('voice_assistant_presentation',publicData);
        }
      };
      const clearPet=()=>{if(presentationScope)emitPet({clear:true},presentationScope);presentationScope=undefined;};
      const record=value=>{const work=call('manager.desktop-pet.transcripts.append',{pathParams:{roleId:bound.personaId},body:{personaId:bound.personaId,...value}});petPending.add(work);void work.catch(()=>{}).finally(()=>petPending.delete(work))};
      const pet={state:()=>({available:Boolean(bound.personaId),pets:bound.personaId?[{id:bound.personaId,name:bound.personaId}]:[]}),
        present(config,presentation){
          if(!bound.personaId)return;
          const scope=config.petEnabled?'public':companionPresentation&&publishDesktopPresentation?'desktop':undefined;
          if(scope!==presentationScope)clearPet();
          if(!scope)return;
          presentationScope=scope;
          emitPet(presentation,scope);
          const key=presentation.responseId+':'+presentation.playbackId;
          if(config.petEnabled&&presentation.responseId&&presentation.speechStatus==='ended'&&!seen.has(key)){seen.add(key);record({voice:bound.personaId,kind:'tts',id:key,text:presentation.speechText||presentation.text,time:Date.now()})}},
        async dispose(){clearPet();await Promise.allSettled([...petPending]);seen.clear()}};
      const next=await openAssistantRuntime({directory:ownDirectory,settingsDirectory:connectionDirectory,hostOptions,settingsOverlay:overlay,providerFactory,pet,createModel,recognitionSampleUrl,
        dictionaryPolicy:config=>bound.asrSource==='host'?hostAsrDictionaryPolicy(models.find(item=>item.id===asrModel)):asrDictionaryPolicy(config),
        ...(bound.ttsSource==='host'?{expressionPolicy:config=>hostSpeechExpressionPolicy(models.find(item=>item.id===config.ttsModel),config)}:{}),
        credentialDescription:(value,kind)=>bound[kind+'Source']==='host'?{configured:true,writable:false,mode:'host-service'}:value,
        onCaptureActivity:wake.captureActivity,
        onCaptureStopped(){companionPresentation=false;wake.captureStopped();},
        onSubmitted:(message,config)=>{if(config.petEnabled&&bound.personaId&&message.source==='speech')record({kind:'asr',source:'voice-assistant',id:message.id,text:message.text,time:Date.now()})},
        deviceFactory:options=>{assertWritable();return deviceFactory?deviceFactory(options):openDesktopDevice({...options,runtimeEntry})},capabilities:{host:'rabi',modelConfiguration:true,mobileVoiceSubmit:true},
        discoverTools:async()=>{const connection=await manager();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED');return createRabiOperationTools({sdk:connection.operations,sendAgent:sendAgent?request=>sendAgent(request,runtime.conversation.getSessionId()):undefined,assertCurrent:()=>{assertCurrent();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED')}})} });
      if(closed||epoch!==profileRevision){await next.dispose();throw Error('ASSISTANT_CONTEXT_CHANGED')}
      const mobileTts=createMobileTts({conversation:next.conversation,settings:next.speechSettings,signal,
        assertCurrent(){assertCurrent();if(epoch!==profileRevision)throw Error('ASSISTANT_CONTEXT_CHANGED');},
        ready:async config=>mobileCustomTtsReady(bound.ttsSource,config,await next.speechCredentialDescription(config)),
        createProviders:next.speechProviders,
      });
      const hostModelSummary=models.map(hostSpeechModelSummary);
      runtime={...next,mobileWakeSettings,mobileTts,
        async dispose(){await mobileTts.dispose();await next.dispose();},
        setCompanionPresentation(enabled){companionPresentation=enabled;},
        recognizeMobileLocal:async(audio,abort)=>{
          try{
            const local=speech.speechRuntimeControl;
            if(typeof local?.transcribeMobileAssistantAudio!=='function')throw Error('MOBILE_LOCAL_ASR_UNAVAILABLE');
            return await local.transcribeMobileAssistantAudio(audio,abort);
          }catch(error){
            abort.throwIfAborted();
            if(error?.message==='MOBILE_LOCAL_ASR_UNAVAILABLE')throw error;
            throw new Error('MOBILE_LOCAL_ASR_UNAVAILABLE',{cause:error});
          }
        },
        get hostSources(){
        const {persona,model}=hostVoice();
        const voiceReady=Boolean(persona?.voiceReady);
        const ttsIssue=bound.ttsSource!=='host'?null:modelsError?'无法连接本机播报服务':!voiceReady?'请选择具备本机声线的人格，或使用自定义播报':!model?'未找到可用的本机播报模型':!readyModel(model)?'所选本机播报模型不可用，请重新选择':null;
        return {...bound,personaLabel,asrModel:asrModel||'',ttsModel:model||'',asrIssue,ttsIssue,voiceReady,models:hostModelSummary,modelsError,identitySource:role?'Rabi 人格正文全文；声线由宿主管理':'自定义人设'};
      }};
      return runtime;
    })();try{return await opening}finally{opening=undefined}
  }
  let profileCommandBusy=false;
  function assertVoiceReady(current){
    if(current.hostSources.asrIssue)throw Error('HOST_ASR_CONFIGURATION_REQUIRED');
    if(current.hostSources.ttsIssue)throw Error('HOST_TTS_CONFIGURATION_REQUIRED');
  }
  async function saveHostProfile(current,patch,{forVoice=false}={}){
    if(current.conversation.activity().pending)throw Error('ASSISTANT_CONTEXT_BUSY');
    for(const key of Object.keys(patch))if(key==='wakeEnabled'?typeof patch[key]!=='boolean':!['personaId','asrSource','ttsSource','asrModel','ttsModel'].includes(key)||typeof patch[key]!=='string')throw Error('ASSISTANT_HOST_PROFILE_INVALID');
    const next={...profile,...patch};
    if(!validSource(next.asrSource)||!validSource(next.ttsSource))throw Error('ASSISTANT_HOST_PROFILE_INVALID');
    if(next.personaId&&!(await personas()).some(item=>item.id===next.personaId))throw Error('ASSISTANT_PERSONA_UNAVAILABLE');
    if(forVoice&&(mobileAsr||['starting','running'].includes(current.host.captureState().phase)))throw Error('ASSISTANT_OTHER_PERSONA_ACTIVE');
    await stopMobileAsr();
    assertWritable();
    if(current.conversation.activity().pending)throw Error('ASSISTANT_CONTEXT_BUSY');
    const old=profile;profileRevision++;
    const retirement=retireWake();
    await current.dispose();runtime=undefined;await retirement;profile=next;
    try{
      const candidate=await open();
      assertWritable();
      if(forVoice)assertVoiceReady(candidate);
      const pending=profilePath+'.'+randomUUID()+'.tmp';
      await writeFile(pending,JSON.stringify(profile),{mode:0o600});
      await rename(pending,profilePath);
    }catch(error){
      const candidate=runtime;
      runtime=undefined;profile=old;profileRevision++;
      await candidate?.dispose();
      armWake();
      throw error;
    }
    lastHostError=null;
    if(!forVoice)armWake();
    return {saved:true,settingsScopeChanged:true};
  }
  async function startOrConfigure(request){
    if(profileCommandBusy)throw Error('ASSISTANT_CONTEXT_BUSY');
    profileCommandBusy=true;
    let switchedPersona=false;
    let companionRuntime;
    try{
      let current=await open();
      assertWritable();
      if(request.action==='host-settings')return await saveHostProfile(current,request.patch||{});
      if(request.action==='start-for-persona'){
        if(typeof request.personaId!=='string'||!request.personaId||request.personaId.length>128)throw Error('ASSISTANT_PERSONA_UNAVAILABLE');
        if(!current.host.voiceEnabled())throw Error('ASSISTANT_VOICE_DISABLED');
        if(request.personaId!==profile.personaId){
          await saveHostProfile(current,{personaId:request.personaId},{forVoice:true});
          switchedPersona=true;
          current=await open();
        }
        const active=current.host.captureState();
        if(active.phase==='running'){
          companionRuntime=current;
          current.setCompanionPresentation(true);
          if(active.capture==='listening')return current.host.state();
          return await current.command({action:'resume'});
        }
      }
      assertVoiceReady(current);
      if(request.action==='start-for-persona'){
        companionRuntime=current;
        current.setCompanionPresentation(true);
      }
      if(await wake.startManual())return current.host.state();
      return await current.command({action:'start'});
    }catch(error){
      companionRuntime?.setCompanionPresentation(false);
      throw error;
    }finally{
      profileCommandBusy=false;
      if(switchedPersona)armWake();
    }
  }
  return {
    startWake:armWake,
    async state(view){
      const current=await open(),state=await current.state();
      armWake();
      const [people,mobileWake]=await Promise.all([personas(),current.mobileWakeSettings()]);
      assertCurrent();
      if(runtime!==current)throw Error('ASSISTANT_CONTEXT_CHANGED');
      if (view === 'mobile') {
        const {asrDictionary, ...settings} = state.settings;
        state.settings = settings;
      }
      return {...state,hostSettings:{...current.hostSources,wake:wakeSnapshot(),lastError:lastHostError,personas:people,
        mobileAudio:{recognition:current.streamingAsr()?'streaming':'utterance',sampleRate:mobileAsrSampleRate,...mobileWake}},
        capabilities:{...state.capabilities,host:'rabi',tools:true,modelConfiguration:true,
          mobileCustomTts:mobileCustomTtsReady(current.hostSources.ttsSource,state.settings,state.credentials?.tts)}};
    },
    async synthesizeMobile(request,requestSignal){
      assertWritable();const current=await open();assertWritable();
      return current.mobileTts.synthesize(request,requestSignal);
    },
    async transcribeMobile({audio,sessionId,source,signal:requestSignal}){
      assertWritable();
      const current=await open(),epoch=profileRevision;
      const batch = new AbortController();
      const abort=AbortSignal.any([signal,batch.signal,...(requestSignal?[requestSignal]:[])]);
      const assertSession=()=>{
        assertWritable();abort.throwIfAborted();
        if(epoch!==profileRevision||sessionId!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
        if(!current.host.voiceEnabled())throw Error('ASSISTANT_VOICE_DISABLED');
      };
      assertSession();
      if (!['active','local'].includes(source)) throw Error('MOBILE_ASR_SOURCE_INVALID');
      if (!(audio instanceof Uint8Array) || audio.byteLength <= 44 ||
          Buffer.from(audio.subarray(0,4)).toString() !== 'RIFF' ||
          Buffer.from(audio.subarray(8,12)).toString() !== 'WAVE') throw Error('MOBILE_ASR_AUDIO_INVALID');
      if (mobileBatch && !mobileBatch.signal.aborted) throw Error('MOBILE_ASR_BUSY');
      mobileBatch=batch;
      try {
        const result = source === 'local'
          ? await current.recognizeMobileLocal(audio,abort)
          : await current.recognizeAudio(audio,abort);
        assertSession();
        return {text:result.text, ...mobileProviderObservation({...result,...result.additions})};
      } finally {
        if (mobileBatch===batch) mobileBatch=undefined;
      }
    },
    async openMobileAsr({request,sessionId,signal:requestSignal}){
      assertWritable();
      const current=await open(),epoch=profileRevision;
      assertWritable();requestSignal?.throwIfAborted();
      if(!current.host.voiceEnabled())throw Error('ASSISTANT_VOICE_DISABLED');
      if(sessionId!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
      if(mobileAsr)throw Error('MOBILE_STREAM_ASR_BUSY');
      const createAsr=current.streamingAsr();
      if(!createAsr)throw Error('MOBILE_STREAM_ASR_UNAVAILABLE');
      const stream=openMobileAsrStream({request,createAsr,signal:requestSignal,observationOf:mobileProviderObservation,assertCurrent(){
        assertWritable();
        if(epoch!==profileRevision||sessionId!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
      }});
      mobileAsr=stream;
      return {async cancel(){try{await stream.cancel()}finally{if(mobileAsr===stream)mobileAsr=undefined}},frames:(async function*(){
        try{yield* stream.frames}finally{if(mobileAsr===stream)mobileAsr=undefined}
      })()};
    },
    async messages(view){
      const current=await open();
      let messages=current.messages();
      if(view!=='mobile')return messages;
      const latest=messages.findLast(row=>row.role==='assistant'&&!row.notice);
      if(latest?.hasDetails){
        const ends=current.conversation.messageDetails(latest.id).speechSegmentEnds||[];
        const speechSegmentEnds=ends.filter((end,index)=>Number.isSafeInteger(end)&&end>0&&end<=latest.text.length&&(index===0||end>ends[index-1]));
        messages=messages.map(row=>row.id===latest.id?{...row,speechSegmentEnds}:row);
      }
      const {status,requestId,responseId,tool}=current.conversation.activity();
      return {sessionId:current.conversation.getSessionId(),messages,activity:{status,requestId,responseId,tool}};
    },
    async command(request){
      assertWritable();
      if(request.action==='start'||request.action==='start-for-persona'||request.action==='host-settings')return startOrConfigure(request);
      const current=await open();assertWritable();
      if(request.action==='mobile-voice-submit'){
        if(!current.host.voiceEnabled())throw Error('ASSISTANT_VOICE_DISABLED');
        if(request.sessionId!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
        if(typeof request.requestId!=='string'||!mobileRequestId.test(request.requestId))throw Error('ASSISTANT_INPUT_INVALID');
        const details=mobileAsrDetails(request.observation);
        const recentSpeech=snapshotRecentSpeech(request.recentSpeech);
        return current.conversation.submit(request.text,request.requestId,{source:'speech',details,recentSpeech,conversationId:request.sessionId,output:'client'});
      }
      if(['stop','exit'].includes(request.action))wake.captureStopped();
      if(request.action==='exit'){await current.host.command({action:'stop'});await wake.drainHandoff();return {stopped:true}}
      if(request.action==='stop'){const result=await current.command(request);await wake.drainHandoff();return result}
      if(request.action==='clear-context'&&request.confirm===true&&request.sessionId===current.conversation.getSessionId()&&!current.conversation.activity().pending)await stopMobileAsr();
      if(request.action==='settings'){
        await stopMobileAsr();
        current.mobileTts.invalidate();
        const previouslyEnabled=current.host.voiceEnabled();
        const result=await current.command(request);
        if(previouslyEnabled!==current.host.voiceEnabled()){
          await retireWake();
          if(current.host.voiceEnabled())armWake();
        }
        return result;
      }
      if(request.action==='credential'&&request.kind==='tts')current.mobileTts.invalidate();
      return current.command(request);
    },
    async session(){const current=await open();return {id:current.conversation.getSessionId(),name:current.hostSources.personaLabel||profile.personaId||'语音助手',cwd:directory,updatedAt:current.conversation.contextState().savedAt||null}},
    async submit(text,requestId,expectedSession){assertWritable();const current=await open();assertWritable();if(expectedSession&&expectedSession!==current.conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');return current.conversation.submit(text,requestId)},
    async recover(requestId,text){assertWritable();const current=await open();assertWritable();return current.conversation.acceptedRequest(requestId,text)},
    async dispose(){if(closed)return;closed=true;profileRevision++;await opening?.catch(()=>{});const retirement=retireWake();await stopMobileAsr();await runtime?.dispose();await retirement;await clientOpening?.catch(()=>{});await client?.close();runtime=undefined}
  };
}
