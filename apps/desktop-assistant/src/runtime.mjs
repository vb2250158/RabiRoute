import {recognizeStreamSample} from '@rabilink/desktop-voice-service/speech-sample';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { openSettingsStore } from './settings-store.mjs';
import { createStandaloneConversation } from './conversation.mjs';
import { createChatModel } from '@rabilink/desktop-voice-service/chat-model';
import { createResidentHost } from '@rabilink/desktop-voice-service/host';
import { openDesktopDevice } from '@rabilink/desktop-voice-service/node';
import { boundedDictionary, createSpeechProviders } from '@rabilink/desktop-voice-service/speech-providers';
import { speechProviders } from '@rabilink/desktop-voice-service/provider-profiles';
import { modelProviders, listProviderModels } from '@rabilink/desktop-voice-service/model-providers';
import { createLocalRecognizer } from './local-asr.mjs';
import { createAssistantDiagnostics } from './diagnostics.mjs';
import {openConversationStore} from './conversation-store.mjs';
import {createWebSearchService} from '@rabilink/desktop-voice-service/web-search';
import { createResidentWake, parseWakeAliases } from '../../../packages/desktop-voice-service/src/resident-wake.mjs';

/** Thin binding only: shared host owns lifecycle and the shared SDK owns conversation. */
export async function openAssistantRuntime({ directory, settingsDirectory=directory, deviceFactory = openDesktopDevice, providerFactory = createSpeechProviders, hostOptions, recognitionSampleUrl, discoverTools, pet, settingsOverlay = value => value, capabilities = {}, onOpenSettings = () => {}, createModel = createChatModel, credentialDescription = value => value, onSubmitted, expressionPolicy, onCaptureActivity, onCaptureStopped, residentSpeech, dictionaryPolicy }) {
  const store = await openSettingsStore(settingsDirectory);
  let options={};
  try {options=JSON.parse(await readFile(join(directory,'host-options.json'),'utf8'));}
  catch(error) {if(error.code!=='ENOENT')throw Error('ASSISTANT_HOST_OPTIONS_INVALID');}
  options={...options,...hostOptions};
  const savedRead=store.read,savedPreview=store.preview,savedSave=store.save,savedBatch=store.saveBatch,savedDescribe=store.credentials.describe;
  store.read=()=>settingsOverlay(savedRead());store.preview=patches=>settingsOverlay(savedPreview(patches));
  store.save=async patch=>settingsOverlay(await savedSave(patch));store.saveBatch=async patches=>settingsOverlay(await savedBatch(patches));
  store.credentials.describe=async(kind,endpoint,provider)=>credentialDescription(await savedDescribe(kind,endpoint,provider),kind);
  const localAsr=createLocalRecognizer(options.localAsr);
  const listModels=request=>listProviderModels({...request,workbuddyCli:options.workbuddyCli});
  const conversationStore=await openConversationStore(directory);
  try {
  const webSearch=createWebSearchService({settings:store.read,credentials:store.credentials,workbuddyCli:options.workbuddyCli});
  let conversation, diagnostics, disposed = false, closing = false;
  let wakeSettings, wakeUpdate = Promise.resolve();
  const providers=(config,context={})=>{
    const result=providerFactory({config,credentials:store.credentials,...context});
    if (config.asrMode !== 'local-whisper') return result;
    const prompt = boundedDictionary(config.asrDictionary, {maxBytes:224}).join('\n');
    return {...result, recognize:(audio, signal)=>localAsr.recognize(audio, signal, prompt)};
  };
  // The process launcher supplies the local capture capability. Browser commands only set preferences.
  const wake = residentSpeech && createResidentWake({
    speechRuntime: residentSpeech,
    acquireTarget: () => ({ host, conversation }),
    assertCurrent() { if (closing || !store.read().keywordWakeEnabled) throw Error('ASSISTANT_WAKE_DISABLED'); },
    canStart: () => diagnostics.snapshot().job.status !== 'running',
    shouldUseFallback: () => store.read().asrMode !== 'local-whisper',
  });
  function syncWake() {
    if (!wake) return;
    const update = wakeUpdate.then(async () => {
      const config = store.read();
      const aliases = config.keywordWakeEnabled && !closing && host.voiceEnabled() ? parseWakeAliases(config.keywordWakeAliases) : [];
      const key = JSON.stringify(aliases);
      if (wakeSettings === key) return;
      await wake.stop({ stopCapture: true });
      if (aliases.length && !closing) wake.arm(aliases);
      wakeSettings = key;
    });
    wakeUpdate = update.catch(() => {});
    return update;
  }
  let catalogPromise, catalogTime = 0, catalogCache=[];
  const modelCatalog = () => {
    const config=store.read();
    if(config.llmProvider!=='workbuddy-cli')return undefined;
    if(!catalogPromise||Date.now()-catalogTime>300000) {
      catalogTime=Date.now();
      catalogPromise=listModels({kind:'llm',provider:config.llmProvider,endpoint:config.llmEndpoint}).then(values=>{catalogCache=values;return values}).catch(()=>[]);
    }
    return {llm:catalogCache};
  };
  const host = createResidentHost({ settings: store.read, saveSettings: store.save, previewSettings: store.preview, saveSettingsBatch: store.saveBatch, credentials: store.credentials, deviceFactory,pet,supportsDynamicExpression:true,listModels,dictionaryPolicy,
    conversation: ({ onError }) => conversation = createStandaloneConversation({ settings: store.read, credentials: store.credentials, onError,store:conversationStore,webSearch,discoverTools,onSubmitted,expressionPolicy,createModel:optionsForModel=>createModel({...optionsForModel,workbuddyCli:options.workbuddyCli}),
      onCompleted:config=>diagnostics?.recordModel(config) }),
    observeOutput: ({ conversation, ...observer }) => conversation.observe(observer),
    createProviders: providers,
    openSettings: onOpenSettings,
    onCaptureActivity(hasText) { wake?.captureActivity(hasText); onCaptureActivity?.(hasText); },
    onCaptureStopped() { wake?.captureStopped(); onCaptureStopped?.(); },
  });
  function recognizeAudio(audio, signal, {sample = false} = {}) {
    signal?.throwIfAborted();
    const current = providers(store.read(), sample ? {} : {recognitionContext:conversation.recognitionContext});
    if (current.createAsr) return recognizeStreamSample({createAsr:current.createAsr,audio,signal,endInput:!sample});
    return current.recognize(audio,signal);
  }
  diagnostics=await createAssistantDiagnostics({directory,settings:store.read,host,conversation,sampleUrl:recognitionSampleUrl,
    recognize:(audio,signal)=>recognizeAudio(audio,signal,{sample:true})});
  const bound = {
    async state() {
      const state = await host.state();
      return { ...state,context:conversation.contextState(), diagnostics:diagnostics.snapshot(),activity:conversation.activity(),...(expressionPolicy?{speechExpression:{...expressionPolicy(store.read()),available:true}}:{}),webSearch:webSearch.snapshot(), capabilities: { host: 'standalone',contextManagement:true,messageHistory:true, tools: webSearch.available(),webSearch:true, serviceTests:true,localAsr:localAsr.configured,modelConfiguration:true,...capabilities,modelProviders, modelCatalogs:await modelCatalog(), speechProviders: Object.fromEntries(Object.entries(speechProviders).map(([kind, values]) => [kind, values.filter(item => !item.host||item.host==='standalone'&&(item.id!=='local-whisper'||localAsr.configured)).map(({ id, label, credentialMode }) => ({ id, label, credentialMode }))])) },
        ...(wake ? { keywordWake: wake.snapshot() } : {}),
        credentials: { ...state.credentials, search:await store.credentials.describe('search','https://api.tavily.com/search','tavily'),llm: await store.credentials.describe('llm', store.read().llmEndpoint,store.read().llmProvider) } };
    },
    async command(request) {
      if(request.action==='web-search-test'){
        if(conversation.activity().pending||diagnostics.snapshot().job.status==='running')throw Error('WEB_SEARCH_BUSY');
        return webSearch.search('Rokid AIUI 官方开发文档');
      }
      if(request.action==='web-search-credential'){
        if(conversation.activity().pending||webSearch.snapshot().status==='searching')throw Error('WEB_SEARCH_BUSY');
        const result=await store.credentials.set('search','https://api.tavily.com/search',request.key,'tavily');webSearch.invalidate();return result;
      }
      if(webSearch.snapshot().status==='searching'&&['settings','credential','run-checks'].includes(request.action))throw Error('WEB_SEARCH_BUSY');
      if(request.action==='message-history')return conversation.messageHistory(request.before);
      if(request.action==='retry-context-save'){const result=conversation.retryContextSave();await host.command({action:'prepare'});return result}
      if(request.action==='clear-context'){
        if(request.confirm!==true)throw Error('ASSISTANT_CONTEXT_CONFIRM_REQUIRED');
        if(request.sessionId!==conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
        if(conversation.activity().pending||diagnostics.snapshot().job.status==='running')throw Error('ASSISTANT_CONTEXT_BUSY');
        await host.command({action:'stop'});return conversation.clearContext(request.sessionId);
      }
      if(request.action==='text'){
        if(request.sessionId!==undefined&&request.sessionId!==conversation.getSessionId())throw Error('ASSISTANT_CONTEXT_CHANGED');
      }
      if(request.action==='confirm-playback')return diagnostics.confirmPlayback(request.heard);
      if(request.action==='run-checks')return diagnostics.run(request.id);
      if(['settings','credential','text','start'].includes(request.action)&&diagnostics.snapshot().job.status==='running')throw Error('ASSISTANT_CHECK_BUSY');
      if(request.action==='start'&&await wake?.startManual())return host.state();
      if (request.action === 'settings') {
        const changes = request.patches ?? [request.patch];
        if (Array.isArray(changes) && changes.some(patch => patch && ('keywordWakeAliases' in Object(patch) || 'keywordWakeEnabled' in Object(patch)))) {
          if (!wake) throw Error('ASSISTANT_WAKE_SERVICE_UNAVAILABLE');
          const config = store.preview(changes);
          const aliases = parseWakeAliases(config.keywordWakeAliases);
          if (config.keywordWakeEnabled && !aliases.length) throw Error('ASSISTANT_WAKE_ALIASES_REQUIRED');
        }
      }
      const result=await host.command(request);
      if(request.action==='settings')await syncWake();
      if(request.action==='stop')await wake?.drainHandoff();
      if(request.action==='credential')await diagnostics.invalidate(request.kind==='llm'?'model':request.kind);
      return result;
    },
    async dispose() { if (disposed) return; closing = true; webSearch.dispose();await wakeUpdate;await wake?.stop();await diagnostics.drain();await host.dispose(); await conversation.drain();await conversationStore.close(); disposed = true; },
  };
  try { await host.initialize(); await syncWake(); }
  catch (error) { await bound.dispose(); throw error; }
  return { ...bound, messages:conversation.messages, conversation, host,
    recognitionDictionary: () => store.read().asrDictionary,
    recognizeAudio,
    streamingAsr: () => providers(store.read()).createAsr };
  } catch(error){await conversationStore.close();throw error}
}
