import type { SpeechJob, TtsAdapter } from './aiui-runtime.js';
import type { ListeningClock } from './listening-lifecycle.js';

interface PlaybackEvents {
  addEventListener?(name: string, callback: (event?: unknown) => void, options?: { once?: boolean }): void;
  removeEventListener?(name: string, callback: (event?: unknown) => void): void;
}
export interface PlaybackJob extends SpeechJob {
  task: SpeechJob['task'] & PlaybackEvents & { state?: string; finished?: PromiseLike<{ duration?: number }> };
  player: SpeechJob['player'] & {
    play(): unknown; stop?(): unknown;
    audioPlayer?: PlaybackEvents & {
      onEnded?(callback: () => void): void;
      onError?(callback: (error?: unknown) => void): void;
      onCanplay?(callback: () => void): void;
    };
  };
}
export interface SpeechPlaybackInput {
  mode?: 'enqueue' | 'immediate';
  voice?: string; volume?: number;
  audio?: { [key: string]: unknown };
  /** Cancellation and subtitle callbacks are owned by this lifecycle. */
  signal?: never; onCue?: never;
  [key: string]: unknown;
}
export type SpeechPlaybackEvent = { id?: number; text: string } & (
  | { type: 'synthesizing' | 'play-requested' | 'ended' | 'idle' | 'cancelled' | 'unavailable' }
  | { type: 'cue'; cue: unknown }
  | { type: 'error'; error: unknown }
);
export interface SpeechPlaybackOptions<Job extends PlaybackJob = PlaybackJob, Timer = unknown> {
  tts: TtsAdapter<Job>;
  /** Use runtime.releaseSpeech when tts is runtime.tts to keep cleanup with its resource owner. */
  releaseSpeech?(output: { task?: object; player?: object }, options: { abort: boolean }): { handled: boolean } | undefined;
  clock?: Pick<ListeningClock<Timer>, 'setTimeout' | 'clearTimeout'>;
  isActive?(): boolean;
  onEvent?(event: SpeechPlaybackEvent): void;
  onCleanupError?(error: unknown): void;
  estimateDurationMs?(text: string): number;
  synthesisTimeoutMs?(): number;
  playbackTimeoutMs?(fallback: number): number;
}
export interface SpeechPlayback<Job extends PlaybackJob = PlaybackJob> {
  /** Stream text into one provider session; cancellation retains the same playback owner. */
  beginStream(options?: SpeechPlaybackInput): { append(delta: string): boolean; finish(): boolean };
  /** True means accepted for output, not played or heard. Errors arrive via onEvent. */
  speak(text: string, options?: SpeechPlaybackInput): boolean;
  /** Clears queued output and retires current synthesis/player. Does not touch input or work. */
  cancel(): void;
  dispose(): void;
  getState(): { closed: boolean; active: boolean; queued: number; text: string;
    task: Job['task'] | Promise<Job> | null; player: Job['player'] | null };
}
export function estimateSpeechDurationMs(text: string): number;
export function createSpeechPlayback<Job extends PlaybackJob, Timer = unknown>(options: SpeechPlaybackOptions<Job, Timer>): SpeechPlayback<Job>;
