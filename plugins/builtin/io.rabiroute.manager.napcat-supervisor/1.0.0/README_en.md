<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.napcat-supervisor

Built-in Manager plugin. Instance `manager:napcat-supervisor` provides `manager.napcat-supervisor@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

Candidate preparation neither starts a guardian nor changes the global start/stop functions. Formal `context.publication` publication synchronously installs this activation's functions and captures its paired control context. Synchronous publication failure restores the previous functions by reference identity. Old cleanup stops only its own instance and cannot clear the new instance's functions.

After publication, `afterPublish` waits for `previousRetirement` to confirm complete shutdown of the previous supervisor before admitting the new guardian. Start requests during that wait cannot bypass the barrier. Retirement failure or timeout rejects the barrier and leaves the new guardian unstarted; the kernel handles the failure. Read-only mode or disabled autostart installs no supervisor.

Startup login runs only after both the Manager listener and Route catalog are ready. Each activation attempts startup login once; recovery of the same guardian does not repeat it. Retirement cancels and joins its guardian. The original `NapcatLifecycleOwner` continues to own bindings and QQ process lifetime. Controlled same-Manager replacement, rollback and failed-candidate regressions are in `src/manager/napcatPluginPublication.test.ts` and use no real accounts.
