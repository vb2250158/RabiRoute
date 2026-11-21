import {recognitionContextPrompt} from './recognition-context.mjs';
import { randomUUID } from 'node:crypto';
import { createHttpSpeechProviders } from './providers.mjs';
import { createVolcanoAsr } from './volcano-asr.mjs';
import { openVolcanoTts } from './volcano-tts.mjs';
import { validateProviderEndpoint } from './provider-profiles.mjs';
import { encodeVolcanoTtsParams,recognitionFeedback } from './speech-catalog.mjs';
import {selectedSpeechCatalog,resolveSpeechExpression} from './tts-expression.mjs';
import {openOpenAiTts} from './openai-tts.mjs';
import {asrDictionaryPolicy,boundedDictionary} from './asr-dictionary.mjs';
export {asrDictionaryPolicy,boundedDictionary} from './asr-dictionary.mjs';

/** Provider selection is shared; credentials are always resolved for one fixed target. */
export function createSpeechProviders({ config, credentials, connect, fetcher, recognitionContext=()=>[] }) {
  const openaiTts=config.ttsProvider==='compatible'&&Boolean(selectedSpeechCatalog(config));
  const openaiAsr=config.asrMode==='compatible'&&Boolean(selectedSpeechCatalog(config,'asr'));
  const ttsParameters=expression=>{const value=resolveSpeechExpression(config,expression);return {speed:value.ttsSpeed||1,...(value.ttsModel.startsWith('gpt-4o-mini-tts')&&value.ttsContextText?{instructions:value.ttsContextText}:{})}};
  const asrParameters=()=>{
    const prompt = asrDictionaryPolicy(config)?.format === 'prompt'
      ? recognitionContextPrompt(config, config.asrUseContext === false ? [] : recognitionContext())
      : '';
    return {temperature:config.asrTemperature||0,...(config.asrLanguage?{language:config.asrLanguage}:{}),...(prompt?{prompt}:{}),
    response_format:config.asrModel==='gpt-4o-transcribe-diarize'?'diarized_json':config.asrModel==='whisper-1'&&(config.asrWordTimestamps||config.asrSegmentTimestamps)?'verbose_json':'json',
    ...(config.asrModel==='gpt-4o-transcribe-diarize'?{chunking_strategy:'auto'}:{}),...(config.asrModel==='whisper-1'?{'timestamp_granularities[]':[...(config.asrWordTimestamps?['word']:[]),...(config.asrSegmentTimestamps?['segment']:[])]}:{}),
    ...(config.asrLogprobs&&config.asrModel.startsWith('gpt-4o-')&&config.asrModel!=='gpt-4o-transcribe-diarize'?{'include[]':['logprobs']}:{})};
  };
  const http = createHttpSpeechProviders({
    ...(config.asrMode === 'compatible' ? { asr: { endpoint: config.asrEndpoint, model: config.asrModel, credentialRef: 'asr',...(openaiAsr?{encode:asrParameters}:{}) } } : {}),
    ...(config.ttsProvider !== 'volcengine' ? { tts: { endpoint: config.ttsEndpoint, model: config.ttsModel, voice: config.ttsVoice, credentialRef: 'tts',...(openaiTts?{encode:ttsParameters}:{}) } } : {}),
    resolveCredential: async kind => {
      const key=await credentials.resolve(kind,config[kind+'Endpoint'],'compatible');
      if((kind==='asr'?openaiAsr:openaiTts)&&key?.startsWith('ck_'))throw Error('MODEL_CREDENTIAL_PROVIDER_MISMATCH');
      return key;
    }, ...(fetcher ? { fetcher } : {}),
  });
  const connection = async kind => {
    const endpoint = validateProviderEndpoint(config[kind + 'Endpoint'], 'volcengine');
    const key = await credentials.resolve(kind, endpoint, 'volcengine');
    if (!key) throw Error('SPEECH_CREDENTIAL_REQUIRED');
    const resource = config[kind + 'ResourceId'];
    if (!resource || /[\r\n]/.test(resource)) throw Error('SPEECH_RESOURCE_REQUIRED');
    return { endpoint, headers: { 'X-Api-Key': key, 'X-Api-Resource-Id': resource, [kind === 'asr' ? 'X-Api-Request-Id' : 'X-Api-Connect-Id']: randomUUID() } };
  };
  return { ...http,asrFeedback:recognitionFeedback(config),
    ...(config.asrMode === 'volcengine' ? { createAsr: ({ createRecording }) => createVolcanoAsr({ createRecording, settings: () => config, recognitionContext, connection: () => connection('asr'), connect }) } : {}),
    ...(config.ttsProvider === 'volcengine' ? { openSpeechStream: async ({ signal, onAudio,onTiming,expression,onRequest }) => {
      const selected=resolveSpeechExpression(config,expression);
      // Timing is requested for playback projection, without modifying saved settings.
      if(onTiming&&!selected.ttsLatexTn){if(['seed-tts-2.0','seed-icl-2.0'].includes(selected.ttsModel))selected.ttsSubtitle=true;else if(['seed-tts-1.0','seed-icl-1.0'].includes(selected.ttsModel))selected.ttsTimestamp=true}
      return openVolcanoTts({ ...await connection('tts'), voice: config.ttsVoice, requestParams:encodeVolcanoTtsParams(selected), signal, onAudio,onTiming, onRequest,connect })
    } } : {}),
    ...(openaiTts?{streamSampleRate:24000,openSpeechStream:async({signal,onAudio,onTiming,expression,onRequest})=>{
      const endpoint=validateProviderEndpoint(config.ttsEndpoint,'compatible'),key=await credentials.resolve('tts',endpoint,'compatible');
      if(key?.startsWith('ck_'))throw Error('MODEL_CREDENTIAL_PROVIDER_MISMATCH');
      return openOpenAiTts({endpoint,key,model:config.ttsModel,voice:config.ttsVoice,...ttsParameters(expression),signal,onAudio,onTiming,onRequest,fetcher});
    }}:{}),
  };
}
