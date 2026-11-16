export function redactCallValue(value: unknown, depth?: number, visited?: WeakSet<object>, secrets?: string[]): unknown;
export function currentCallObservation(): { callId: string; source: string; toolName?: string; target: { key: string } } | undefined;
export function createClientCallRecorder(options: { source: string; directory?: string; targetKey: string; redactValues?: string[]; flushBudgetMs?: number; send(value: unknown, options: { signal: AbortSignal }): Promise<any> }): {
  run<T>(metadata: Record<string, unknown>, action: () => Promise<T>): Promise<T>;
  setTarget(key: string): void;
  flush(options?: { signal?: AbortSignal; budgetMs?: number }): Promise<void>;
  close(): Promise<void>;
};
