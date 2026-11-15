/** ASR context is a bounded projection of this conversation, never a second history store. */
export function recognitionContextMessages(values){
 if(!Array.isArray(values))return [];
 const item=values.toReversed().find(value=>['assistant','bot'].includes(value?.role||value?.speaker)&&typeof(value.text??value.content)==='string'&&(value.text??value.content).trim());
 return item?[{speaker:'bot',text:(item.text??item.content).slice(0,2048)}]:[];
}
export function recognitionContextPrompt(config,values){
 if(config.asrUseContext===false)return config.asrPrompt||'';
 return [config.asrHotwords, ...recognitionContextMessages(values).map(item=>item.text)].filter(Boolean).join('\n').slice(0,4096);
}
