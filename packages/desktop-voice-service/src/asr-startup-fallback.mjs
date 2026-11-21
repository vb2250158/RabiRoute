function containsText(result) {
  return typeof (typeof result === 'string' ? result : result?.text) === 'string'
    && Boolean((typeof result === 'string' ? result : result.text).trim())
}

/** Recover the unfinished PCM suffix and fence final callbacks from the retired provider. */
export function createAsrStartupFallback(primary, createFallback, {
  releasePrimary, replayCursor = () => undefined, startupMs = 6000, recognitionMs = 8000, onFallback = () => {},
} = {}) {
  const rounds = new WeakMap()
  const canReplay = state => !state.committed || state.finalCursor !== undefined
  function clearDeadline(state) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  function deadline(state, lease, delay, stage) {
    clearDeadline(state)
    if (!canReplay(state) || state.active !== lease || !lease.remote) return
    state.timer = setTimeout(() => switchToLocal(state, lease, stage), delay)
    state.timer.unref?.()
  }
  function notifyStart(state) {
    if (state.ready) return
    state.ready = true
    state.handlers.onStart?.()
    state.resolve()
  }
  function fail(state, error) {
    if (state.stopped) return
    clearDeadline(state)
    if (state.ready) state.handlers.onError?.(error)
    else state.reject(error)
  }
  function retire(lease) {
    if (!lease.stopping) {
      lease.stopping = Promise.resolve().then(() => lease.api.stop(lease.round))
      void lease.stopping.catch(() => {})
    }
    return lease.stopping
  }
  function runLease(state, api, remote) {
    const lease = { api, remote }
    state.active = lease
    state.leases.push(lease)
    const allowed = () => !state.stopped && state.active === lease
    const report = error => {
      if (!allowed()) return
      if (remote && canReplay(state)) switchToLocal(state, lease, error?.message)
      else fail(state, error)
    }
    try {
      lease.round = api.createRound({
        onStart() {
          if (!allowed()) return
          if (remote) clearDeadline(state)
          notifyStart(state)
        },
        onSpeechStart(...args) {
          if (!allowed()) return
          state.unfinished = true
          deadline(state, lease, recognitionMs, 'ASSISTANT_REALTIME_NO_TEXT')
          state.handlers.onSpeechStart?.(...args)
        },
        onSpeechEnd(...args) {
          if (!allowed()) return
          if (!state.committed || state.unfinished) deadline(state, lease, recognitionMs, 'ASSISTANT_REALTIME_NO_FINAL')
          state.handlers.onSpeechEnd?.(...args)
        },
        onInterim(result) {
          if (!allowed() || !containsText(result)) return
          state.unfinished = true
          deadline(state, lease, recognitionMs, 'ASSISTANT_REALTIME_NO_FINAL')
          state.handlers.onInterim?.(result)
        },
        onFinal(result) {
          if (!allowed() || !containsText(result)) return
          if (remote) {
            state.committed = true
            // A final without an authoritative sample position must invalidate any
            // older cursor, which would now include a sentence already delivered.
            state.finalCursor = Number.isSafeInteger(result.endSample) && result.endSample > state.finalSample
              ? replayCursor(result.endSample) : undefined
            if (state.finalCursor !== undefined) state.finalSample = result.endSample
            state.unfinished = false
          }
          clearDeadline(state)
          state.handlers.onFinal?.(result)
        },
        onError: report,
        onEnd(...args) {
          if (!allowed()) return
          if (remote && canReplay(state)) switchToLocal(state, lease, 'ASSISTANT_REALTIME_ENDED')
          else state.handlers.onEnd?.(...args)
        },
      })
      if (remote) deadline(state, lease, startupMs, 'ASSISTANT_REALTIME_CONNECT_TIMEOUT')
      lease.starting = Promise.resolve(api.start(lease.round)).catch(report)
    } catch (error) { report(error) }
    return lease
  }
  function switchToLocal(state, lease, reason) {
    if (state.stopped || state.active !== lease || !canReplay(state)) return
    const cursor = state.committed ? state.finalCursor : replayCursor(0)
    // Fence the old recognizer before either asynchronous cleanup or local startup.
    state.active = undefined
    clearDeadline(state)
    if (lease.round !== undefined) retire(lease)
    state.switching = Promise.resolve().then(async () => {
      await releasePrimary?.()
      if (state.stopped) return
      onFallback(reason)
      runLease(state, createFallback(cursor), false)
    }).catch(error => fail(state, error))
  }
  return {
    createRound(handlers) {
      const round = {}
      rounds.set(round, {handlers, leases:[], ready:false, stopped:false, committed:false, finalSample:0, unfinished:false})
      return round
    },
    start(round) {
      const state = rounds.get(round)
      if (!state || state.stopped || state.started) throw Error('ASSISTANT_RECOGNITION_ROUND_INVALID')
      state.started = new Promise((resolve,reject) => { state.resolve=resolve; state.reject=reject })
      runLease(state, primary, true)
      return state.started
    },
    stop(round) {
      const state = rounds.get(round)
      if (!state) return Promise.resolve()
      if (state.stopping) return state.stopping
      state.stopped = true
      clearDeadline(state)
      state.resolve?.()
      state.stopping = (async () => {
        await state.switching
        await Promise.all(state.leases.filter(lease => lease.round !== undefined).map(retire))
      })()
      return state.stopping
    },
  }
}
