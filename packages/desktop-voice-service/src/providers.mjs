const MAX_AUDIO=16*1024*1024
async function bounded(response,limit){
  if(!response.ok)throw Error('SPEECH_PROVIDER_HTTP_'+response.status)
  const reader=response.body?.getReader();if(!reader)throw Error('SPEECH_PROVIDER_EMPTY')
  const chunks=[];let size=0
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('SPEECH_PROVIDER_LIMIT');chunks.push(value)}}
  finally{await reader.cancel();reader.releaseLock()}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}return result
}
function endpoint(value){
  const url=new URL(value)
  if(url.username||url.password||!['http:','https:'].includes(url.protocol))throw Error('SPEECH_ENDPOINT_INVALID')
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('SPEECH_ENDPOINT_REQUIRES_TLS')
  return url.href
}
/** OpenAI-compatible service ports. Configuration/keys are owned by the native host, never the GUI. */
export function createHttpSpeechProviders({asr,tts,resolveCredential,fetcher=fetch,timeoutMs=60000}){
  const asrUrl=asr?endpoint(asr.endpoint):undefined,ttsUrl=tts?endpoint(tts.endpoint):undefined
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)throw Error('SPEECH_TIMEOUT_INVALID')
  const headers=async ref=>{const key=ref?await resolveCredential(ref):undefined;return key?{authorization:'Bearer '+key}:{}}
  const scoped=signal=>AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])
  return {
    async recognize(audio,signal){
      signal.throwIfAborted()
      if(!asrUrl||!asr.model)throw Error('SPEECH_ASR_MODEL_REQUIRED')
      if(!(audio instanceof Uint8Array)||audio.byteLength>MAX_AUDIO)throw Error('SPEECH_AUDIO_INVALID')
      const form=new FormData();form.set('model',asr.model);form.set('file',new Blob([audio],{type:'audio/wav'}),'speech.wav')
      const response=await fetcher(asrUrl,{method:'POST',headers:await headers(asr.credentialRef),body:form,signal:scoped(signal),redirect:'error'})
      const result=JSON.parse(new TextDecoder().decode(await bounded(response,128*1024)))
      if(typeof result.text!=='string')throw Error('SPEECH_TRANSCRIPT_INVALID')
      return {text:result.text}
    },
    async synthesize(text,signal){
      signal.throwIfAborted()
      if(!ttsUrl||!tts.model||!tts.voice)throw Error('SPEECH_TTS_MODEL_REQUIRED')
      if(typeof text!=='string'||text.length>16000)throw Error('SPEECH_TEXT_INVALID')
      const response=await fetcher(ttsUrl,{method:'POST',headers:{...await headers(tts.credentialRef),'content-type':'application/json'},
        body:JSON.stringify({model:tts.model,voice:tts.voice,input:text,response_format:'wav'}),signal:scoped(signal),redirect:'error'})
      const bytes=await bounded(response,MAX_AUDIO)
      if(bytes.length<44||new TextDecoder().decode(bytes.subarray(0,4))!=='RIFF'||new TextDecoder().decode(bytes.subarray(8,12))!=='WAVE')throw Error('SPEECH_WAV_REQUIRED')
      return bytes
    },
  }
}
