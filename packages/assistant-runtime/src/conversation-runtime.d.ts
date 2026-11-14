import type { AssistantSession } from './assistant-session.js';
import type { TaskObservation } from './decision-protocol.js';
import type { MaybePromise, TurnResult } from './turn-runtime.js';

/** The adapter owns durable display receipts, scoped to its backend identity. */
export interface ObservationReceipts {
  has(scope: string, id: string): MaybePromise<boolean>;
  acknowledge(scope: string, id: string): MaybePromise<boolean>;
}
export interface ConversationOptions {
  session: AssistantSession;
  /** Stable assistant account/Host/profile domain. Adapters verify each task's membership before observe(). */
  scope: string;
  receipts: ObservationReceipts;
  capacity?: number;
  receiptTimeoutMs?: number;
}
export type ObservationResult =
  | { status: 'processed'; observation: TaskObservation; result: TurnResult }
  | { status: 'cancelled' | 'acknowledged'; observation: TaskObservation };
/** Retain the original draft. This error does not certify whether earlier operations ran. */
export interface ConversationRunError extends Error {
  code: string; cause: unknown; originalInput: string; pendingGuidance?: string[];
}
export interface AssistantConversation {
  /** Require exactly true before relying on run({ assertCurrent }) with older installed packages. */
  readonly supportsTurnGuard: boolean;
  readonly supportsInterjectionReceipts: boolean;
  run(text: string, options?: Parameters<AssistantSession['run']>[1]): Promise<TurnResult>;
  guide(text: string): ReturnType<AssistantSession['guide']>;
  interject: AssistantSession['interject'];
  observe(observation: TaskObservation): Promise<ObservationResult>;
  /** Call after presentation. Failure retains the generated result for explicit acknowledgement retry. */
  acknowledge(id: string): Promise<{ acknowledged: true }>;
  setListening(value: boolean): void;
  dispose(): void;
  getState(): { closed: boolean; listening: boolean; active: 'user' | 'observation' | null;
    queuedUsers: number; queuedObservations: number; retainedObservations: number };
}
export function createAssistantConversation(options: ConversationOptions): AssistantConversation;
