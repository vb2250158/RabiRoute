import {mobileAsrAudioLimit,mobileAsrDurationMs} from './mobile-asr-stream.mjs';
import {mobileTtsAudioLimit,mobileTtsTextLimit} from './mobile-tts.mjs';

const object={type:'object'},response={mediaType:'application/json',schema:{type:'object',additionalProperties:true}};
const mobileSessionId={type:'string',minLength:1,maxLength:128};
const mobileTranscribeLimit=2_100_000;

async function readMobileAudio(body, signal) {
  signal?.throwIfAborted();
  if (body instanceof Uint8Array) return body.byteLength <= mobileTranscribeLimit ? body : null;
  const chunks = [];
  let length = 0;
  const abort = () => body.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of body.iterator({ destroyOnReturn: false })) {
      signal?.throwIfAborted();
      length += chunk.byteLength;
      if (length > mobileTranscribeLimit) return null;
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, length);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function createVoiceAssistantOperations(owner,run){
  const operations=[['state','GET'],['messages','GET'],['command','POST'],['scan','GET']].map(([action,method])=>({
    discovery:{title:'语音助手 · '+action,category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.'+action,contractVersion:'1.0.0',method,pathTemplate:'/api/voice-assistant/'+action,exposure:'public',transport:'http',description:'Access the plugin-owned shared assistant session; stopping it never exits Rabi PC.',
      request:{path:object,query:['messages','state'].includes(action)?{...object,properties:{view:{enum:['mobile']}}}:object,headers:object,body:method==='POST'?{kind:'json',schema:{type:'object',required:['action'],properties:{action:{type:'string'}},additionalProperties:true},maxBytes:131072}:{kind:'none'}},responses:{200:response,400:response,409:response,503:response},
      effects:{mode:method==='GET'?'read':'native-assistant-command',description:'The assistant lifecycle, private settings and context retain their original owner. Tools keep their own receipts.'},recovery:{strategy:'original-session-readback',description:'Read state and messages using the original session and request ID. Never replay a tool after an unknown result.'},validators:[{id:'current-assistant-owner',description:'Current plugin activation and original Manager identity must remain current.'}]},
    async handler(input){try{return await run(async()=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await(action==='command'?owner.command(input.body):action==='scan'?owner.agent.operations.scan():action==='messages'?owner.messages(input.query?.view):owner.state(input.query?.view))}}))}catch(error){return {status:409,body:{code:-1,message:error.message}}}}
  }));
  operations.push({
    discovery:{title:'移动端实时语音识别',category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.mobile-asr',contractVersion:'1.0.0',method:'POST',pathTemplate:'/api/voice-assistant/mobile-asr',exposure:'public',transport:'http',
      description:'Recognize one mobile microphone stream with the active assistant provider. Credentials stay with the Manager owner.',
      request:{path:object,query:{type:'object',required:['sessionId'],properties:{sessionId:mobileSessionId},additionalProperties:false},headers:object,
        body:{kind:'stream',mediaType:'application/octet-stream',maxBytes:mobileAsrAudioLimit,rules:['PCM16 little endian, 16000 Hz, mono']},deadlineMs:mobileAsrDurationMs},
      responses:{200:{mediaType:'application/x-ndjson',stream:{framing:'bytes',maxFrameBytes:128*1024,maxBytes:16*1024*1024,completion:'Provider final frames followed by EOF.',cancellation:'Close the original recognition round and release the provider socket.'}},409:response},
      effects:{mode:'native-assistant-recognition',description:'Send user microphone samples through the explicitly configured assistant recognition provider.'},
      recovery:{strategy:'no-automatic-replay',description:'Open a new recognition stream after a failed transport.'},
      validators:[{id:'current-assistant-owner',description:'The original session and activation must remain current.'}]},
    async handler(input){
      try {
        const stream=await run(()=>owner.openMobileAsr({request:input.body,sessionId:input.query.sessionId,signal:input.signal}));
        return {status:200,headers:{'content-type':'application/x-ndjson','cache-control':'no-store'},stream};
      } catch(error) {
        const message=/^(?:ASSISTANT|MOBILE)_[A-Z_]+$/.test(error?.message)?error.message:'MOBILE_STREAM_ASR_FAILED';
        return {status:409,body:{code:-1,message}};
      }
    },
  });
  operations.push({
    discovery:{title:'移动端整句语音识别',category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.mobile-transcribe',contractVersion:'1.0.0',method:'POST',pathTemplate:'/api/voice-assistant/mobile-transcribe',exposure:'public',transport:'http',
      description:'Transcribe one WAV with the active assistant settings, or with the host-local recognizer for passive listening and fallback.',
      request:{path:object,query:{...object,required:['sessionId','source'],properties:{sessionId:mobileSessionId,source:{enum:['active','local']}},additionalProperties:false},
        headers:object,body:{kind:'binary',mediaType:'audio/wav',maxBytes:mobileTranscribeLimit}},
      responses:{200:response,409:response,413:response},
      effects:{mode:'native-assistant-recognition',description:'Send audio to the configured recognition provider. Local requests use the current Manager-owned private transcription channel with a verified local worker.'},
      recovery:{strategy:'no-automatic-replay',description:'Start a new utterance after a failed request.'},
      validators:[{id:'current-assistant-owner',description:'The original session and activation must remain current.'}]},
    async handler(input){
      try {
        return await run(async()=>{
          const audio=await readMobileAudio(input.body,input.signal);
          if(audio===null) return {status:413,body:{code:-1,message:'MOBILE_ASR_AUDIO_TOO_LARGE'}};
          const body=await owner.transcribeMobile({audio,...input.query,signal:input.signal});
          return {status:200,headers:{'cache-control':'no-store'},body};
        });
      } catch(error) {
        const message=/^(?:ASSISTANT|MOBILE)_[A-Z_]+$/.test(error?.message)?error.message:'MOBILE_ASR_FAILED';
        return {status:409,body:{code:-1,message}};
      }
    },
  });
  operations.push({
    discovery:{title:'移动端助手语音播报',category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.mobile-tts',contractVersion:'1.0.0',method:'POST',pathTemplate:'/api/voice-assistant/mobile-tts',exposure:'public',transport:'http',
      description:'Synthesize one canonical segment of a current assistant reply through its saved custom TTS provider. No caller-selected text, voice, endpoint or credentials.',
      request:{path:object,query:{...object,additionalProperties:false},headers:object,deadlineMs:65000,
        body:{kind:'json',maxBytes:131072,schema:{type:'object',required:['sessionId','responseId','input'],properties:{sessionId:mobileSessionId,responseId:mobileSessionId,input:{type:'string',minLength:1,maxLength:mobileTtsTextLimit}},additionalProperties:false}}},
      responses:{200:{mediaType:'audio/wav',binary:{minBytes:44,maxBytes:mobileTtsAudioLimit}},409:response},
      effects:{mode:'native-assistant-synthesis',description:'Use the configured provider quota only for authoritative assistant reply segments; matching requests share the original receipt.'},
      recovery:{strategy:'original-session-segment-readback',description:'Repeat only the same session, assistant row and segment to retrieve the cached result or original failure. Do not re-synthesize unknown provider outcomes.'},
      validators:[{id:'current-assistant-owner',description:'The session, activation, saved configuration and authoritative reply remain current before and after synthesis.'}]},
    async handler(input){
      try{return await run(async()=>({status:200,headers:{'content-type':'audio/wav','cache-control':'no-store'},body:await owner.synthesizeMobile(input.body,input.signal)}));}
      catch(error){const message=/^(?:ASSISTANT|MOBILE|SPEECH)_[A-Z0-9_]+$/.test(error?.message)?error.message:'MOBILE_TTS_FAILED';return{status:409,body:{code:-1,message}};}
    },
  });
  return operations;
}
