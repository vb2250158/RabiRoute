import {boundedDictionary} from './asr-dictionary.mjs';

/** ASR context is a bounded projection of this conversation, never a second history store. */
export function recognitionContextMessages(values){
 if(!Array.isArray(values))return [];
 const item=values.toReversed().find(value=>['assistant','bot'].includes(value?.role||value?.speaker)&&typeof(value.text??value.content)==='string'&&(value.text??value.content).trim());
 return item?[{speaker:'bot',text:(item.text??item.content).slice(0,2048)}]:[];
}
export function recognitionContextPrompt(config,values){
 const maxBytes = config.asrModel === 'whisper-1' ? 224 : 4096;
 const terms = boundedDictionary(config.asrDictionary, {maxBytes});
 const context = config.asrUseContext === false ? config.asrPrompt : recognitionContextMessages(values)[0]?.text;
 if (context) {
   let remaining = maxBytes - Buffer.byteLength(terms.join('\n')) - (terms.length ? 1 : 0);
   let tail = '';
   for (const char of context) {
     remaining -= Buffer.byteLength(char);
     if (remaining < 0) break;
     tail += char;
   }
   if (tail) terms.push(tail);
 }
 return terms.join('\n');
}
