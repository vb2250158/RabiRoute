import type { AiuiAssistantRuntime } from './aiui-runtime.js';
import type { PlaybackJob } from './speech-playback.js';
import type { VoiceEvent, VoiceInput, VoiceInteractionOptions, VoiceResponse } from './voice-interaction.js';

export interface ResidentState {
  readonly phase: 'stopped' | 'starting' | 'running' | 'failed' | 'disposed';
  readonly capture: 'stopped' | 'starting' | 'listening' | 'failed';
  readonly generation: number;
  readonly outputEnabled: boolean;
  readonly error: string | null;
}
export type ResidentEvent<Round extends object, Result> =
  | { readonly type: 'state'; readonly state: ResidentState }
  | { readonly type: 'voice'; readonly event: VoiceEvent<Round, Result> };
export interface ResidentServices<Round extends object, Result, Event, Job extends PlaybackJob> {
  runtime: Pick<AiuiAssistantRuntime<Round, Result, Event, Job>, 'asr' | 'tts' | 'releaseSpeech' | 'getState'>;
  /** Release device/process resources; called once even when a cancelled start resolves late. */
  dispose(): void | Promise<void>;
}
export interface ResidentOptions<Round extends object, Result, Event, Job extends PlaybackJob, Timer = unknown> {
  openServices(context: { signal: AbortSignal; generation: number }): Promise<ResidentServices<Round, Result, Event, Job>>;
  onInput(input: VoiceInput<Result>): unknown;
  onEvent?(event: ResidentEvent<Round, Result>): unknown;
  onError?(error: unknown): void;
  outputEnabled?: boolean;
  /** Deadline for both ASR onStart and dispatch completion. Default 15000 ms. */
  captureStartTimeoutMs?: number;
  voiceOptions?: Omit<VoiceInteractionOptions<Round, Result, Event, Job, Timer>,
    'runtime' | 'isActive' | 'onInput' | 'onEvent' | 'onError' | 'outputEnabled'>;
}
export interface ResidentInteraction<Round extends object, Result> {
  start(): Promise<ResidentState>;
  stop(): Promise<void>;
  /** Pause input only; output and admitted native work retain their owners. */
  pauseCapture(): void;
  resumeCapture(): Promise<ResidentState>;
  setOutputEnabled(enabled: boolean): void;
  beginResponse(options?: Parameters<import('./voice-interaction.js').VoiceInteraction<Round, Result, unknown, PlaybackJob>['beginResponse']>[0]): VoiceResponse | null;
  interruptSpeech(reason?: string): boolean;
  getState(): ResidentState;
  subscribe(callback: (event: ResidentEvent<Round, Result>) => unknown): () => void;
  dispose(): Promise<void>;
}
export function createResidentInteraction<Round extends object, Result, Event, Job extends PlaybackJob, Timer = unknown>(
  options: ResidentOptions<Round, Result, Event, Job, Timer>
): ResidentInteraction<Round, Result>;
