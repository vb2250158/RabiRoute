[简体中文](./plugin-publication-lifecycle.md) | English

# Plugin publication lifecycle

`in_process` is a trusted local-code execution boundary. Business handlers, resource acquisition/cleanup, and publication callbacks complete their synchronous stacks without a fixed wall-clock interrupt that can abandon transactions or skip `finally`. Existing deadlines and cancellation still govern asynchronous work; owners retain and join resources until they actually finish. A timeout does not establish that a write never committed or cleanup completed. Guards for pure result computation do not preempt business transactions. Use the existing `isolated` child-process executor for untrusted or uncooperative code; trusted in-process infinite loops are not promised safe interruption.

Status: implemented in the kernel and public SDK and verified with isolated fixtures. Each plugin owner and the release owner still complete consumer migration, the combined build, and runtime acceptance. This API does not change the application generation or connection permissions.

Synchronous publication applies to `in_process` execution. The current `isolated` RPC has no synchronous cross-process commit protocol, so these callbacks cannot promise atomic Manager pointer changes; calls in that mode must explicitly report unsupported execution. Declarative plugins only register contributions and do not run publication callbacks.

## Public API

Use the types exported by `@rabiroute/plugin-sdk` through `activate(context)`:

```ts
type PluginPublicationContext = Readonly<{
  signal: AbortSignal;
  previousRetirement: Promise<void>;
}>;
type PluginPublication = Readonly<{
  publish(): void;
  rollback(): void;
  afterPublish?(context: PluginPublicationContext): void | Promise<void>;
  retire?(): void | Promise<void>;
}>;
context.publication.add(publication, label?);
```

On first activation, or when no previous activation exists, `previousRetirement` is already resolved. On replacement it covers only the previous activation of the same `instanceId`, awaiting every disposer in its scope, including actual owner drain for requests and streams. It is not a barrier for the whole previous generation and does not redefine completion of an HTTP request, stream, or business operation.

## Host invocation fence

Each `GenerationRuntime.switch(candidates, options)` may supply synchronous `GenerationSwitchOptions.beforePublish?: () => void`, such as `beforePublish: () => invocation.assertCurrent()`. It runs after asynchronous candidate preparation, effect commits, and final readiness validation, immediately before the first publication pointer change, inside the same rollback/cleanup transaction. Throwing on source revocation or identity change cleans up candidates, preserves the old service/contribution graph, and prevents `afterPublish`. Unchanged switches also run this fence.

The fence only checks whether the original invocation source and identity remain current; it adds no per-feature grant. It must be synchronous and read-only. Returning a Promise is explicitly rejected rather than treated as a completed pre-publication check. The caller supplies the actual invocation assertion; the kernel does not infer additional permissions from roles, plans, or capability catalogs.

## Commit and failure

1. `activate` prepares candidate services, contributions, and resources. It must not replace active global pointers, persist business state, pause old jobs, or stop an old supervisor.
2. Existing `effects.add` commits reversible registrations and resources during candidate preparation while the current graph still uses the old activation. Route registrations are isolated by activation identity. This is not the entry point for post-publication work.
3. After service, contribution, and readiness validation, the kernel synchronously calls all candidates' `publish` callbacks and immediately switches the active service/contribution graph. There is no intervening `await` or host publication observer. `publish` only changes reversible pointers synchronously; it performs no I/O, starts no work, does not invoke business logic through the new graph, and returns no Promise.
4. If any `publish` or subsequent staged retirement registration throws, the kernel calls `rollback` in reverse order for every attempted callback, including a throwing `publish` itself. The failed component, its shared Web implementation group and actual dependents are withdrawn; unrelated candidates may still publish. Confirmed previous owners remain callable, while unconfirmed rollback withdraws affected entries and retains cleanup fences. Global publication-fence failures cancel the complete attempted publication. Already staged retirement callbacks remain inert. `rollback` must handle partial writes and undo only its own attempt. Rollback failure is reported as an aggregate error rather than claimed recovery.
5. Once every activation has completed fallible registration preparation, synchronous finalizers that invoke no plugin code confirm publication together, then the kernel switches the active graph and notifies host observers. An activation prepared earlier remains rollback-capable until the whole batch is confirmed. Only after this boundary can `retire` execute; `rollback` is never called afterward.
6. The kernel begins retiring old scopes and calls the new activation's `afterPublish`. An exclusive worker must first await `previousRetirement`, check `signal`, and then start its replacement. Startup without exclusive resources may overlap old request drain. Unchanged activations do not repeat publication callbacks.
7. An old scope aborts before disposing its effects in reverse order. Cleanup errors and timeouts reject `previousRetirement`; timeout is not a successful join. Plugins must actually await their workers and requests, rather than treating an abort request as retirement.
8. The kernel awaits and observes `afterPublish`. Failure follows `runtime_failed`: the new activation and its required consumers are removed, the host receives `onRuntimeFailure`, and new resources are cleaned up. Persistent writes or external actions already performed are not rolled back, and an old graph whose retirement started is not resurrected. `switch()` returns the resulting current generation.

Failed candidates never register `retire`. Private resources acquired during preparation must instead be reclaimed with `effects.adopt`. Replacement, shutdown, and runtime failure all invoke a published activation's `retire` through the same effects scope, after aborting `lifecycle.signal`. Repeated disposal waits for the same cleanup Promise instead of prematurely reporting completion.

After retirement times out, the kernel retains the unconfirmed old owner. Later retries cannot bypass it through `previousRetirement`, even after the failed replacement has been removed. A subsequent retry may pass only after the original disposer actually completes successfully. If the original disposer throws and completion remains unproven, the barrier continues rejecting; elapsed time alone never resumes exclusive startup.

Runtime shutdown also checks unconfirmed owners already removed from the active graph; an empty graph is not proof of completed shutdown. `GenerationRuntime.dispose()` rejects with shutdown diagnostics while such cleanup remains unconfirmed. An owner that actually completed successfully before shutdown no longer blocks it. Repeated calls return the same Promise and preserve the first shutdown failure rather than reporting success merely because the disposed flag was set.

## Ownership and asynchronous startup

`rollback` restores an unpublished attempt; `retire` releases a previously published activation. Old retirement must not unconditionally clear a new global pointer, stop a new shared runtime, or restore persistent job state. Retain actual resource objects and activation identity, and release them only after checking ownership.

```ts
let previousOwner;
let ownedWorker;
context.publication.add({
  publish() {
    previousOwner = bridge.current; // Capture during commit, not preparation.
    bridge.current = service;
  },
  rollback() {
    if (bridge.current === service) bridge.current = previousOwner;
  },
  async afterPublish({ previousRetirement, signal }) {
    await previousRetirement;
    signal.throwIfAborted();
    ownedWorker = await service.startWorker(signal);
  },
  async retire() {
    await ownedWorker?.stopAndJoin();
    if (bridge.current === service) bridge.current = undefined;
  }
}, "service owner");
```

Here `bridge` is an existing stable host bridge, while `service` and `ownedWorker` belong to the current activation. If `startWorker` partially succeeds before throwing, the plugin must retain acquired resources for `retire` or `effects.adopt`. Async callbacks must terminate, respond to cancellation, and await background work; unobserved tasks outside the scope are unsupported.

`createPluginTestHarness()` covers single-plugin publication ordering and cleanup. Use `GenerationRuntime` fixtures for cross-revision atomicity, retaining the old graph on failure, and actual request/stream drain. Arbitrary third-party code can observe intermediate state if explicitly called inside synchronous callbacks, so callbacks must not invoke external observers or re-enter business logic. This contract is not a JavaScript sandbox.
