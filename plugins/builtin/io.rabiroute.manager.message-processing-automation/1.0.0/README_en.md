<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.message-processing-automation

Built-in Manager plugin. Instance `manager:message-processing-automation` provides `manager.message-processing-automation@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Publication and reminder lifetime

Candidates only construct the two native reminder services. They do not subscribe to plan updates, read pending reminder collections or start timers. Synchronous `publish/rollback` callbacks registered through `context.publication.add` switch or restore both shared service pointers together; failed candidates preserve the original services and subscription.

`afterPublish` waits for the previous activation's `previousRetirement`, then checks cancellation and ownership of both pointers before subscribing to plan updates and starting request and knowledge-callback reminders. Partial startup failure removes the new activation through the runtime failure path and cleans up both services; executed actions are not described as rolled back.

Retirement stops plan-update admission, removes its own subscription and joins both native services, pending startup reads and accepted plan-processing work. A disconnected caller or subscription does not end original work. An old instance clears shared pointers only while they still refer to its own services. Repeated cleanup returns the same Promise without stopping a new subscription or reminders. Plan-processing failures use the existing operational log.

## Validation scope

Controlled regressions cover candidate failure, final readiness rejection, synchronous publication rollback, replacement and revision rollback, original plan work and reminder delivery, partial startup failure and repeated cleanup. Tests use actual native reminder services with controlled timers and delivery functions, without real Agent or platform sends. Full builds and installed-version acceptance are recorded separately.
