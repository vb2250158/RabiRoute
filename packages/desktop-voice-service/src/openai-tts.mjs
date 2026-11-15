import {splitSpeechText} from '@rabilink/assistant-runtime/voice';
import {notifySpeechObserver} from './speech-details.mjs';

/** OpenAI takes sentence requests; PCM bodies stream into the same cancellable player. */
export function openOpenAiTts({endpoint,key,model,voice,speed=1,instructions,signal,onAudio,onTiming,onRequest,fetcher=fetch}){
 const cancel=new AbortController(),requestSignal=AbortSignal.any([cancel.signal,...(signal?[signal]:[])]);
 let buffer='',closed=false,ended=false,chars=0,samples=0,chain=Promise.resolve(),resolve,reject,sequence=0,submittedText='',textCursor=0;
 const finished=new Promise((yes,no)=>{resolve=yes;reject=no});void finished.catch(()=>{});
 const cancelled=()=>{closed=true;reject(Error('SPEECH_STREAM_CANCELLED'))};requestSignal.addEventListener('abort',cancelled,{once:true});
 const enqueue=text=>{
   chain=chain.then(async()=>{
     requestSignal.throwIfAborted();
     const requestId=++sequence,parameters={model,voice:voice.startsWith('voice_')?{id:voice}:voice,input:text,response_format:'pcm',speed,...(instructions?{instructions}:{})};
     const charIndex=submittedText.indexOf(text,textCursor),startTime=samples/24000;textCursor=Math.max(textCursor,charIndex+text.length);
     const pending=fetcher(endpoint,{method:'POST',redirect:'error',signal:requestSignal,headers:{'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{})},body:JSON.stringify(parameters)});
     notifySpeechObserver(onRequest,{requestId,protocol:'openai-pcm',stage:'sent',parameters});
     const response=await pending;
     notifySpeechObserver(onRequest,{requestId,protocol:'openai-pcm',stage:response.ok?'accepted':'failed',parameters,...(!response.ok?{error:'SPEECH_PROVIDER_HTTP_'+response.status}:{})});
     if(!response.ok)throw Error('SPEECH_PROVIDER_HTTP_'+response.status);
     const reader=response.body?.getReader();if(!reader)throw Error('SPEECH_PROVIDER_EMPTY');
     let carry=Buffer.alloc(0),bytes=0;
     try{for(;;){const value=await reader.read();if(value.done)break;requestSignal.throwIfAborted();bytes+=value.value.length;if(bytes>16*1024*1024)throw Error('SPEECH_PROVIDER_LIMIT');
       const pcm=Buffer.concat([carry,Buffer.from(value.value)]),length=pcm.length-pcm.length%2;carry=pcm.subarray(length);
       if(length){await onAudio(pcm.subarray(0,length));samples+=length/2}
     }if(carry.length)throw Error('SPEECH_PCM_INVALID');}
     finally{await reader.cancel();reader.releaseLock()}
     if(charIndex>=0&&samples/24000>startTime)onTiming?.([{charIndex,charLength:text.length,startTime,endTime:samples/24000,mode:'sentence'}]);
   });
   void chain.catch(error=>{reject(error);cancel.abort()});
 };
 const flush=final=>{const parts=splitSpeechText(buffer,final);buffer=parts.rest;for(const part of parts.parts)enqueue(part);
   while(buffer.length>=320){const space=buffer.lastIndexOf(' ',320),end=space>=160?space+1:320;enqueue(buffer.slice(0,end));buffer=buffer.slice(end)}
 };
 return {finished,
   async append(text){if(closed||ended)throw Error('SPEECH_STREAM_CLOSED');if(typeof text!=='string'||chars+text.length>16000)throw Error('SPEECH_TEXT_INVALID');chars+=text.length;buffer+=text;submittedText+=text;flush(false)},
   async finish(){if(closed||ended)return;ended=true;flush(true);void chain.then(()=>{requestSignal.removeEventListener('abort',cancelled);if(!closed)resolve({duration:samples/24000})},reject)},
   async close(){if(!closed){closed=true;cancel.abort();reject(Error('SPEECH_STREAM_CANCELLED'))}await chain.catch(()=>{});requestSignal.removeEventListener('abort',cancelled)},
 };
}
