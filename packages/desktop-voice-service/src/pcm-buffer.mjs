import {mkdtemp,open,rmdir,unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/** Spool received PCM independently of the player's bounded scheduling window.
 * Only the player owns playback progress. This queue never emits played receipts.
 * The one-hour bound matches the maximum accepted provider timing duration.
 */
export async function openPcmBuffer({append,sampleRate,onError=()=>{},maxBytes=sampleRate*2*3600,directory=tmpdir()}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw Error('SPEECH_PCM_BUFFER_LIMIT_INVALID')
  const folder=await mkdtemp(join(directory,'rabi-voice-pcm-'))
  const path=join(folder,'audio.pcm')
  let file
  try{file=await open(path,'wx+',0o600)}catch(error){await rmdir(folder);throw error}
  let committed=0,read=0,accepted=0,sealed=false,ended=false,stopped=false,failure,wake,disposed
  let writes=Promise.resolve()
  let rejectFailure
  const failed=new Promise((_,reject)=>{rejectFailure=reject});void failed.catch(()=>{})
  const notify=()=>{wake?.();wake=undefined}
  const fail=error=>{
    if(failure||stopped)return
    failure=Object.assign(new Error('SPEECH_PCM_BUFFER_FAILED',{cause:error}),{code:'SPEECH_PCM_BUFFER_FAILED'})
    rejectFailure(failure)
    notify()
    try{onError(failure)}catch{}
  }
  const reader=(async()=>{
    try{
      while(!stopped){
        if(failure)throw failure
        if(read<committed){
          const bytes=Buffer.allocUnsafe(Math.min(65536,committed-read))
          const result=await file.read(bytes,0,bytes.length,read)
          if(!result.bytesRead)throw Error('SPEECH_PCM_BUFFER_TRUNCATED')
          if(stopped)break
          await append(bytes.subarray(0,result.bytesRead))
          read+=result.bytesRead
        }else{
          if(ended)break
          await new Promise(resolve=>{wake=resolve})
        }
      }
    }catch(error){fail(error);throw failure??error}
  })()
  void reader.catch(()=>{})
  return {
    failed,
    append(value){
      if(stopped||sealed)return Promise.reject(Error('SPEECH_PCM_BUFFER_CLOSED'))
      if(failure)return Promise.reject(failure)
      const bytes=Buffer.from(value)
      if(accepted+bytes.length>maxBytes){fail(Error('SPEECH_PCM_BUFFER_LIMIT'));return Promise.reject(failure)}
      const position=accepted;accepted+=bytes.length
      const pending=writes.then(async()=>{
        if(stopped)return
        if(failure)throw failure
        let offset=0
        while(offset<bytes.length){
          const result=await file.write(bytes,offset,bytes.length-offset,position+offset)
          if(!result.bytesWritten)throw Error('SPEECH_PCM_BUFFER_WRITE_FAILED')
          offset+=result.bytesWritten
        }
        committed=position+bytes.length;notify()
      }).catch(error=>{fail(error);throw failure??error})
      writes=pending;void pending.catch(()=>{})
      return pending
    },
    async finish(){
      if(stopped)return
      // Seal before waiting so no PCM can race in after the provider's final frame.
      sealed=true
      await writes;ended=true;notify();await reader
      if(failure)throw failure
    },
    dispose(){
      if(disposed)return disposed
      stopped=true;notify()
      disposed=(async()=>{
        await Promise.allSettled([writes,reader])
        // All I/O is settled before unlinking, including on Windows.
        try{await file.close()}finally{try{await unlink(path)}finally{await rmdir(folder)}}
      })()
      return disposed
    },
  }
}
