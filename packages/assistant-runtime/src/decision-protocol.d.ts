export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface TaskObservation {
  /** Stable event identity including backend, workspace/task identity and durable event sequence. */
  id: string;
  /** Assistant account/Host/profile trust domain, shared by its authorized tasks. */
  scope: string;
  kind: string; status: string; body: unknown;
}
export function snapshotTaskObservation(value: TaskObservation): TaskObservation;
export interface ToolDeclaration {
  type?: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown>; [key: string]: unknown };
}
export interface ModelOptions { initialPrompts?: Message[]; tools?: ToolDeclaration[]; [key: string]: unknown }
export interface ToolDecision {
  protocol: string; requestId: string; kind: 'tool'; name: string;
  arguments: Record<string, unknown>; say?: string;
}
export interface FinalDecision { kind: 'final'; text: string; protocol?: string; requestId?: string; plain?: boolean }
export interface AgentProtocol {
  readonly id: string;
  modelOptions(options?: ModelOptions, tools?: ToolDeclaration[]): { options: ModelOptions; tools: ToolDeclaration[] };
  input(requestId: string, data: Record<string, unknown>): Message[];
  parseDecision(raw: string, requestId: string): ToolDecision | FinalDecision;
  /** Optional for legacy protocols. Without this parser, structured interjection is unavailable. */
  parseInterjection?(raw: string, requestId: string, inputId: string): { disposition: 'answer'; text: string } | { disposition: 'defer' };
}
export function createAgentProtocol(options?: { id?: string; introduction?: string; toolInstructions?: string }): AgentProtocol;
export function canonicalAgentIntent(value: unknown): string | undefined;
/** Closed diagnostic code only; never returns raw provider/model content. */
export function getAgentProtocolFailureReason(error: unknown): string | null;
