import {createHash} from 'node:crypto';
import {splitSpeechText} from '@rabilink/assistant-runtime/voice';
import {validateProviderEndpoint} from '@rabilink/desktop-voice-service/provider-profiles';

export const mobileTtsTextLimit=16000;
export const mobileTtsAudioLimit=8*1024*1024;
const rowSegmentLimit=128, cacheBytesLimit=32*1024*1024;

export function mobileCustomTtsReady(source,config,credential){
  if(source!=='custom'||config.voiceEnabled===false||!config.ttsModel||!config.ttsVoice)return false;
  if(!['compatible','volcengine'].includes(config.ttsProvider))return false;
  if(config.ttsProvider==='volcengine'&&(!config.ttsResourceId||!credential?.configured))return false;
  try{
    const endpoint=new URL(validateProviderEndpoint(config.ttsEndpoint,config.ttsProvider));
    return endpoint.origin!=='https://api.openai.com'||Boolean(credential?.configured);
  }catch{return false}
}

function validateRequest(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['sessionId','responseId','input'].includes(key)))throw Error('MOBILE_TTS_REQUEST_INVALID');
  for(const key of ['sessionId','responseId'])if(typeof request[key]!=='string'||!request[key]||request[key].length>128)throw Error('MOBILE_TTS_REQUEST_INVALID');
  if(typeof request.input!=='string'||!request.input.trim()||request.input.length>mobileTtsTextLimit)throw Error('MOBILE_TTS_TEXT_INVALID');
}

function canonicalSegments(row,details){
  const ends=details.speechSegmentEnds||[];
  const parts=[];let start=0;
  for(const end of ends){
    if(!Number.isSafeInteger(end)||end<=start||end>row.text.length)throw Error('MOBILE_TTS_REPLY_INVALID');
    parts.push(...splitSpeechText(row.text.slice(start,end),true).parts);start=end;
  }
  parts.push(...splitSpeechText(row.text.slice(start),row.status!=='generating').parts);
  return parts;
}

function pcmWave(bytes,sampleRate){
  if(!bytes.length||bytes.length%2||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000)throw Error('MOBILE_TTS_AUDIO_INVALID');
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(bytes.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);
  header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(bytes.length,40);
  return Buffer.concat([header,bytes]);
}

