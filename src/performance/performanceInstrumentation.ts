export type RecordedPerformanceOperation = {
  operation: string;
  durationMs: number;
  error: boolean;
  time: string;
};

type PerformanceOperationSink = (record: RecordedPerformanceOperation) => void;

let operationSink: PerformanceOperationSink | undefined;
let failedRecords = 0;
let lastFailureAt: string | undefined;

// Bounded diagnostic state; never report through the sink that just failed.
export function performanceOperationStatus(): { failedRecords: number; lastFailureAt?: string } {
  return { failedRecords, lastFailureAt };
}

function normalizedOperationName(value: string): string {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "_")
    .slice(0, 120) || "unknown";
}

export function installPerformanceOperationSink(sink: PerformanceOperationSink): () => void {
  operationSink = sink;
  return () => {
    if (operationSink === sink) operationSink = undefined;
  };
}

export function recordPerformanceOperation(
  operation: string,
  durationMs: number,
  error = false,
  time?: string
): void {
  const sink = operationSink;
  if (!sink) return;
  try {
    sink({
      operation: normalizedOperationName(operation),
      durationMs: Math.max(0, Number(durationMs) || 0),
      error,
      time: time ?? new Date().toISOString()
    });
  } catch {
    failedRecords = Math.min(Number.MAX_SAFE_INTEGER, failedRecords + 1);
    lastFailureAt = new Date().toISOString();
  }
}

export function measureSyncPerformanceOperation<T>(operation: string, action: () => T): T {
  if (!operationSink) return action();
  const startedAt = performance.now();
  try {
    const result = action();
    recordPerformanceOperation(operation, performance.now() - startedAt);
    return result;
  } catch (error) {
    recordPerformanceOperation(operation, performance.now() - startedAt, true);
    throw error;
  }
}

export function measurePerformanceOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
  if (!operationSink) {
    try {
      return Promise.resolve(action());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return measureEnabledPerformanceOperation(operation, action);
}

async function measureEnabledPerformanceOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await action();
    recordPerformanceOperation(operation, performance.now() - startedAt);
    return result;
  } catch (error) {
    recordPerformanceOperation(operation, performance.now() - startedAt, true);
    throw error;
  }
}
