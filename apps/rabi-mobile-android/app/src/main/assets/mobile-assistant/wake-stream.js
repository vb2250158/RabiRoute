import { encodeFrame } from './asr-stream.js';

/** An in-process Android detector for the same PCM frames used by realtime recognition. */
export function createLocalWakeRecognition(bridge) {
  let current;
  return {
    open(config, count, events) {
      const id = crypto.randomUUID();
      const close = () => {
        if (current?.id !== id) return;
        current = undefined;
        bridge.wakeCancel(id);
      };
      current = { id, close, events };
      if (!bridge.wakeStart(id, config.model, config.tokensSha256, config.keywords, count)) {
        close();
        throw new Error('MOBILE_WAKE_UNAVAILABLE');
      }
      return {
        write(frame, after) {
          return current?.id === id && bridge.wakePcm(id, after, encodeFrame(frame));
        },
        close,
      };
    },
    receive(id, raw) {
      if (current?.id !== id) return;
      const { close, events } = current;
      let value;
      try { value = JSON.parse(raw); }
      catch { value = { type:'error', code:'MOBILE_WAKE_EVENT_INVALID' }; }
      if (value?.type === 'ready') events.ready();
      else if (value?.type === 'hit') events.hit(value);
      else if (value?.type === 'error') {
        close();
        events.error(new Error(value.code || 'MOBILE_WAKE_UNAVAILABLE'));
      }
    },
  };
}
