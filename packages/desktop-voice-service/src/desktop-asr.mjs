/** Continuous PC capture; bounded transcription runs beside ongoing VAD. */
export function createDesktopAsr({ createRecording, transcribe, settings, clock }) {
  const rounds = new WeakMap()
  const retire = state => {
    if (!state || state.closed) return state?.disposal
    state.closed = true;clock.clearInterval(state.monitor);clock.clearTimeout(state.deadline);state.abort.abort()
    state.disposal = Promise.resolve().then(() => state.recording.dispose())
    void state.disposal.catch(error => state.handlers.onError?.(error))
    return state.disposal
  }
  return {
    createRound(handlers) {
      const round = {}
      rounds.set(round, {handlers,recording:createRecording(),abort:new AbortController(),closed:false,
        speaking:false,quietSince:undefined,monitor:undefined,deadline:undefined,taking:false,pending:0,chain:Promise.resolve()})
      return round
    },
    async start(round) {
      const state=rounds.get(round),config=settings()
      if(!state||state.closed)throw Error('DESKTOP_ASR_ROUND_INVALID')
      if(!config||!Number.isFinite(config.threshold)||config.threshold<=0||config.threshold>1||
        !Number.isSafeInteger(config.silenceMs)||config.silenceMs<1||
        !Number.isSafeInteger(config.maxDurationMs)||config.maxDurationMs<config.silenceMs||
        !Number.isSafeInteger(config.sampleMs)||config.sampleMs<1)throw Error('DESKTOP_ASR_SETTINGS_INVALID')
      const fail=error=>{if(!state.closed){state.handlers.onError?.(error);void retire(state)}}
      const segment=async()=>{
        if(state.closed||state.taking||!state.speaking)return
        state.taking=true;state.speaking=false;state.quietSince=undefined;clock.clearTimeout(state.deadline)
        state.handlers.onSpeechEnd?.()
        try{
          const audio=await state.recording.take()
          if(state.closed)return
          if(state.pending>=3)throw Error('DESKTOP_ASR_BACKLOG')
          state.pending++
          // Keep utterance order, bounded to three. No microphone shutdown or
          // recognizer restart while the service is returning an earlier result.
          const work=state.chain.then(async()=>{
            if(state.closed)return
            const result=await transcribe(audio,state.abort.signal)
            if(!state.closed&&typeof result?.text==='string'&&result.text.trim())state.handlers.onFinal?.(result)
          }).catch(fail).finally(()=>{state.pending--})
          state.chain=work
        }catch(error){fail(error)}finally{state.taking=false}
      }
      try{
        await state.recording.start(fail)
        if(state.closed)return
        state.handlers.onStart?.()
        if(state.closed)return
        state.monitor=clock.setInterval(()=>{
          if(state.closed||state.taking)return
          if(state.recording.amplitude()>=config.threshold){
            state.quietSince=undefined
            if(!state.speaking){
              state.speaking=true;state.recording.markSpeech?.();state.handlers.onSpeechStart?.()
              state.deadline=clock.setTimeout(()=>{void segment()},config.maxDurationMs)
            }
          }else if(state.speaking){
            state.quietSince??=clock.now()
            if(clock.now()-state.quietSince>=config.silenceMs)void segment()
          }
        },config.sampleMs)
      }catch(error){await retire(state);throw error}
    },
    stop(round){return retire(rounds.get(round))},
  }
}
