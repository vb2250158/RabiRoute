import type { AgentProtocol, Message, TaskObservation, ToolDeclaration, ToolDecision } from './decision-protocol.js';
export type MaybePromise<T> = T | PromiseLike<T>;
export interface TextChunk { done?: boolean; value?: string | { text?: string } }
export interface TextReader { read(): MaybePromise<TextChunk | undefined>; cancel?(): MaybePromise<unknown> }
export interface HostModel {
  prompt?(input: Message[]): MaybePromise<string>;
  promptStreaming?(input: Message[]): MaybePromise<TextReader | { getReader(): TextReader }>;
  destroy?(): MaybePromise<unknown>;
}
export interface ToolEvent { callId: string; functionName: string; arguments: Record<string, unknown>; isComplete: true }
export interface OutcomeStatus { uncertain: boolean; failed: boolean; terminal: boolean }
export interface ToolPolicy {
  classify(decision: ToolDecision): { mutation: boolean };
  inspectOutcome(result: unknown, decision: ToolDecision): OutcomeStatus;
}
export type TurnState = 'idle' | 'thinking' | 'responding' | 'executing-tool' | 'interjecting' | 'waiting-tool' | 'completed' | 'uncertain' | 'cancelled' | 'failed';
export interface TurnStatus { state: TurnState; toolCount: number; settledToolCount: number; steps: number }
export interface TurnResult {
  state: TurnState; text: string; toolResults: unknown[]; steps?: number;
  /** Session guidance not yet handed to the loop at terminal/cancelled settlement. Caller owns retention; do not auto-replay. */
  pendingGuidance?: string[];
}
export interface InterjectionInput { readonly id: string; readonly scope: string; readonly text: string }
/** No state here certifies presentation, durable settlement, or completion of a requested tool task. */
export type InterjectionResult = Readonly<{ input: Readonly<InterjectionInput>; toolDispatched: false } & (
  | { status: 'answered'; modelInvoked: true; text: string }
  | { status: 'deferred' | 'unconfirmed'; modelInvoked: true; code?: string; protocolFailureReason?: string }
  | { status: 'returned' | 'unavailable'; modelInvoked: false; code?: string }
)>;
export interface InterjectionOptions { assertCurrent?(): void }
export interface TurnLimits {
  requestTimeoutMs?: number; turnTimeoutMs?: number; maxToolCalls?: number; maxSteps?: number;
  /** Answer guidance or independently owned inputs during a tool wait; interjections cannot dispatch tools. */
  interjectWhileWaiting?: boolean;
}
export interface TurnOptions extends TurnLimits {
  /** Synchronous, read-only check of the captured target. Throw on stale identity; async checks are rejected. */
  assertCurrent?(): void;
  /** Original task binding. Independent inputs require an exact match; never infer this from assistant scope. */
  inputScope?: string;
  model: HostModel; protocol: AgentProtocol; toolPolicy: ToolPolicy;
  executeTool(event: ToolEvent): MaybePromise<unknown>;
  tools?: (ToolDeclaration | string)[]; turnId?: string;
  takeGuidance?(): string[];
  onText?(value: { delta: string; text: string }): void;
  onState?(value: TurnStatus): void;
}
export interface AgentTurn {
  run(input: string): Promise<TurnResult>;
  observe(observation: TaskObservation): Promise<TurnResult>;
  /** Signal that the caller-owned takeGuidance queue has changed. Does not transfer its contents. */
  notifyGuidance(): boolean;
  /** Available only during a scoped user turn's tool wait. Caller owns durable reservation and presentation. */
  interject(input: InterjectionInput, options?: InterjectionOptions): Promise<InterjectionResult>;
  cancel(): void;
  getState(): TurnStatus & { acceptingGuidance: boolean };
}
export function createAgentTurnRuntime(options: TurnOptions): AgentTurn;
