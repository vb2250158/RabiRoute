import type { AsrAdapter, AsrHandlers } from './aiui-runtime.js';

export interface ListeningClock<Timer = unknown> {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): Timer;
  clearTimeout(timer: Timer): void;
}
export type ListeningEndReason = 'end' | 'empty-end-limit' | 'unavailable' | 'create-error'
  | 'start-error' | 'error' | 'start-timeout' | 'handler-error' | 'guard-error';
export type ListeningEvent<Round extends object = object> =
  | { type: 'starting' | 'listening' | 'start-dispatched'; round: Round }
  | { type: 'ended'; round: Round | null; reason: ListeningEndReason; error?: unknown; emptyEnds: number }
  | { type: 'paused'; round: Round | null }
  | { type: 'activation-required' };
export interface ListeningActivation<Result = unknown, Event = unknown> {
  continuous?: boolean;
  interimResults?: boolean;
  startupTimeoutMs?: number;
  /** End and error are lifecycle events, not transcript callbacks. */
  handlers?: Pick<AsrHandlers<Result, Event>, 'onStart' | 'onSpeechStart' | 'onSpeechEnd' | 'onInterim' | 'onFinal'>;
}
export interface ListeningOptions<Round extends object = object, Result = unknown, Event = unknown, Timer = unknown> {
  asr: AsrAdapter<Round, Result, Event>;
  clock?: ListeningClock<Timer>;
  /** Scheduling policy only; false does not discard input from an existing round. */
  canStart?(): boolean;
  /** Owner visibility/lifetime. False retires capture on its next callback. Call pause on hide. */
  isActive?(): boolean;
  onEvent?(event: ListeningEvent<Round>): void;
  onCleanupError?(error: unknown): void;
  /** Positive integer milliseconds; defaults to 250. */
  restartDelayMs?: number;
  /** Empty rounds shorter than this count towards the limit; defaults to 1000. */
  earlyEndMs?: number;
  /** Consecutive early empty rounds before stopping; defaults to 3. */
  maxEmptyEnds?: number;
  /** Deadline for actual start or input, not just start() returning; defaults to 15000. */
  startupTimeoutMs?: number;
}
export interface ListeningLifecycle<Round extends object = object, Result = unknown, Event = unknown> {
  /** Invoke synchronously from a genuine user activation. Native permission remains authoritative. */
  activate(options?: ListeningActivation<Result, Event>): Round | null;
  requestRestart(delayMs?: number): boolean;
  clearRestart(): void;
  /** Retire callbacks before stopping capture; a graceful stop does not forward its final result. */
  pause(options?: { graceful?: boolean }): void;
  dispose(): void;
  getState(): { closed: boolean; desired: boolean; round: Round | null; starting: boolean; restartPending: boolean; emptyEnds: number };
}
export function createListeningLifecycle<Round extends object, Result, Event, Timer = unknown>(
  options: ListeningOptions<Round, Result, Event, Timer>
): ListeningLifecycle<Round, Result, Event>;
