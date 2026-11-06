<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.remote-agent

Built-in Manager plugin. Instance `manager:remote-agent` provides `manager.remote-agent@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

Candidate Hub construction only retains references; it starts no discovery, connection, or task. Formal publication commits the public Hub pointer and restores the previous Hub on failure. Failed candidates reclaim only themselves. Retirement stops this Hub's admission and awaits its own routes, callbacks, and actual socket closure; old cleanup cannot clear or close a new Hub. Repeated shutdown calls join the same cleanup Promise, and forced termination still requires actual socket closure.

Lifecycle behavior is verified with controlled native owners and Plugin Kernel fixtures. The release workflow still owns real remote-device acceptance. Connection authentication, task ownership, and public API permission semantics retain their existing contracts.
