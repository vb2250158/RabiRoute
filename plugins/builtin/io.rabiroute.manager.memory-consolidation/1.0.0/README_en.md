<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.memory-consolidation

Built-in Manager plugin. Instance `manager:memory-consolidation` provides `manager.memory-consolidation@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Publication and scheduler lifetime

A candidate only constructs the native scheduler and defers its execution. It does not replace the active shared pointer, scan memories, create consolidation runs, deliver to an Agent or stop shared manual-trigger processes. Synchronous `publish/rollback` callbacks registered through `context.publication.add` switch or restore the scheduler pointer; later candidate failure preserves the original scheduler.

`afterPublish` waits for `previousRetirement`, cancellation and current ownership checks before releasing the scheduler's startup gate. First startup retains the Manager's existing readiness call; replacement and revision rollback inherit the previous scheduler's startup intent. Calls to `start/reschedule/runOnce` cannot run early while retirement is pending. Ship this plugin together with the native scheduler exposing `deferActivation/activate/isStarted`.

If an installed factory lacks these methods or its predecessor lacks `isStarted`, the candidate returns `memory_scheduler_activation_requires_switch` and preserves the original instance. The new `activationDeferred/startRequested` fields cannot be reconstructed reliably from an idle older instance: it may still await readiness or have already run with no pending targets. This implementation provides no such state migration. That specific boundary requires a Host-controlled application switch; schedulers with the current lifecycle state still use native hot replacement.

Retirement stops admission to the original scheduler, then stops the original `manager:memory-consolidation` manual-trigger process group, joining both scheduler work and confirmed process exit before reporting errors. This native process owner keeps its existing value; a new activation reuses it only after the previous owner has fully retired. Candidates that never acquired the owner do not call `stopOwner`. Repeated old cleanup returns the same Promise and cannot stop later processes. After scheduler stop, late evaluation or run-creation results are joined without creating or delivering subsequent work.

## Validation scope

Controlled regressions cover candidate failure, final readiness rejection, synchronous publication rollback, replacement and revision rollback, original process exit, concurrent readiness calls, repeated cleanup and late asynchronous results. Ownership tests use the actual native registry with controlled children and do not invoke real Agents. Full builds and installed-version acceptance are recorded separately.
