<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.agent-adapter-catalog

Built-in Manager plugin. Instance `manager:agent-adapter-catalog` provides `manager.agent-adapter-catalog@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

The plugin declares and registers `GET /api/scan/agents`, `GET /api/scan/agents/dsh`, and `GET /api/scan/agents/grokBot`. The dedicated Grok Bot scan reads native cloud sessions for the current account using explicit filters; it does not create a Bot, task, or replacement Runtime.
