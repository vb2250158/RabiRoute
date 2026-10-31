<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.diagnostics

Instance `manager:diagnostics` provides `manager.diagnostics@1`. `operations.mjs` owns the HTTP contract and handler for `/api/gateways`; changing this query does not require changing the host business provider table.

The plugin reads existing Gateway state through `host.manager.gateway-status@1.readStatuses()`, without copying runtime state, configuration, or caches. It registers operations through the SDK's `host.manager.operations@1`; registration disposal follows the plugin effect lifecycle. The common API ingress retains authentication ownership. Owner failures propagate to the existing API error handler rather than becoming empty success responses.

The core plugin owns `/meta` independently of this plugin's lifecycle. Page contributions retain their contract; this backend pilot does not replace Web resources. Built-package loading, publication, unloading, and installed-runtime readback require separate evidence; source tests do not prove installed activation.
