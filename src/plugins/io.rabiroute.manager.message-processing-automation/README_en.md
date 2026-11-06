<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.message-processing-automation

Built-in Manager plugin. Instance `manager:message-processing-automation` provides `manager.message-processing-automation@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Publication and reminder lifetime

This plugin owns plan-update subscriptions and knowledge-callback reminders. Agent requests are shown once per original requestId by the target task's Stop Hook. Background timers no longer chase these requests or send historical requests after restart.

Candidates construct only the knowledge-callback service. Synchronous `publish/rollback` callbacks switch or restore its shared pointer. `afterPublish` waits for the previous activation to retire before subscribing to plan updates and starting knowledge callbacks. Startup does not read Agent request storage. Startup failure removes the affected activation through the existing runtime failure path and cleans up its own work.

Retirement removes its own plan subscription and joins accepted plan work, knowledge-callback delivery and startup work. An old instance clears the shared pointer only while it still refers to its own service. Repeated cleanup returns the same Promise without stopping a new instance. Plan-processing failures use the existing operational log.

## Validation scope

Controlled regressions cover candidate failure, final readiness rejection, synchronous publication rollback, replacement and revision rollback, original plan work and reminder delivery, partial startup failure and repeated cleanup. Tests use actual native reminder services with controlled timers and delivery functions, without real Agent or platform sends. Full builds and installed-version acceptance are recorded separately.
