export interface TaskInputSegment { resultId: string; text: string }
export interface TaskInputPacket {
  readonly scope: string; readonly silenceMs: number; readonly text: string;
  readonly segments: readonly Readonly<TaskInputSegment>[];
}
export function snapshotTaskInputPacket(packet: TaskInputPacket, scope: string): TaskInputPacket;
export type TaskInputResult = { accepted: true; duplicate?: true } | { accepted: false; reason: string };
export interface TaskUtteranceBuffer {
  speechStart(): boolean;
  speechEnd(): boolean;
  interim(text: string): boolean;
  final(segment: TaskInputSegment): TaskInputResult;
  configure(settings: { silenceMs: number }): { silenceMs: number; deferred: boolean };
  /** Same binding only; restoration never submits automatically. */
  restoreDraft(packet: TaskInputPacket): void;
  /** Explicitly resume the retained draft's silence timer. */
  resumeDraft(): boolean;
  /** Explicit retry/submit. Refuses while speaking or interim text is unresolved. */
  flush(): TaskInputResult;
  peek(): TaskInputPacket | null;
  /** Returns unsubmitted finals to the caller; never cancels backend work. */
  dispose(): TaskInputPacket | null;
  getState(): { closed: boolean; speaking: boolean; pendingInterim: boolean; segments: number;
    silenceMs: number; configuredSilenceMs: number; retainedReason: string };
}
export function createTaskUtteranceBuffer(options: {
  /** Opaque task/Host/connection binding, not a credential. Create a new instance on focus change. */
  scope: string;
  silenceMs?: number;
  /** Synchronous handoff to an application queue. True does not mean backend delivery. */
  onReady(packet: TaskInputPacket): boolean;
  onInterrupt?(): void;
  schedule?(callback: () => void, ms: number): unknown;
  unschedule?(handle: unknown): void;
}): TaskUtteranceBuffer;
