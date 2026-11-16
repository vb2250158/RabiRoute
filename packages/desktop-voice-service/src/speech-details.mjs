import {selectedSpeechCatalog} from './tts-expression.mjs';

const privateKey=/authorization|headers?|token|secret|password|api.?key|credential|cookie|^(audio(?:_url|_data|_base64)?|file|reference_audio|__proto__|prototype|constructor)$/i;
/** Bounded, local diagnostic values. Transport credentials and audio never enter messages. */
export function safeSpeechDetails(value){
 let budget=16000,nodes=512;
 const visit=(item,depth)=>{
  if(--nodes<0||budget<=0||depth>6)return '[已截断]';
  if(item===null||typeof item==='boolean')return item;
  if(typeof item==='number')return Number.isFinite(item)?item:null;
  if(typeof item==='string'){const text=item.slice(0,Math.min(4096,budget));budget-=text.length;return text+(text.length<item.length?'…[已截断]':'')}
  if(Array.isArray(item))return item.slice(0,64).map(v=>visit(v,depth+1));
  if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).slice(0,64).map(([key,v])=>[key.slice(0,128),privateKey.test(key)?'[已隐藏]':visit(v,depth+1)]));
  return undefined;
 };return visit(value,0);
}
export function asrMessageDetails(config,result={}){
 result=result&&typeof result==='object'?result:{text:typeof result==='string'?result:''};
 const catalog=selectedSpeechCatalog(config,'asr');
 return safeSpeechDetails({kind:'asr',provider:config.asrMode,model:config.asrModel,mode:config.asrRecognitionMode,resource:config.asrResourceId,
  capturedAt:new Date().toISOString(),
  features:(catalog?.parameters||[]).filter(p=>p.type==='boolean'&&config[p.key]).map(p=>({key:p.key,label:p.label})),
  result:result.providerDetails?.result||result,
  request:result.providerDetails?.request,
 });
}
export function ttsRequestEvent(config,expression,event){
 return safeSpeechDetails({...event,kind:'tts',provider:config.ttsProvider,model:config.ttsModel,voice:config.ttsVoice,
  resource:config.ttsResourceId,expression,at:new Date().toISOString()});
}
export function notifySpeechObserver(callback,value){
 try{const result=callback?.(value);if(result?.then)void result.catch(()=>{})}catch{}
}

/** Only semantic ASR return values enter model context; transport diagnostics stay local. */
export function asrAgentContext(details){
 if(details?.kind!=='asr'||!details.result||typeof details.result!=='object')return undefined;
 const keys=['emotion','emotion_score','emotion_degree','emotion_degree_score','gender','gender_score','age','age_score','speaker_id','speaker','language','language_probability','lid_lang','lid_lang_score','speech_rate','volume','confidence','avg_logprob','no_speech_prob'];
 const values={...details.result,...details.result.additions},estimates={};
 for(const key of keys){const value=values[key];if(typeof value==='string'&&value&&value!=='[已隐藏]'&&value.length<=256||typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')estimates[key]=value}
 if(!Object.keys(estimates).length)return undefined;
 return {source:'speech-recognition',...(typeof details.provider==='string'?{provider:details.provider.slice(0,256)}:{}),...(typeof details.model==='string'?{model:details.model.slice(0,256)}:{}),estimates};
}
