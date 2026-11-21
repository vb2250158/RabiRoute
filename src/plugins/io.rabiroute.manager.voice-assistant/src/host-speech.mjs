import {boundedDictionary} from '@rabilink/desktop-voice-service/speech-providers';

/** Only fields declared by the selected model and accepted by Manager's speech API are callable. */
export function hostSpeechDefaultModel(kind,models,status,preferredModel){
 const ready=models.filter(item=>item.capability===kind&&item.enabled&&item.available),provider=status?.defaults?.[kind];
 const entries=Array.isArray(status?.providers?.[kind])?status.providers[kind]:[];
 const current=entries.find(item=>item.id===provider),model=current?.model;
 return ready.find(item=>item.id===preferredModel)?.id||ready.find(item=>item.id===model||item.id===(provider+'/'+model))?.id||ready[0]?.id;
}
// The shared service schema includes optional instructions even for fixed-voice
// engines. Require a model capability too; ONNX-VITS ignores that input.
function supportsInstructions(model){return Array.isArray(model?.features)&&model.features.some(feature=>feature==='instructions'||feature==='emotion_control')&&Boolean(model.request?.properties?.instructions)}
export function hostSpeechExpressionPolicy(model,config){
 const properties=model?.request?.properties||{},fields=[];
 if(supportsInstructions(model))fields.push({id:'style',label:'语气与风格',type:'text',maxLength:Math.min(512,properties.instructions.maxLength||512)});
 if(properties.speed)fields.push({id:'rate',label:'临时语速比例',type:'number',min:.75,max:1.4});
 return {enabled:Boolean(config.ttsDynamicExpression&&fields.length),fields};
}
export function hostSpeechCommand({model,persona,text,expression={},sessionId}){
 const properties=model?.request?.properties||{},speed=(persona.speed||1)*(properties.speed?expression.rate||1:1);
 return {model:model.id,input:text,voice:persona.id,responseFormat:'wav',play:false,
  speed:Math.min(properties.speed?.maximum??4,Math.max(properties.speed?.minimum??.25,speed)),
  instructions:supportsInstructions(model)?expression.style||persona.instructions||null:null,language:persona.language||null,sessionId:sessionId||null,routeId:null};
}
export function hostSpeechModelSummary(model){
 return {id:model.id,name:model.name,capability:model.capability,provider:model.provider,enabled:model.enabled,available:model.available,features:model.features||[],note:model.note,
  requestFields:Object.entries(model.request?.properties||{}).map(([id,value])=>({id,type:value.type,description:value.description||null}))};
}

function dictionaryField(model) {
  const field = model?.request?.properties?.prompt?.['x-rabi-dictionary'];
  return ['prompt','context'].includes(field?.format) &&
    Number.isSafeInteger(field.maxBytes) && field.maxBytes > 0 && field.maxBytes <= 4096 ? field : null;
}

export function hostAsrDictionaryPolicy(model) {
  const field = dictionaryField(model);
  return field ? {format:field.format,mode:'utterance',local:field.local !== false} : null;
}

export function hostAsrDictionaryPrompt(model, value) {
  const field = dictionaryField(model);
  return field ? boundedDictionary(value,field).join('\n') : '';
}
