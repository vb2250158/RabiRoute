import { readFile } from 'node:fs/promises';

export const recognitionSampleSource = 'microsoft-mandarin-weather-v1';

/** Public MIT-licensed Mandarin diagnostic input, available without OS synthesis or network access. */
export async function createRecognitionSample({ read = readFile, url = new URL('../assets/diagnostics/recognition-zh-CN.wav', import.meta.url) } = {}) {
  try {
    const wav = await read(url);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(4) !== wav.length - 8
      || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000
      || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data'
      || wav.readUInt32LE(40) !== wav.length - 44) throw Error('Invalid diagnostic WAV');
    return wav;
  } catch {
    throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE');
  }
}
