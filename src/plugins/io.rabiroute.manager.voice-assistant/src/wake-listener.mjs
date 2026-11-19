import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { createResidentRecording } from './resident-recording.mjs';

function wakeCursor(event, ready, aliases) {
  const { captureId, sampleRate, aliasIndex, replayFromSample, observedThroughSample } = event;
  if (!ready || ready.captureId !== captureId || ready.sampleRate !== sampleRate || sampleRate !== 16000
    || !Number.isSafeInteger(aliasIndex) || aliasIndex < 0 || aliasIndex >= aliases.length
    || !Number.isSafeInteger(replayFromSample) || replayFromSample < 0
    || !Number.isSafeInteger(observedThroughSample) || observedThroughSample <= replayFromSample
    || observedThroughSample - replayFromSample > sampleRate) {
    throw Error('ASSISTANT_WAKE_CURSOR_INVALID');
  }
  return { captureId, sample: replayFromSample };
}

async function* wakeEvents(response) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of response) {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.length > 8192) throw Error('ASSISTANT_WAKE_EVENT_TOO_LARGE');
      if (line) yield JSON.parse(line);
    }
    if (pending.length > 8192) throw Error('ASSISTANT_WAKE_EVENT_TOO_LARGE');
  }
  if (pending + decoder.end()) throw Error('ASSISTANT_WAKE_EVENT_TRUNCATED');
}

export function createWakeListener({ speechRuntime, onWake }) {
  let controller, task, phase = 'disabled', error = null;
  return {
    snapshot: () => ({ phase, error }),
    arm(aliases) {
      if (task) throw Error('ASSISTANT_WAKE_ALREADY_LISTENING');
      if (!aliases.length) throw Error('ASSISTANT_WAKE_ALIASES_REQUIRED');
      controller = new AbortController();
      const { signal } = controller;
      phase = 'starting'; error = null;
      const activeTask = (async () => {
        let retry = 1000;
        while (!signal.aborted) {
          let response;
          try {
            response = await speechRuntime.openAssistantWake(aliases, signal);
            if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/x-ndjson') {
              const failure = Object.assign(Error('ASSISTANT_WAKE_SERVICE_UNAVAILABLE'), { status: response.statusCode });
              throw failure;
            }
            let ready;
            for await (const event of wakeEvents(response)) {
              signal.throwIfAborted();
              if (event.type === 'ready' && !ready && /^[a-f0-9]{32}$/.test(event.captureId) && event.sampleRate === 16000) {
                ready = event;
                phase = 'armed'; error = null;
                retry = 1000;
              } else if (event.type === 'wake') {
                const cursor = wakeCursor(event, ready, aliases);
                let resume = cursor, primaryPoint = cursor;
                const openCapture = (abort, point) => speechRuntime.openAssistantCapture(abort, point);
                const createRecording = () => {
                  primaryPoint = resume;
                  resume = undefined;
                  return createResidentRecording(openCapture, primaryPoint);
                };
                const createFallbackRecording = () => createResidentRecording(openCapture, primaryPoint);
                try {
                  await onWake({ createRecording, createFallbackRecording, recentSpeech:event.recentSpeech, cursor, alias: aliases[event.aliasIndex], signal });
                } catch (failure) {
                  if (!signal.aborted) error = String(failure?.message || 'ASSISTANT_WAKE_START_FAILED');
                }
              } else {
                throw Error('ASSISTANT_WAKE_EVENT_INVALID');
              }
            }
            throw Error('ASSISTANT_WAKE_STREAM_ENDED');
          } catch (failure) {
            if (signal.aborted) return;
            phase = 'waiting';
            error = String(failure?.message || 'ASSISTANT_WAKE_SERVICE_UNAVAILABLE');
            if ([400, 403, 422, 503].includes(failure.status)) { phase = 'unavailable'; return; }
          } finally {
            response?.destroy();
          }
          await delay(retry, undefined, { signal }).catch(() => {});
          retry = Math.min(retry * 2, 30000);
        }
      })();
      task = activeTask;
      void activeTask.then(() => { if (task === activeTask) task = undefined; }, failure => {
        if (task === activeTask) task = undefined;
        phase = 'unavailable'; error = String(failure?.message || 'ASSISTANT_WAKE_SERVICE_UNAVAILABLE');
      });
    },
    async stop() {
      controller?.abort();
      await task;
      task = undefined;
      phase = 'disabled'; error = null;
    },
  };
}
