import fields from './expression-fields.json' with {type:'json'};
import openaiCatalog from './openai-speech-catalog.json' with {type:'json'};
import {normalizeSpeechExpression} from '@rabilink/assistant-runtime/voice';
import {volcanoCatalog,parameterEnabled} from './speech-catalog.mjs';

export {openaiCatalog};
export function selectedSpeechCatalog(config,kind='tts'){
 const provider=kind==='tts'?config.ttsProvider:config.asrMode;
 if(provider==='volcengine')return volcanoCatalog[kind];
 if(provider!=='compatible')return null;
 try{if(new URL(config[kind+'Endpoint']).origin==='https://api.openai.com')return openaiCatalog[kind]}catch{}
 return null;
}
export function speechExpressionPolicy(config){
 const catalog=selectedSpeechCatalog(config),voice=catalog?.voices?.find(v=>v.id===config.ttsVoice&&v.model===config.ttsModel),selected=[];
 if(catalog&&catalog.models.some(m=>m.id===config.ttsModel&&m.supported)){
   for(const field of fields){
     const parameter=catalog.parameters.find(p=>p.key===field.setting);
     if(field.id==='rate'){selected.push({...field});continue}
     if(!parameter||!parameterEnabled({...parameter,enabledWhen:undefined},config))continue;
     if(field.id==='emotion'){if(voice?.emotions?.length)selected.push({...field,values:voice.emotions.map(e=>e.id)});continue}
     if(field.id==='intensity'){if(selected.some(f=>f.id==='emotion'))selected.push({...field});continue}
     selected.push({...field});
   }
 }
 return {enabled:Boolean(config.ttsDynamicExpression&&selected.length),fields:selected};
}
/** Per-call expression overrides never mutate persisted user preferences. */
export function resolveSpeechExpression(config,expression){
 const value=normalizeSpeechExpression(expression,speechExpressionPolicy(config)),next={...config};
 if(speechExpressionPolicy(config).enabled){next.ttsContextText='';next.ttsEmotion=''}
 if(value.style!==undefined)next.ttsContextText=value.style;
 if(value.emotion!==undefined)next.ttsEmotion=value.emotion;
 if(value.intensity!==undefined&&value.emotion!==undefined)next.ttsEmotionScale=value.intensity;
 if(value.pitch!==undefined)next.ttsPitch=value.pitch;
 if(value.rate!==undefined){
   next.ttsSpeed=Math.min(4,Math.max(.25,(config.ttsSpeed||1)*value.rate));
   next.ttsSpeechRate=Math.min(100,Math.max(-50,Math.round(((1+(config.ttsSpeechRate||0)/100)*value.rate-1)*100)));
 }
 return next;
}
