<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.plan-feedback-delivery

Built-in Manager plugin. Instance `manager:plan-feedback-delivery` provides `manager.plan-feedback-delivery@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

A candidate only registers the formal `context.publication` lifecycle. It does not change the enabled flag, replace the recovery owner, or start recovery scans. A synchronous publication failure restores the previous flag, recovery service, and readiness entry point.

Successful publication temporarily disables feedback delivery. The old owner cancels scans, recovery attempts, and retry timers, then joins the actual producers, schedules, and admitted feedback flights. Only after confirmed retirement does the new owner construct its recovery service, load the final persisted failure state, and enable delivery. Old cleanup cannot disable the new owner. A timeout or abort ends a waiter without proving the underlying work has exited; unconfirmed retirement prevents the new recovery loop from starting.

Initial startup still waits for the original plan and route readiness. A previously active recovery service resumes after replacement or revision rollback, while readiness received during handoff is deferred until startup is safe. Existing receipt inspection, missing-message scheduling, retry backoff, persisted failure state, and notification behavior remain with the native business implementation. Late results after cancellation do not emit old-owner change events.

Native `PlanFeedbackRecoveryService.stop()` retains bounded cancellation behavior. Exclusive plugin retirement uses `stopAndJoin()` to await actual work and reuses the native storage-work contract to track a worker's `closed` promise. A rejected result does not mean its process or job has released resources. Repeated retirement shares one cleanup Promise. A read-only Manager neither constructs nor starts recovery.

If recovery cleanup throws, retirement still joins feedback flights accepted at cleanup entry or registered during cleanup, then returns the original cleanup error. Repeated calls retain the same pending or rejected result.
