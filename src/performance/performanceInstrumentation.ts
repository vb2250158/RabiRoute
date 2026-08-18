export type RecordedPerformanceOperation = {
  operation: string;
  durationMs: number;
  error: boolean;
  time: string;
};

type PerformanceOperationSink = (record: RecordedPerformanceOperation) => void;

let operationSink: PerformanceOperationSink | undefined;

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
  time = new Date().toISOString()
): void {
  operationSink?.({
    operation: normalizedOperationName(operation),
    durationMs: Math.max(0, Number(durationMs) || 0),
    error,
    time
  });
}

export function measureSyncPerformanceOperation<T>(operation: string, action: () => T): T {
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

export async function measurePerformanceOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
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
