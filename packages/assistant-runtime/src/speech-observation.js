/** Snapshot only utterance-scoped data; never promote provider output to instructions. */
export function snapshotSpeechObservation(value){
 if(value===undefined)return undefined;
 const invalid=()=>{throw Object.assign(Error('ASSISTANT_SPEECH_OBSERVATION_INVALID'),{code:'ASSISTANT_SPEECH_OBSERVATION_INVALID'})};
 if(!value||typeof value!=='object'||Array.isArray(value)||value.source!=='speech-recognition'||Object.keys(value).some(key=>!['source','provider','model','estimates'].includes(key)))invalid();
 if(!value.estimates||typeof value.estimates!=='object'||Array.isArray(value.estimates))invalid();
 const entries=Object.entries(value.estimates);if(!entries.length||entries.length>32)invalid();
 for(const [key,item]of entries)if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||!['string','number','boolean'].includes(typeof item)||typeof item==='string'&&item.length>256||typeof item==='number'&&!Number.isFinite(item))invalid();
 const result={source:'speech-recognition',estimates:Object.fromEntries(entries)};
 for(const key of ['provider','model'])if(value[key]!==undefined){if(typeof value[key]!=='string'||value[key].length>256)invalid();result[key]=value[key]}
 return result;
}
