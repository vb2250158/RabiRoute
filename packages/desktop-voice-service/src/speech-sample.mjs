import {setTimeout as delay} from 'node:timers/promises';
/** Feed a bundled sample through the selected provider's existing PCM adapter. No microphone is opened. */
export async function recognizeStreamSample({createAsr,audio,signal,timeoutMs=15000,endInput=true}) {
  const bytes=Buffer.from(audio);let pcm,format;
  if(bytes.length<44||bytes.length>4*1024*1024||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('SPEECH_SAMPLE_FORMAT');
  for(let offset=12;offset+8<=bytes.length;){const size=bytes.readUInt32LE(offset+4),start=offset+8;if(start+size>bytes.length)throw Error('SPEECH_SAMPLE_FORMAT');
    const id=bytes.toString('ascii',offset,offset+4);if(id==='fmt '){if(size<16)throw Error('SPEECH_SAMPLE_FORMAT');format={codec:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),bits:bytes.readUInt16LE(start+14)}}
    if(id==='data')pcm=bytes.subarray(start,start+size);offset=start+size+(size%2);
  }
  if(!pcm||!format||format.codec!==1||format.channels!==1||format.rate!==16000||format.bits!==16)throw Error('SPEECH_SAMPLE_FORMAT');
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.throwIfAborted();signal?.addEventListener('abort',cancel,{once:true});
  let round,asr,feeding,done,fail;
  const result=new Promise((resolve,reject)=>{done=resolve;fail=reject});void result.catch(()=>{});
  const timer=setTimeout(()=>{fail(Error('ASR_SAMPLE_TIMEOUT'));controller.abort()},timeoutMs);
  const recording={async start(_onError,{onPcm}){feeding=(async()=>{const input=Buffer.concat([pcm,Buffer.alloc(64000)]);for(let i=0;!controller.signal.aborted&&(i<input.length||!endInput);i+=4096){onPcm(i<input.length?input.subarray(i,i+4096):Buffer.alloc(4096));await delay(128,undefined,{signal:controller.signal})}})().catch(error=>{if(!controller.signal.aborted)fail(error)})},amplitude:()=>0,async dispose(){controller.abort();await feeding}};
  const aborted=()=>fail(Error('ASR_SAMPLE_CANCELLED'));controller.signal.addEventListener('abort',aborted,{once:true});
  try {asr=createAsr({createRecording:()=>recording});round=asr.createRound({onFinal:value=>{if(value.text?.trim())done({text:value.text})},onError:fail,onEnd:()=>fail(Error('ASR_TEST_EMPTY'))});
    await asr.start(round);if(endInput&&typeof asr.finish==='function')void feeding.then(()=>{if(!controller.signal.aborted)return asr.finish(round)}).catch(fail);return await result;
  } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);controller.abort();signal?.removeEventListener('abort',cancel);if(round)await asr.stop(round);await feeding}
}
