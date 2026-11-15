import {createAiuiAssistantRuntime} from '@rabilink/assistant-runtime/aiui'
import {createDesktopAsr} from './desktop-asr.mjs'
import {ttsRequestEvent,notifySpeechObserver} from './speech-details.mjs'
import {createPlaybackCueTracker} from './playback-cues.mjs'
import {openPcmBuffer} from './pcm-buffer.mjs'

/** One PC service adapter for every assistant; provider functions stay on the native Host. */
export async function openDesktopVoiceServices({openDevice,recognize,synthesize,createAsr,openSpeechStream,streamSampleRate,settings,signal,onError=()=>{},onSpeechRequest}) {
  signal.throwIfAborted()
  const device=await openDevice({signal})
  if(signal.aborted){await device.close();signal.throwIfAborted()}
  let closed=false
  let speechSequence=0
  const requestObserver=options=>{const group=++speechSequence;return event=>notifySpeechObserver(onSpeechRequest,{responseId:options.responseId,...ttsRequestEvent(settings,options.expression,event),requestId:group+':'+(event.requestId||1)})}
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
    let player,detachCue=()=>{}
    const cancel=()=>{abort.abort();detachCue()}
    options.signal?.addEventListener('abort',cancel,{once:true})
    if(options.signal?.aborted)cancel()
    try{
      const audio=await synthesize(text,abort.signal,options.expression,{onRequest:requestObserver(options)})
      abort.signal.throwIfAborted()
      player=await device.createPlayer(audio)
      abort.signal.throwIfAborted()
      // A buffered provider has no word timestamps. Mark only the current
      // synthesized segment, on actual output progress, as sentence-level timing.
      // Synthesized bytes and play requests alone never advance highlighting.
      let sent=false
      const progress=event=>{
        if(sent||abort.signal.aborted||!Number.isFinite(event?.seconds)||event.seconds<0||!text.length)return
        sent=true;options.onCue?.({charIndex:0,charLength:text.length,mode:'sentence'})
      }
      detachCue=()=>{
        player.events?.removeEventListener('progress',progress)
        player.events?.removeEventListener('ended',detachCue)
        player.events?.removeEventListener('error',detachCue)
      }
      player.events?.addEventListener('progress',progress)
      player.events?.addEventListener('ended',detachCue)
      player.events?.addEventListener('error',detachCue)
    }catch(error){detachCue();await player?.destroy();options.signal?.removeEventListener('abort',cancel);throw error}
    return {task:{abort:cancel},player:{
      audioPlayer:player.events,play:()=>player.play(),stop:()=>{detachCue();return player.stop()},
      destroy(){detachCue();options.signal?.removeEventListener('abort',cancel);void player.destroy().catch(onError)},
    }}
  }}
  if(openSpeechStream)tts.openStream=async(options={})=>{
    if(closed)throw Error('SPEECH_STREAM_CLOSED')
    const abort=new AbortController()
    let player,stream,pcm,cleanup,stopped=false,bufferFailure
    const cues=createPlaybackCueTracker(cue=>{if(!stopped)options.onCue?.(cue)})
    const progress=event=>cues.advance(event.seconds)
    const destroy=()=>{
      if(cleanup)return cleanup
      stopped=true;cues.dispose();player?.events?.removeEventListener('progress',progress);abort.abort();options.signal?.removeEventListener('abort',cancel)
      cleanup=track((async()=>{
        // Fence and stop local output first. Provider cancellation must not delay interruption.
        const outcomes=await Promise.allSettled([player?.stop(),stream?.close(),pcm?.dispose()])
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
      const sampleRate=streamSampleRate??settings.ttsSampleRate??24000
      player=await device.createStreamPlayer({sampleRate})
      player.events?.addEventListener('progress',progress)
      if(stopped){await player.destroy();abort.signal.throwIfAborted()}
      pcm=await openPcmBuffer({sampleRate,append:audio=>player.append(audio),onError:error=>{bufferFailure=error;abort.abort()}})
      if(stopped){await pcm.dispose();abort.signal.throwIfAborted()}
      stream=await openSpeechStream({signal:abort.signal,expression:options.expression,onRequest:requestObserver(options),onTiming:values=>{if(!stopped)cues.add(values)},onAudio:audio=>{if(!stopped)return pcm.append(audio)}})
      if(stopped){await stream.close();abort.signal.throwIfAborted()}
      const finished=Promise.race([stream.finished,pcm.failed]).then(async info=>{
        if(bufferFailure)throw bufferFailure
        if(!stopped){await pcm.finish();if(!stopped)await player.finish()}
        return info
      },error=>{throw bufferFailure??error})
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
