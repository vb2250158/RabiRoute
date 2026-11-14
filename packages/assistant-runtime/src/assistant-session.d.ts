import type { AgentProtocol, ModelOptions, TaskObservation, ToolDeclaration } from './decision-protocol.js';
import type { AgentTurn, HostModel, MaybePromise, ToolEvent, ToolPolicy, TurnLimits, TurnResult, TurnStatus } from './turn-runtime.js';
export interface AssistantProfile { systemPrompt: string; modelOptions?: ModelOptions; [key: string]: unknown }
/** Thrown only when a failed run also returns unconsumed session guidance. */
export interface AssistantRunError extends Error { code: string; cause: unknown; pendingGuidance: string[] }
export interface InitializationContext { profile: AssistantProfile; signal: AbortSignal }
export interface ToolAdapter {
  tools: ToolDeclaration[];
  executeTool(event: ToolEvent): MaybePromise<unknown>;
  toolPolicy: ToolPolicy;
  /** Release this client only; do not cancel dispatched backend work. */
  dispose?(): MaybePromise<unknown>;
}
export interface AssistantSessionOptions {
  profile: AssistantProfile;
  createModel(options: ModelOptions, context: InitializationContext): MaybePromise<HostModel>;
  discoverTools(context: InitializationContext): MaybePromise<ToolAdapter>;
  protocol?: AgentProtocol; sessionId?: string; initializationTimeoutMs?: number; limits?: TurnLimits;
  onText?(value: { delta: string; text: string }): void;
  onState?(value: TurnStatus): void;
}
export interface AssistantSession {
  readonly supportsTurnGuard: true;
  readonly supportsInterjectionReceipts: true;
  ready(): Promise<{ ready: true; toolCount: number }>;
  run(input: string, options?: {
    /** Capture the original target in this synchronous check. Throw when its binding is stale. */
    assertCurrent?(): void;
    limits?: TurnLimits; turnId?: string; inputScope?: string; takeGuidance?(): string[];
    onText?(value: { delta: string; text: string }): void;
    onState?(value: TurnStatus): void;
  }): Promise<TurnResult>;
  /** Summarize adapter facts. This turn cannot execute tools or consume user guidance. */
  observe(observation: TaskObservation, options?: {
    assertCurrent?(): void;
    limits?: TurnLimits; turnId?: string;
    onText?(value: { delta: string; text: string }): void;
    onState?(value: TurnStatus): void;
  }): Promise<TurnResult>;
  guide(text: string): { accepted: true } | { accepted: false; reason: 'idle' | 'finishing' | 'full' };
  /** Wake a waiting tool turn after adding to an external takeGuidance queue. */
  notifyGuidance(): boolean;
  interject: AgentTurn['interject'];
  configure(profile: AssistantProfile): { applied: boolean; deferred: boolean };
  refreshTools(): { applied: boolean; deferred: boolean };
  cancel(): void;
  dispose(): void;
  getState(): { closed: boolean; busy: boolean; ready: boolean; pendingConfiguration: boolean; turn: ReturnType<AgentTurn['getState']> | null };
}
export function createAssistantSession(options: AssistantSessionOptions): AssistantSession;
