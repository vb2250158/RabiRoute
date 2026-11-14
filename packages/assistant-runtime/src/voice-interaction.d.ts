import type { AiuiAssistantRuntime } from './aiui-runtime.js';
import type { ListeningActivation, ListeningLifecycle, ListeningOptions, ListeningEvent } from './listening-lifecycle.js';
import type { PlaybackJob, SpeechPlayback, SpeechPlaybackOptions, SpeechPlaybackInput, SpeechPlaybackEvent } from './speech-playback.js';

export interface VoiceInput<Result = unknown> { readonly text: string; readonly source: 'speech' | 'text'; readonly result?: Result }
export interface VoiceResponseState { id: string; text: string; suppressed: boolean; finished: boolean; retired: boolean }
export interface VoiceResponse {
  readonly id: string;
  /** Retired tokens return false. Text continues after a speech interruption. */
  append(delta: string): boolean;
  /** On cancellation/error use speak:false to release the response without flushing its tail. */
  finish(options?: { speak?: boolean }): boolean;
  getState(): VoiceResponseState;
}
export type VoiceEvent<Round extends object = object, Result = unknown> =
  | { type: 'listening'; event: ListeningEvent<Round> }
  | { type: 'playback'; event: SpeechPlaybackEvent }
  | { type: 'speech-interrupted'; reason: string }
  | { type: 'input'; input: VoiceInput<Result> }
  | { type: 'transcript'; text: string; final: false }
  | { type: 'response'; id: string; text: string; suppressed: boolean; foreground: boolean; finished: boolean };
export interface VoiceInteractionOptions<Round extends object, Result, Event, Job extends PlaybackJob, Timer = unknown> {
  runtime: Pick<AiuiAssistantRuntime<Round, Result, Event, Job>, 'asr' | 'tts' | 'releaseSpeech' | 'getState'>;
  /** Assistant layer owns admission, durable drafts and execution receipts. */
  onInput(input: VoiceInput<Result>): unknown;
  onEvent?(event: VoiceEvent<Round, Result>): unknown;
  onError?(error: unknown): void;
  textOf?(result: Result): string | undefined;
  acceptTranscript?(text: string, phase: 'interim' | 'final'): boolean;
  isActive?(): boolean;
  listening?: Omit<ListeningOptions<Round, Result, Event, Timer>, 'asr' | 'isActive' | 'onCleanupError'>;
  playback?: Omit<SpeechPlaybackOptions<Job, Timer>, 'tts' | 'releaseSpeech' | 'isActive' | 'onCleanupError'>;
  maxResponseChars?: number;
  /** Initially allow audio output (default true). Does not control text or microphone permission. */
  outputEnabled?: boolean;
}
export interface VoiceInteraction<Round extends object, Result, Event, Job extends PlaybackJob> {
  /** Low-level lifecycle access for host UI diagnostics and explicit capture policy. */
  readonly listening: ListeningLifecycle<Round, Result, Event>;
  readonly playback: SpeechPlayback<Job>;
  activate(options?: ListeningActivation<Result, Event>): Round | null;
  /** True means delivered to onInput, not persisted, executed or completed. */
  submitText(text: string): boolean;
  beginResponse(options?: { id?: string; speech?: SpeechPlaybackInput }): VoiceResponse;
  interruptSpeech(reason?: string): boolean;
  /** Mute current and future audio while preserving response text. Re-enabling does not replay muted tokens or start ASR. */
  setOutputEnabled(enabled: boolean): void;
  pauseListening(options?: { graceful?: boolean }): void;
  suspend(): void;
  subscribe(callback: (event: VoiceEvent<Round, Result>) => unknown): () => void;
  getState(): { closed: boolean; enabled: boolean; outputEnabled: boolean; transcript: string; inputPending: boolean;
    listening: ReturnType<ListeningLifecycle<Round, Result, Event>['getState']>;
    playback: ReturnType<SpeechPlayback<Job>['getState']>;
    response: Pick<VoiceResponseState, 'id' | 'text' | 'suppressed'> | null };
  /** Releases voice only; the assistant owner separately disposes its model/session. */
  dispose(): void;
}
export function splitSpeechText(text: string, flush?: boolean): { parts: string[]; rest: string };
export function createVoiceInteraction<Round extends object, Result, Event, Job extends PlaybackJob, Timer = unknown>(
  options: VoiceInteractionOptions<Round, Result, Event, Job, Timer>
): VoiceInteraction<Round, Result, Event, Job>;
