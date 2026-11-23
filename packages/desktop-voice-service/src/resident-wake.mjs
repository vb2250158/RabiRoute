import { createWakeListener } from './wake-listener.mjs';
import { createResidentRecording } from './resident-recording.mjs';
import { createVoiceIdleTimer } from '@rabilink/assistant-runtime/voice';

export function normalizeWakeAliases(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string')
    .map(item => item.normalize('NFKC').trim()).filter(Boolean))] : [];
}

export function parseWakeAliases(value) {
  const aliases = normalizeWakeAliases(value.split(/[\n,，]/));
  if (aliases.length > 64 || aliases.some(alias => [...alias].length > 64)) {
    throw Error('ASSISTANT_WAKE_ALIASES_INVALID');
  }
  return aliases;
}

/** Desktop assistants borrow the same sample timeline and use the resident voice loop. */
export function createResidentWake({ speechRuntime, acquireTarget, assertCurrent, canStart, shouldUseFallback, sleepAfterMs }) {
  let active, wakeError, handoffWrites = Promise.resolve();
  const idle = createVoiceIdleTimer({
    timeoutMs: sleepAfterMs,
    isEligible: () => Boolean(active),
    isBusy() {
      const { host, conversation } = active.target;
      return conversation.activity().pending || host.captureHasWork() || host.captureState().phase === 'starting';
    },
    async onIdle() {
      const { host } = active.target;
      captureStopped();
      try { await host.command({ action: 'stop' }); }
      catch (error) { wakeError = error.message || 'ASSISTANT_WAKE_STOP_FAILED'; }
    }
  });

  function setPassiveHandoff(lease, enabled) {
    handoffWrites = handoffWrites.then(async () => {
      await speechRuntime.setAssistantRealtime(lease.captureId, enabled, AbortSignal.timeout(2_000));
      lease.passiveError = undefined;
    }).catch(() => { lease.passiveError = 'ASSISTANT_WAKE_HANDOFF_UNCONFIRMED'; });
  }

  function captureStopped() {
    idle.clear();
    const lease = active;
    active = undefined;
    if (lease?.handoffRequested) setPassiveHandoff(lease, false);
  }

  async function startBorrowed(target, { createRecording, createFallbackRecording, recentSpeech, captureId, signal }) {
    if (['starting', 'running'].includes(target.host.captureState().phase)) return;
    if (!target.host.voiceEnabled() || !canStart(target)) throw Error('ASSISTANT_WAKE_CONFIGURATION_REQUIRED');
    const lease = { target, captureId, handoffRequested: false, usingFallback: false };
    active = lease;
    idle.renew();
    try {
      const fallback = shouldUseFallback(target) ? {
        createRecording: createFallbackRecording,
        recognize: (audio, abort) => speechRuntime.transcribeAssistantAudio(audio, abort),
        onFallback: () => {
          if (active !== lease) return;
          lease.usingFallback = true;
          if (lease.handoffRequested) {
            setPassiveHandoff(lease, false);
            lease.handoffRequested = false;
          }
        },
      } : undefined;
      await target.host.startWithRecording(createRecording, { fallback, recentSpeech });
      signal?.throwIfAborted();
      idle.renew();
    } catch (error) {
      if (active === lease) captureStopped();
      throw error;
    }
  }
  const wake = createWakeListener({ speechRuntime,
    async onWake({ createRecording, createFallbackRecording, recentSpeech, cursor, signal }) {
      assertCurrent();
      signal.throwIfAborted();
      const target = await acquireTarget();
      assertCurrent();
      signal.throwIfAborted();
      await startBorrowed(target, { createRecording, createFallbackRecording, recentSpeech, captureId: cursor.captureId, signal });
    },
  });

  return {
    arm(aliases) {
      if (aliases.length > 64) throw Error('ASSISTANT_WAKE_TOO_MANY_ALIASES');
      wakeError = undefined;
      wake.arm(aliases);
    },
    captureActivity(hasText) {
      idle.renew();
      const lease = active;
      // Raw audio energy and empty recognition must not stop local transcription.
      if (hasText && lease && !lease.usingFallback && !lease.handoffRequested) {
        lease.handoffRequested = true;
        setPassiveHandoff(lease, true);
      }
    },
    captureStopped,
    drainHandoff: () => handoffWrites,
    async startManual() {
      const captureId = wake.currentCapture();
      if (!captureId) return false;
      assertCurrent();
      const target = await acquireTarget();
      assertCurrent();
      if (wake.currentCapture() !== captureId) return false;
      const createRecording = (checkpoint) => createResidentRecording((signal, cursor) => speechRuntime.openAssistantCapture(signal, cursor), checkpoint);
      await startBorrowed(target, { createRecording: () => createRecording(), createFallbackRecording: createRecording, captureId });
      return true;
    },
    snapshot() {
      const lease = active;
      return { ...wake.snapshot(), ...(wakeError ? { error: wakeError } : {}),
        ...(lease?.passiveError ? { passiveError: lease.passiveError } : {}),
        ...(lease && ['starting', 'running'].includes(lease.target.host.captureState().phase)
          ? { phase: lease.usingFallback ? 'local-fallback' : 'active' } : {}) };
    },
    async stop({ stopCapture = false } = {}) {
      const lease = active;
      captureStopped();
      await wake.stop();
      if (stopCapture && lease) await lease.target.host.command({ action: 'stop' });
      await handoffWrites;
      wakeError = undefined;
    },
  };
}
