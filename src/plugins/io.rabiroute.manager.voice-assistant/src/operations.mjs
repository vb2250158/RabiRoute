import {mobileAsrAudioLimit,mobileAsrDurationMs} from './mobile-asr-stream.mjs';
import {mobileTtsAudioLimit,mobileTtsTextLimit} from './mobile-tts.mjs';
import {localModelSettingsRequestAllowed} from '@rabiroute/host-api/manager/speechModelSettingsAccess';

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

export function createVoiceAssistantOperations(owner,run,identity){
  const operations=[['state','GET'],['messages','GET'],['command','POST'],['scan','GET']].map(([action,method])=>({
    discovery:{title:'语音助手 · '+action,category:{id:'voice-assistant',title:'语音助手'},provider:'voice-assistant'},
    contract:{operationId:'manager.voice-assistant.'+action,contractVersion:'1.0.0',method,pathTemplate:'/api/voice-assistant/'+action,exposure:'public',transport:'http',description:'Access the plugin-owned shared assistant session; stopping it never exits Rabi PC.',
      request:{path:object,query:['messages','state'].includes(action)?{...object,properties:{view:{enum:['mobile']}}}:object,headers:object,body:method==='POST'?{kind:'json',schema:{type:'object',required:['action'],properties:{action:{type:'string'}},additionalProperties:true},maxBytes:131072}:{kind:'none'}},responses:{200:response,400:response,409:response,503:response},
      effects:{mode:method==='GET'?'read':'native-assistant-command',description:'The assistant lifecycle, private settings and context retain their original owner. Tools keep their own receipts.'},recovery:{strategy:'original-session-readback',description:'Read state and messages using the original session and request ID. Never replay a tool after an unknown result.'},validators:[{id:'current-assistant-owner',description:'Current plugin activation and original Manager identity must remain current.'}]},
    async handler(input){try{return await run(async()=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await(action==='command'?owner.command(input.body):action==='scan'?owner.agent.operations.scan():action==='messages'?owner.messages(input.query?.view):owner.state(input.query?.view))}}))}catch(error){return {status:409,body:{code:-1,message:error.message}}}}
  }));
  for (const method of ['GET','POST']) {
    const write=method==='POST';
    operations.push({
      discovery:{title:write?'保存 API 模型服务':'读取 API 模型服务',category:{id:'model-services',title:'模型服务'},provider:'voice-assistant'},
      contract:{operationId:'manager.model-services.api-models.'+(write?'save':'read'),contractVersion:'1.0.0',method,
        pathTemplate:'/api/model-services/api-models',exposure:'public',transport:'http',
        description:'Manage named API connections and their write-only credentials on this Manager.',
        request:{path:object,query:object,headers:object,body:write?{kind:'json',maxBytes:16384,schema:{type:'object',required:['kind','name','provider'],properties:{
          id:{type:'string',maxLength:64},kind:{enum:['llm','asr','tts','search','speaker','image','video']},name:{type:'string',minLength:1,maxLength:128},provider:{type:'string',maxLength:40},
          endpoint:{type:'string',maxLength:2048},model:{type:'string',maxLength:256},resourceId:{type:'string',maxLength:256},voice:{type:'string',maxLength:256},recognitionMode:{type:'string',maxLength:30},apiKey:{type:'string',maxLength:8192,writeOnly:true}
        },additionalProperties:false}}:{kind:'none'}},
        responses:{200:response,400:response,403:response,409:response},
        effects:{mode:write?'native-model-service-save':'read',description:'The local configuration owner validates the endpoint and stores credentials encrypted; responses never include keys.'},
        recovery:{strategy:'read-back',description:'Reload the API model list from the same Manager before retrying an unconfirmed save.'},
        validators:[{id:'model-service-connection',description:'Authenticated connection, current Manager identity, supported protocol and exact credential destination.'}]},
      async handler(input){
        const headers={'cache-control':'no-store'};
        const guard=()=>{
          input.signal?.throwIfAborted();
          if(!localModelSettingsRequestAllowed(input.request))throw Error('MODEL_SERVICE_ACCESS_DENIED');
          if(write&&(input.request.headers['x-rabiroute-expected-application-generation-id']!==identity?.applicationGenerationId
            ||input.request.headers['x-rabiroute-expected-manager-instance-id']!==identity?.managerInstanceId))throw Error('MODEL_SERVICE_MANAGER_CHANGED');
        };
        try { return await run(async()=>{
          guard();
          const data=write?await owner.saveModelService(input.body,guard):await owner.modelServices();
          return {status:200,headers,body:{code:0,data}};
        }); }
        catch(error){
          const message=/^(?:MODEL_SERVICE|ASSISTANT|SPEECH)_[A-Z0-9_]{1,100}$/.test(error?.message)?error.message:'MODEL_SERVICE_OPERATION_FAILED';
          return {status:message==='MODEL_SERVICE_ACCESS_DENIED'?403:409,headers,body:{code:-1,message}};
        }
      },
    });
  }
  operations.push({
    discovery:{title:'列出可用模型',category:{id:'model-services',title:'模型服务'},provider:'voice-assistant'},
    contract:{operationId:'manager.model-services.models.read',contractVersion:'1.0.0',method:'GET',
      pathTemplate:'/api/model-services/models',exposure:'public',transport:'http',
      description:'List selectable model IDs from the selected group for a common model capability.',
      request:{path:object,query:{...object,required:['kind','group'],properties:{
        kind:{enum:['llm','search','asr','tts','backgroundAsr']},group:{type:'string',minLength:1,maxLength:205}
      },additionalProperties:false},headers:object,body:{kind:'none'}},
      responses:{200:response,403:response,409:response},
      effects:{mode:'read',description:'Read model labels, public references and availability without returning credentials.'},
      recovery:{strategy:'repeatable-read',description:'Read again when the selected group or computer changes.'},
      validators:[{id:'model-service-connection',description:'Verify the requesting connection and route the lookup through the current model owner.'}]},
    async handler(input) {
      const headers={'cache-control':'no-store'};
      if(!localModelSettingsRequestAllowed(input.request))return {status:403,headers,body:{code:-1,message:'MODEL_SERVICE_ACCESS_DENIED'}};
      try {
        return await run(async()=>({status:200,headers,body:{code:0,data:await owner.modelOptions(input.query.kind,input.query.group)}}));
      } catch(error) {
        const message=error?.message==='MODEL_SERVICE_NOT_FOUND'?error.message:'MODEL_SERVICE_OPERATION_FAILED';
        return {status:409,headers,body:{code:-1,message}};
      }
    }
  });
  operations.push({
    discovery:{title:'设置语音助手模型',category:{id:'model-services',title:'模型服务'},provider:'voice-assistant'},
    contract:{operationId:'manager.model-services.assistant-selection.save',contractVersion:'1.0.0',method:'POST',
      pathTemplate:'/api/model-services/assistant-selection',exposure:'public',transport:'http',
      description:'Select a model for the current assistant by its model-service ID.',
      request:{path:object,query:object,headers:object,body:{kind:'json',maxBytes:4096,
        schema:{...object,required:['kind','id'],properties:{
          kind:{enum:['llm','search','asr','tts','backgroundAsr']},id:{type:'string',minLength:1,maxLength:1200}
        },additionalProperties:false}}},
      responses:{200:response,403:response,409:response},
      effects:{mode:'native-assistant-command',description:'Update the selected model in the existing assistant profile.'},
      recovery:{strategy:'read-back',description:'Read the current assistant model selection before retrying an unconfirmed update.'},
      validators:[{id:'model-service-binding',description:'Verify connection authority, current assistant ownership, and the model capability.'}]},
    async handler(input) {
      const headers={'cache-control':'no-store'};
      if(!localModelSettingsRequestAllowed(input.request))return {status:403,headers,body:{code:-1,message:'MODEL_SERVICE_ACCESS_DENIED'}};
      try {
        return await run(async()=>({status:200,headers,body:{code:0,data:await owner.command({action:'model-service-select',kind:input.body.kind,id:input.body.id})}}));
      } catch(error) {
        const message=/^(?:MODEL_SERVICE|ASSISTANT)_[A-Z0-9_]{1,100}$/.test(error?.message)?error.message:'MODEL_SERVICE_OPERATION_FAILED';
        return {status:409,headers,body:{code:-1,message}};
      }
    }
  });
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
