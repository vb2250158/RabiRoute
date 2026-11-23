const retryDelays = [1000, 2000, 4000, 8000];

/** Recheck only a foreground session whose local ASR has an in-flight proof. */
export function createLocalAsrAvailabilityRefresh({ read, onAvailable, clock = globalThis }) {
  let current;

  function stop() {
    if (!current) return;
    const watch = current;
    current = undefined;
    clock.clearTimeout(watch.next);
    clock.clearTimeout(watch.deadline);
    watch.controller.abort();
  }

  function finish(watch, audio) {
    if (current !== watch) return;
    stop();
    onAvailable(watch.sessionId, audio);
  }

  function schedule(watch) {
    if (watch.attempt >= retryDelays.length) return;
    watch.next = clock.setTimeout(async () => {
      try {
        const state = await read(watch.controller.signal);
        if (current !== watch) return;
        if (state?.sessionId !== watch.sessionId) { finish(watch); return; }
        const audio = state.hostSettings?.mobileAudio;
        if (audio?.passiveAsrStatus === 'checking') schedule(watch);
        else finish(watch, audio);
      } catch {
        if (current === watch) finish(watch);
      }
    }, retryDelays[watch.attempt++]);
  }

  return Object.freeze({
    sync(sessionId, status) {
      if (!sessionId || status !== 'checking') { stop(); return; }
      if (current?.sessionId === sessionId) return;
      stop();
      const watch = { sessionId, controller:new AbortController(), attempt:0 };
      current = watch;
      watch.deadline = clock.setTimeout(() => finish(watch), 18_000);
      schedule(watch);
    },
    stop,
  });
}
