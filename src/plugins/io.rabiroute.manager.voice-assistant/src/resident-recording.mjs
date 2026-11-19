const sampleRate = 16000;
const maxBytes = sampleRate * 2 * 35;
const preRollBytes = sampleRate * 2 * 2;

function pcmWave(data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function rms(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const sample = bytes.readInt16LE(i) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (bytes.length / 2));
}

/** The service keeps capturing while this borrower opens, reads or closes. */
export function createResidentRecording(open, cursor, { onLevel = () => {} } = {}) {
  const abort = new AbortController();
  let response, reader, starting, lastLevel = 0, observedPeak = 0;
  let speaking = false, first = true, buffered = 0, chunks = [];
  let odd = Buffer.alloc(0);
  const take = () => {
    const audio = pcmWave(Buffer.concat(chunks, buffered));
    speaking = false; first = false; chunks = []; buffered = 0;
    return audio;
  };
  return {
    async start(onError, { onPcm } = {}) {
      if (starting) throw Error('ASSISTANT_CAPTURE_ALREADY_STARTED');
      abort.signal.throwIfAborted();
      starting = open(abort.signal, cursor);
      response = await starting;
      if (abort.signal.aborted) {
        response.destroy();
        abort.signal.throwIfAborted();
      }
      if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/octet-stream'
        || Number(response.headers['x-rabispeech-sample-rate']) !== sampleRate
        || (cursor && (response.headers['x-rabispeech-capture-id'] !== cursor.captureId
          || Number(response.headers['x-rabispeech-start-sample']) !== cursor.sample))) {
        response.destroy();
        throw Error('ASSISTANT_CAPTURE_REPLAY_UNAVAILABLE');
      }
      reader = (async () => {
        for await (const value of response) {
          if (abort.signal.aborted) return;
          const incoming = odd.length ? Buffer.concat([odd, value]) : Buffer.from(value);
          const end = incoming.length - incoming.length % 2;
          const bytes = incoming.subarray(0, end);
          odd = incoming.subarray(end);
          if (!bytes.length) continue;
          lastLevel = rms(bytes);
          observedPeak = Math.max(observedPeak, lastLevel);
          onLevel(lastLevel);
          if (onPcm) {
            onPcm(bytes);
            continue;
          }
          // The first replay may arrive faster than the VAD timer can mark it.
          chunks.push(bytes);
          buffered += bytes.length;
          if (speaking && buffered > maxBytes) throw Error('ASSISTANT_CAPTURE_AUDIO_LIMIT');
          const limit = first ? maxBytes : preRollBytes;
          if (!speaking && buffered > limit) {
            while (buffered - chunks[0].length >= limit) buffered -= chunks.shift().length;
            chunks[0] = chunks[0].subarray(buffered - limit);
            buffered = limit;
          }
        }
        if (!abort.signal.aborted) throw Error('ASSISTANT_CAPTURE_ENDED');
      })().catch(error => {
        response.destroy();
        if (!abort.signal.aborted) onError(error);
      });
    },
    amplitude() {
      const level = Math.max(lastLevel, observedPeak);
      observedPeak = 0;
      return level;
    },
    markSpeech() { speaking = true; },
    take: async () => take(),
    stop: async () => take(),
    async dispose() {
      abort.abort();
      response?.destroy();
      await starting?.catch(() => {});
      await reader;
      chunks = []; buffered = 0;
    },
  };
}
