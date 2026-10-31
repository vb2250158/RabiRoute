<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.agent-adapter-catalog

Built-in Manager plugin. Instance `manager:agent-adapter-catalog` provides `manager.agent-adapter-catalog@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

The plugin declares and registers `GET /api/scan/agents`, `GET /api/scan/agents/dsh`, and `GET /api/scan/agents/grokBot`. The dedicated Grok Bot scan reads native cloud sessions for the current account using explicit filters; it does not create a Bot, task, or replacement Runtime.

Candidate preparation creates only this instance's catalog service and hidden route registrations; it neither replaces the active pointer nor starts a scan. Publication switches the pointer with the active graph and restores the previous service on failure. Retirement stops only its own instance, begins route and service cleanup together, and awaits both actual completions. Repeated stop calls share one result, and old cleanup cannot clear a new instance's pointer.

Lifecycle behavior is verified with controlled native owners and real Plugin Kernel fixtures. The release workflow completes the combined build and target runtime acceptance. Scan, connection, and Hook operations retain their existing API and permission contracts.
