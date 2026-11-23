/** Native bridge payloads for one already paired mobile PCM stream. */
export function createStreamingRecognition(bridge) {
  const streams = new Map();
  return {
    open(sessionId, events) {
      const id = crypto.randomUUID();
      let sequence = 0;
      let closed = false;
      let providerReady = false;
      const close = () => {
        if (closed) return;
        closed = true;
        streams.delete(id);
        bridge.recognitionCancel(id);
      };
      const receive = event => {
        if (event.type === 'error' || event.type === 'end') {
          close();
          if (event.type === 'error') events.error(new Error(event.code || 'MOBILE_STREAM_FAILED'));
          else events.end();
          return;
        }
        if (event.type === 'ready') providerReady = true;
        events.receive(event);
      };
      streams.set(id, receive);
      if (!bridge.recognitionStart(id, sessionId)) {
        close();
        throw new Error('MOBILE_STREAM_UNAVAILABLE');
      }
      return {
        write(frame) {
          if (closed) return false;
          if (bridge.recognitionPcm(id, sequence, encodeFrame(frame), providerReady)) {
            sequence++;
            return true;
          }
          close();
          return false;
        },
        close,
      };
    },
    receive(id, data) {
      const handler = streams.get(id);
      if (!handler) return;
      let event;
      try { event = JSON.parse(data); }
      catch { event = { type:'error', code:'MOBILE_STREAM_EVENT_INVALID' }; }
      handler(event);
    },
  };
}

export function encodeFrame(frame) {
  const view = new DataView(new ArrayBuffer(frame.length * 2));
  for (let index = 0; index < frame.length; index++) {
    const sample = Math.max(-1, Math.min(1, frame[index]));
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return btoa(String.fromCharCode(...new Uint8Array(view.buffer)));
}

const speechCharacter = /[\p{L}\p{N}]/u;
const keepSpeech = input => [...input.normalize('NFKC').toLowerCase()].filter(part => speechCharacter.test(part));

/** Use a local ASR result for the wake word. Preserve the original command punctuation and case. */
export function matchWakeWord(text, aliases) {
  if (typeof text !== 'string' || !text) return null;
  let normalized = '';
  const starts = [];
  const ends = [];
  let offset = 0;
  for (const part of text) {
    const start = offset;
    offset += part.length;
    for (const symbol of keepSpeech(part)) {
      normalized += symbol;
      for (let index = 0; index < symbol.length; index++) {
        starts.push(start);
        ends.push(offset);
      }
    }
  }
  const candidates = aliases.map(alias => ({ alias, word:keepSpeech(alias).join('') }))
    .filter(({ word }) => word);
  let hit;
  for (const candidate of candidates) {
    let from = 0;
    while (from < normalized.length) {
      const position = normalized.indexOf(candidate.word,from);
      if (position < 0) break;
      const end = position + candidate.word.length;
      const first = starts[position];
      const last = ends[end - 1];
      const withinWord = /^[a-z0-9]/.test(candidate.word) && /[a-z0-9]/i.test(text[first - 1] || '')
        || /[a-z0-9]$/.test(candidate.word) && /[a-z0-9]/i.test(text[last] || '');
      if (!withinWord && (!hit || position < hit.position || position === hit.position && end > hit.end)) {
        hit = { alias:candidate.alias, position, end };
      }
      from = position + 1;
    }
  }
  if (!hit) return null;
  return { alias:hit.alias, text:text.slice(ends[hit.end - 1]).replace(/^[\s\p{P}]+/u,'').trim() };
}
