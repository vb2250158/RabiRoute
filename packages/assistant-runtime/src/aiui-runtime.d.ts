import type { AssistantSession, AssistantSessionOptions } from './assistant-session.js';
import type { AssistantConversation, ConversationOptions } from './conversation-runtime.js';
export interface AsrHandlers<Result = unknown, Event = unknown> {
  continuous?: boolean; interimResults?: boolean;
  onStart?(event?: Event): void; onSpeechStart?(event?: Event): void; onSpeechEnd?(event?: Event): void;
  onEnd?(event?: Event): void; onError?(error: unknown, event?: Event): void;
  onFinal?(result: Result, event?: Event): void; onInterim?(result: Result, event?: Event): void;
}
export interface AsrAdapter<Round extends object = object, Result = unknown, Event = unknown> {
  adapterId?: string; mode?: string; getCapability?(): unknown;
  createRound(handlers?: AsrHandlers<Result, Event>): Round;
  start(round: Round): unknown;
  stop(round: Round, options?: { graceful?: boolean }): unknown;
}
export interface SpeechJob {
  task: { abort?(): unknown }; player: { stop?(): unknown; destroy?(): unknown };
}
export interface SynthesisOptions {
  signal?: AbortSignal; onCue?(cue: unknown, event?: unknown): void;
  [key: string]: unknown;
}
export interface TtsAdapter<Job extends SpeechJob = SpeechJob> {
  adapterId?: string; mode?: string; supportsSynthesize?: boolean;
  getCapability?(): unknown; canSynthesize?(): boolean;
  synthesize(text: string, options?: SynthesisOptions): Promise<Job>;
  openStream?(options?: SynthesisOptions): Promise<Job & { input: { append(delta: string): unknown; finish(): unknown } }>;
}
export interface AiuiRuntimeOptions<Round extends object = object, Result = unknown, Event = unknown, Job extends SpeechJob = SpeechJob> {
  asr: AsrAdapter<Round, Result, Event>; tts: TtsAdapter<Job>;
  session?: AssistantSessionOptions;
  /** Cleanup is best effort; async failures are also reported here. */
  onCleanupError?(error: unknown): void;
  /** Speaking or awaiting the current final transcript. Silence alone does not clear it. */
  onInputStateChange?(pending: boolean): void;
}
export interface AiuiAssistantRuntime<Round extends object = object, Result = unknown, Event = unknown, Job extends SpeechJob = SpeechJob> {
  readonly asr: AsrAdapter<Round, Result, Event>; readonly tts: TtsAdapter<Job>;
  readonly session: AssistantSession | null;
  readonly conversation: AssistantConversation | null;
  /** Replaces the model session, not the microphone or backend task. */
  createSession(options: AssistantSessionOptions): AssistantSession;
  /** Requires a current session and adapter-owned durable notification receipts. */
  createConversation(options: Omit<ConversationOptions, 'session'>): AssistantConversation;
  interruptSpeech(): unknown[];
  /** Use the original task/player, or the pending synthesize() Promise. */
  releaseSpeech(output: { task?: object; player?: object }, options?: { abort?: boolean }): { handled: boolean; errors: unknown[] };
  suspendVoice(): unknown[];
  dispose(): unknown[];
  getState(): { closed: boolean; inputPending: boolean; hasRecognitionRound: boolean; hasSpeechOutput: boolean; session: ReturnType<AssistantSession['getState']> | null };
}
export function createAiuiAssistantRuntime<Round extends object, Result, Event, Job extends SpeechJob>(
  options: AiuiRuntimeOptions<Round, Result, Event, Job>
): AiuiAssistantRuntime<Round, Result, Event, Job>;
