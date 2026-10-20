import type { CompanionObservation, CompanionObservationPolicy } from "../shared/companionActivity.js";

export function readCompanionObservationPolicy(value: unknown): CompanionObservationPolicy {
  const row = value as Record<string, unknown>;
  const bounds: Record<keyof CompanionObservationPolicy, [number, number]> = {
    captureSeconds: [0.25, 5], uploadSeconds: [0.5, 10], historySeconds: [30, 300], maxFrameBytes: [1_048_576, 67_108_864],
    storyboardFrames: [2, 12], tileWidth: [320, 960], changeThreshold: [1, 255], audioUploadSeconds: [1, 30],
    transcriptionTimeoutSeconds: [1, 60], initialReviewSeconds: [1, 30]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = row?.[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max
      || !["captureSeconds", "uploadSeconds"].includes(key) && !Number.isInteger(number)) throw new Error(`Invalid companion observation policy: ${key}`);
  }
  return Object.fromEntries(Object.keys(bounds).map(key => [key, row[key]])) as CompanionObservationPolicy;
}

export function companionJpeg(value: string): Buffer {
  if (typeof value !== "string" || value.length > 2_800_000 || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error("Invalid frame");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 2 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Expected JPEG frame");
  return bytes;
}

export function validateCompanionInterval(input: CompanionObservation, boundary: number): Buffer | null {
  const interval = input.interval;
  if (!interval) return null; // Existing browser players remain a single-frame producer.
  if (!Number.isFinite(interval.startedAt) || interval.startedAt !== boundary || interval.endedAt !== input.capturedAt
    || interval.startedAt > interval.endedAt || !Number.isInteger(interval.sampleCount) || interval.sampleCount < 1 || interval.sampleCount > 10000
    || !Array.isArray(interval.frameTimes) || !interval.frameTimes.length || interval.frameTimes.length > 12
    || interval.frameTimes.length > interval.sampleCount || interval.frameTimes.some((at, index) => !Number.isFinite(at)
      || at < interval.startedAt || at > interval.endedAt || index > 0 && at <= interval.frameTimes[index - 1])
    || !Number.isFinite(interval.coverageStartedAt) || interval.coverageStartedAt < boundary
    || interval.coverageStartedAt > interval.frameTimes[0]) throw new Error("Invalid observation interval");
  return companionJpeg(interval.jpeg);
}

type AudioChunk = Omit<NonNullable<CompanionObservation["audio"]>, "pcm"> & { pcm: Buffer };
export type FrozenCompanionAudio = { wav: Buffer | null; status: string; missingMs: number; suppressedMs: number; error?: string };

/** The Manager owns incremental PCM until one review freezes that interval. */
export class CompanionIntervalAudio {
  private chunks: AudioChunk[] = [];
  private through = 0;
  reset() { this.chunks = []; this.through = 0; }
  validate(input: CompanionObservation): AudioChunk | null {
    const audio = input.audio;
    if (!audio) return null;
    const duration = audio.endedAt - audio.startedAt;
    if (![audio.startedAt, audio.endedAt, audio.missingMs, audio.suppressedMs].every(Number.isSafeInteger)
      || duration <= 0 || duration > 30000 || audio.endedAt > input.capturedAt || audio.startedAt < input.capturedAt - 30000
      || audio.missingMs < 0 || audio.missingMs > duration || audio.suppressedMs < 0 || audio.suppressedMs > duration
      || !["ready", "starting", "unavailable"].includes(audio.status)
      || audio.error !== undefined && (typeof audio.error !== "string" || audio.error.length > 200)
      || typeof audio.pcm !== "string" || audio.pcm.length > 1_280_000 || !/^[A-Za-z0-9+/]+=*$/.test(audio.pcm)) throw new Error("Invalid system playback audio");
    const pcm = Buffer.from(audio.pcm, "base64");
    if (pcm.length !== duration * 32) throw new Error("Expected PCM16 mono at 16 kHz");
    return { ...audio, pcm };
  }
  append(chunk: AudioChunk | null, boundary: number, now: number): number {
    if (!chunk || chunk.endedAt <= Math.max(boundary, this.through)) return this.through;
    const start = Math.max(boundary, this.through, chunk.startedAt);
    const fraction = (chunk.endedAt - start) / (chunk.endedAt - chunk.startedAt);
    this.chunks.push({ ...chunk, startedAt: start, pcm: chunk.pcm.subarray((start - chunk.startedAt) * 32),
      missingMs: Math.round(chunk.missingMs * fraction), suppressedMs: Math.round(chunk.suppressedMs * fraction) });
    this.through = chunk.endedAt;
    this.chunks = this.chunks.filter(part => part.endedAt > now - 300_000);
    return this.through;
  }
  freeze(startedAt: number, endedAt: number): FrozenCompanionAudio {
    const start = Math.max(startedAt, endedAt - 300_000);
    const pcm = Buffer.alloc(Math.max(0, endedAt - start) * 32);
    let missingMs = start - startedAt, suppressedMs = 0, through = start;
    let status = "unavailable", error: string | undefined;
    for (const chunk of this.chunks) {
      const left = Math.max(start, chunk.startedAt), right = Math.min(endedAt, chunk.endedAt);
      if (right <= left) continue;
      missingMs += Math.max(0, left - through);
      const fraction = (right - left) / (chunk.endedAt - chunk.startedAt);
      missingMs += Math.round(chunk.missingMs * fraction); suppressedMs += Math.round(chunk.suppressedMs * fraction);
      chunk.pcm.copy(pcm, (left - start) * 32, (left - chunk.startedAt) * 32, (right - chunk.startedAt) * 32);
      through = Math.max(through, right); status = chunk.status; error = chunk.error;
    }
    missingMs += Math.max(0, endedAt - through);
    this.chunks = this.chunks.filter(chunk => chunk.endedAt > endedAt);
    let energy = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) { const sample = pcm.readInt16LE(offset); energy += sample * sample; }
    if (!pcm.length || Math.sqrt(energy / (pcm.length / 2)) < 30) return { wav: null, status: status === "ready" ? "silent" : status, missingMs, suppressedMs, error };
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    return { wav, status, missingMs, suppressedMs, error };
  }
}
