<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.route-control

Built-in Manager plugin. Instance `manager:route-control` provides `manager.route-control@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

The independent Web entry registers Add route, Quick setup, and Open configuration directory actions. The Manager catalog declares their labels and placements. Add route remains available in the topbar when the route list is empty and reuses the existing creation and setup flow; disabling the plugin releases both its entry and actions. A full build synchronizes the entry into this package's `web/client.mjs`, without a separate creation button in the console.

An unsaved new route can be cancelled after the page confirms that the server has neither its ID nor its configuration name. A matching ID or configuration name retains the draft and reports a conflict without deleting the server route. The draft is also retained while a save remains unconfirmed, a read fails, or the Manager identity changes; confirmed saved routes use the managed deletion flow.
