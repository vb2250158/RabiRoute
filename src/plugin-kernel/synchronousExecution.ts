import { getTimeoutMs } from "./runtimeTimeouts.js";
import { Script, createContext, type Context } from "node:vm";

/** Trusted in-process callbacks must return control promptly to the Manager event loop. */
export const DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS = 100;

const invoke = new Script("invoke()", { filename: "plugin-synchronous-work" });
type InvocationContext = { context: Context; setOperation(operation?: () => unknown): void };
const idleContexts: InvocationContext[] = [];
const MAX_IDLE_CONTEXTS = 8;

function invocationContext(): InvocationContext {
  const reusable = idleContexts.pop();
  if (reusable) return reusable;
  let current: (() => unknown) | undefined;
  return {
    context: createContext({ invoke: () => {
      const operation = current;
      if (!operation) throw new Error("Plugin synchronous invocation is no longer active.");
      return operation();
    } }),
    setOperation(operation) { current = operation; }
  };
}

export class PluginSynchronousExecutionTimeoutError extends Error {
  readonly code = "PLUGIN_SYNCHRONOUS_EXECUTION_TIMEOUT";

  constructor(readonly operation: string, readonly timeoutMs: number, cause: unknown) {
    super(`Plugin synchronous work exceeded ${timeoutMs}ms: ${operation}.`, { cause });
    this.name = "PluginSynchronousExecutionTimeoutError";
  }
}

/**
 * Interrupts the callback's current synchronous JavaScript stack, preserving its
 * closure, argument references and AsyncLocalStorage context. A returned Promise
 * remains owned by the caller: native blocking calls and continuations after an
 * await are not made interruptible by this guard. This is not a security sandbox.
 */
export function runPluginSynchronousWork<T>(
  operation: () => T,
  label: string,
  timeoutMs = getTimeoutMs("backend.plugin-kernel.synchronousExecution.DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS", DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS)
): T {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Plugin synchronous timeout must be a positive 32-bit integer in milliseconds.");
  }
  // Active/nested invocations each own their context. Reuse only after the
  // synchronous stack returned; Promise continuations retain the caller's realm.
  // This avoids allocating a complete VM global object on every API request.
  const invocation = invocationContext();
  let completed = false;
  let failed = false;
  let value!: T;
  let failure: unknown;
  invocation.setOperation(() => {
    try {
      value = operation();
      completed = true;
      return value;
    } catch (error) {
      failed = true;
      failure = error;
      completed = true;
      throw error;
    }
  });
  try {
    return invoke.runInContext(invocation.context, { timeout: timeoutMs }) as T;
  } catch (error) {
    // The VM watchdog uses elapsed wall time. OS scheduling can delay the VM's
    // return after our callback already completed; retain that actual result.
    // Never repeat the callback to determine whether it committed any work.
    if (completed) {
      if (failed) throw failure;
      return value;
    }
    if (error && typeof error === "object" && "code" in error
      && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new PluginSynchronousExecutionTimeoutError(label, timeoutMs, error);
    }
    throw error;
  } finally {
    invocation.setOperation();
    if (idleContexts.length < MAX_IDLE_CONTEXTS) idleContexts.push(invocation);
  }
}
