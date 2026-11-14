import type { TaskInputPacket, TaskInputResult, TaskUtteranceBuffer, createTaskUtteranceBuffer } from './task-input.js';

export interface TaskInputHandoff { handoffId: string; scope: string; text: string }
export interface TaskHandoffResult {
  status: 'retained' | 'unconfirmed'; handoffId: string; packet: TaskInputPacket;
  code?: string; notificationError?: string;
}
export interface PendingTaskHandoff {
  readonly handoffId: string; readonly packet: TaskInputPacket;
  readonly status: 'retaining' | 'unconfirmed'; readonly completion: Promise<TaskHandoffResult>;
}
export interface TaskInputHandoffBuffer extends Omit<TaskUtteranceBuffer, 'flush' | 'dispose' | 'getState'> {
  flush(): Promise<TaskHandoffResult | Extract<TaskInputResult, { accepted: false }>>;
  retryHandoff(id: string): Promise<TaskHandoffResult>;
  restoreHandoff(entry: { handoffId: string; packet: TaskInputPacket }): void;
  handoffs(): PendingTaskHandoff[];
  dispose(): { draft: TaskInputPacket | null; handoffs: PendingTaskHandoff[] };
  getState(): ReturnType<TaskUtteranceBuffer['getState']> & { handoffs: number };
}
export function createTaskInputHandoffBuffer(options:
  Omit<Parameters<typeof createTaskUtteranceBuffer>[0], 'onReady'> & {
    /** Caller supplies collision-resistant identifiers, preserved with drafts for recovery. */
    createHandoffId(): string;
    /** Persist under the original scope. Must be idempotent by handoffId and reject conflicting text. */
    retain(input: TaskInputHandoff): PromiseLike<{ status: 'retained'; handoffId: string }>;
    onSettled?(result: TaskHandoffResult): void;
    capacity?: number;
  }
): TaskInputHandoffBuffer;
