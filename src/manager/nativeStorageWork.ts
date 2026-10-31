import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { pending: Set<Promise<void>>; resultSettled: boolean; close(): void };
const scopes = new AsyncLocalStorage<Scope | undefined>();
const closures = new WeakMap<Promise<unknown>, Promise<void>>();

/** Observe original jobs without changing their result deadline or cancellation policy. */
export function observeNativeStorageWork(closed: Promise<void>): void {
  const scope = scopes.getStore();
  if (!scope || scope.pending.has(closed)) return;
  scope.pending.add(closed);
  void closed.then(() => {
    scope.pending.delete(closed);
    if (scope.resultSettled && scope.pending.size === 0) scope.close();
  });
}

/** Release at actual worker job completion or confirmed process close, never just rejection. */
export function beginNativeStorageWork(): Readonly<{ closed: Promise<void>; release(): void }> {
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  observeNativeStorageWork(closed);
  return { closed, release };
}

export function attachNativeStorageWork<T>(result: Promise<T>, closed: Promise<void>): Promise<T> {
  closures.set(result, closed);
  return result;
}

export function nativeStorageWorkClosed(result: Promise<unknown>): Promise<void> | undefined {
  return closures.get(result);
}

/** Shared background catalog initialization is owned by its service, not a requesting HTTP lease. */
export function withoutNativeStorageWork<T>(run: () => T): T {
  return scopes.run(undefined, run);
}

export function captureNativeStorageWork<T>(run: () => Promise<T>): Readonly<{ result: Promise<T>; closed: Promise<void> }> {
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const scope: Scope = { pending: new Set(), resultSettled: false, close };
  const result = scopes.run(scope, () => Promise.resolve().then(run));
  const settled = () => {
    scope.resultSettled = true;
    if (scope.pending.size === 0) scope.close();
  };
  void result.then(settled, settled);
  return { result, closed };
}
