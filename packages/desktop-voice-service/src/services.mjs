import {createAiuiAssistantRuntime} from '@rabilink/assistant-runtime/aiui'
import {createDesktopAsr} from './desktop-asr.mjs'

/** One PC service adapter for every assistant; provider functions stay on the native Host. */
export async function openDesktopVoiceServices({openDevice,recognize,synthesize,createAsr,openSpeechStream,settings,signal,onError=()=>{}}) {
  signal.throwIfAborted()
  const device=await openDevice({signal})
  if(signal.aborted){await device.close();signal.throwIfAborted()}
  let closed=false
  const cleanups=new Set(), acquisitions=new Set(), failures=[]
  const track=promise=>{acquisitions.add(promise);void promise.then(()=>acquisitions.delete(promise),error=>{acquisitions.delete(promise);failures.push(error);onError(error)});return promise}
  const recognizer=createAsr?createAsr({createRecording:()=>device.createRecording()}):createDesktopAsr({createRecording:()=>device.createRecording(),transcribe:recognize,
    settings:()=>({threshold:settings.silenceThreshold,silenceMs:settings.silenceDurationMs,
      sampleMs:settings.sampleMs,maxDurationMs:settings.maxDurationMs}),
    clock:{now:()=>performance.now(),setTimeout,clearTimeout,setInterval,clearInterval}})
  const rounds=new Set()
  const asr={...recognizer,
    createRound(handlers){const round=recognizer.createRound(handlers);rounds.add(round);return round},
    stop(round){return track(Promise.resolve(recognizer.stop(round)).finally(()=>rounds.delete(round)))},
  }
  const tts={async synthesize(text,options={}){
    const abort=new AbortController()
    const cancel=()=>abort.abort()
    options.signal?.addEventListener('abort',cancel,{once:true})
    if(options.signal?.aborted)cancel()
    let player
    try{
      const audio=await synthesize(text,abort.signal)
      abort.signal.throwIfAborted()
      player=await device.createPlayer(audio)
      abort.signal.throwIfAborted()
    }catch(error){await player?.destroy();options.signal?.removeEventListener('abort',cancel);throw error}
    return {task:{abort:cancel},player:{
      audioPlayer:player.events,play:()=>player.play(),stop:()=>player.stop(),
      destroy(){options.signal?.removeEventListener('abort',cancel);void player.destroy().catch(onError)},
    }}
  }}
  if(openSpeechStream)tts.openStream=async(options={})=>{
    if(closed)throw Error('SPEECH_STREAM_CLOSED')
    const abort=new AbortController()
    let player,stream,cleanup,stopped=false
    const destroy=()=>{
      if(cleanup)return cleanup
      stopped=true;abort.abort();options.signal?.removeEventListener('abort',cancel)
      cleanup=track((async()=>{
        // Fence and stop local output first. Provider cancellation must not delay interruption.
        const outcomes=await Promise.allSettled([player?.stop(),stream?.close()])
        await player?.destroy()
        const errors=outcomes.filter(value=>value.status==='rejected').map(value=>value.reason)
        if(errors.length)throw new AggregateError(errors,'SPEECH_CLEANUP_UNCONFIRMED')
      })().finally(()=>cleanups.delete(destroy)))
      return cleanup
    }
    const cancel=()=>{void destroy().catch(()=>{})}
    cleanups.add(destroy)
    options.signal?.addEventListener('abort',cancel,{once:true})
    if(options.signal?.aborted)cancel()
    const acquire=(async()=>{
      abort.signal.throwIfAborted()
      player=await device.createStreamPlayer({sampleRate:settings.ttsSampleRate??24000})
      if(stopped){await player.destroy();abort.signal.throwIfAborted()}
      stream=await openSpeechStream({signal:abort.signal,onAudio:audio=>{if(!stopped)return player.append(audio)}})
      if(stopped){await stream.close();abort.signal.throwIfAborted()}
      const finished=stream.finished.then(async info=>{if(!stopped)await player.finish();return info})
      void finished.catch(()=>{})
      return {task:{abort:cancel,finished},input:{append:text=>stream.append(text),finish:()=>stream.finish()},
        player:{audioPlayer:player.events,play:()=>player.play(),stop:cancel,destroy}}
    })()
    acquisitions.add(acquire)
    try{return await acquire}catch(error){await destroy();throw error}finally{acquisitions.delete(acquire)}
  }
  const runtime=createAiuiAssistantRuntime({asr,tts,onCleanupError:onError})
  return {runtime,async dispose(){if(closed)return;closed=true;runtime.dispose();
    await Promise.allSettled([...rounds].map(round=>asr.stop(round)))
    await Promise.allSettled([...cleanups].map(cleanup=>cleanup()))
    await Promise.allSettled([...acquisitions])
    await device.close()
    if(failures.length)throw new AggregateError(failures,'SPEECH_CLEANUP_UNCONFIRMED')
  }}
}