async function renderWav(provider,config,input,expression,signal,onRequest){
  if(!provider.openSpeechStream)return provider.synthesize(input,signal,expression,{onRequest});
  let stream,bytes=0;const chunks=[];
  try{
    stream=await provider.openSpeechStream({signal,expression,onRequest,onAudio(value){
      signal.throwIfAborted();bytes+=value.byteLength;
      if(bytes>mobileTtsAudioLimit-44)throw Error('MOBILE_TTS_AUDIO_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }});
    signal.throwIfAborted();await stream.append(input);await stream.finish();await stream.finished;signal.throwIfAborted();
    return pcmWave(Buffer.concat(chunks,bytes),provider.streamSampleRate??config.ttsSampleRate??24000);
  }finally{await stream?.close()}
}

function waitForResult(promise,signal){
  signal?.throwIfAborted();
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

/** Paid synthesis belongs to a current assistant row, never to arbitrary mobile text/settings. */
export function createMobileTts({conversation,settings,ready,createProviders,assertCurrent,signal}){
  let closed=false,scope,active,cacheBytes=0;
  const receipts=new Map();
  const configuration=()=>JSON.stringify(settings());
  const latestReply=()=>conversation.messages().findLast(row=>row.role==='assistant'&&!row.notice);
  function invalidate(){scope?.abort();scope=undefined;receipts.clear();cacheBytes=0;}
  function currentScope(){
    assertCurrent();if(closed)throw Error('ASSISTANT_CLOSED');
    const sessionId=conversation.getSessionId(),responseId=latestReply()?.id,fingerprint=configuration();
    if(scope?.sessionId!==sessionId||scope?.responseId!==responseId||scope?.fingerprint!==fingerprint){invalidate();scope=Object.assign(new AbortController(),{sessionId,responseId,fingerprint});}
    return scope;
  }
  const unsubscribe=conversation.subscribe?.(()=>{
    if(scope&&(scope.sessionId!==conversation.getSessionId()||scope.responseId!==latestReply()?.id))invalidate();
  });
  return {
    invalidate,
    async synthesize(request,requestSignal){
      validateRequest(request);requestSignal?.throwIfAborted();
      const owned=currentScope(),config=structuredClone(settings());
      const guard=()=>{
        assertCurrent();if(closed)throw Error('ASSISTANT_CLOSED');
        if(scope!==owned||owned.signal.aborted||request.sessionId!==conversation.getSessionId()||latestReply()?.id!==owned.responseId||configuration()!==owned.fingerprint)throw Error('ASSISTANT_CONTEXT_CHANGED');
      };
      guard();if(!await ready(config))throw Error('MOBILE_TTS_UNAVAILABLE');guard();
      if(request.responseId!==owned.responseId)throw Error('MOBILE_TTS_REPLY_EXPIRED');
      const row=conversation.messages().find(item=>item.id===request.responseId&&item.role==='assistant'&&!item.notice);
      if(!row||!row.text?.trim()||!['generating','completed'].includes(row.status))throw Error('MOBILE_TTS_REPLY_INVALID');
      const details=conversation.messageDetails(row.id);
      if(!canonicalSegments(row,details).includes(request.input))throw Error('MOBILE_TTS_SEGMENT_INVALID');
      const expression=structuredClone(row.expression??details.expression);
      const assertReply=()=>{
        const latest=conversation.messages().find(item=>item.id===row.id&&item.role==='assistant'&&!item.notice);
        if(!latest||!['generating','completed'].includes(latest.status)||!canonicalSegments(latest,conversation.messageDetails(row.id)).includes(request.input)||JSON.stringify(latest.expression??conversation.messageDetails(row.id).expression)!==JSON.stringify(expression))throw Error('MOBILE_TTS_REPLY_CHANGED');
      };
      const key=createHash('sha256').update(JSON.stringify([row.id,request.input,expression])).digest('hex');
      let receipt=receipts.get(key);
      if(!receipt){
        if(active)throw Error('MOBILE_TTS_BUSY');
        if(receipts.size>=rowSegmentLimit)throw Error('MOBILE_TTS_SEGMENT_LIMIT');
        const abort=AbortSignal.any([signal,owned.signal,AbortSignal.timeout(60000)]);
        receipt={responseId:row.id};receipts.set(key,receipt);active=receipt;
        const onRequest=event=>{try{guard();conversation.recordSpeechDetails(row.id,{type:'request',...event,requestId:key+':'+event.requestId})}catch{/* Retired rows cannot receive late provider details. */}};
        receipt.promise=(async()=>{
          try{
            guard();abort.throwIfAborted();
            // Known stream adapters emit mono PCM16. WAV is the mobile transport, not a saved preference.
            const streamConfig={...config,ttsEncoding:'pcm'};
            const provider=createProviders(streamConfig);
            const wav=Buffer.from(await renderWav(provider,streamConfig,request.input,expression,abort,onRequest));
            guard();assertReply();abort.throwIfAborted();
            if(wav.length>mobileTtsAudioLimit)throw Error('MOBILE_TTS_AUDIO_TOO_LARGE');
            if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.readUInt32LE(4)+8!==wav.length)throw Error('MOBILE_TTS_AUDIO_INVALID');
            receipt.audio=wav;cacheBytes+=wav.length;
            for(const older of receipts.values()){
              if(cacheBytes<=cacheBytesLimit)break;
              if(older===receipt||!older.audio)continue;
              cacheBytes-=older.audio.length;older.audio=undefined;
            }
          }catch(error){receipt.error=/^(?:ASSISTANT|MOBILE|SPEECH)_[A-Z0-9_]+$/.test(error?.message)?error.message:'MOBILE_TTS_FAILED';throw Error(receipt.error)}
          finally{if(active===receipt)active=undefined}
        })();
        void receipt.promise.catch(()=>{});
      }
      await waitForResult(receipt.promise,requestSignal);requestSignal?.throwIfAborted();guard();assertReply();
      if(!receipt.audio)throw Error(receipt.error||'MOBILE_TTS_RESULT_EXPIRED');
      return Buffer.from(receipt.audio);
    },
    async dispose(){closed=true;unsubscribe?.();invalidate();await active?.promise.catch(()=>{});},
  };
}
