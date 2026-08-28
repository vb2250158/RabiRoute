<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.gateway-runtime

Built-in Manager plugin. Instance `manager:gateway-runtime` provides `manager.gateway-runtime@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Generation updates

A new generation acquires the host-resource lease before the old generation releases it. Existing Gateway processes remain running during plugin updates and stop only when the plugin is finally disabled or uninstalled.
