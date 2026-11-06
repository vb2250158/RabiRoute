<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.bilibili-history

Built-in Manager plugin. Instance `manager:bilibili-history` provides `manager.bilibili-history@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

Candidate construction and preparation neither pause original jobs nor write bridge state. After formal publication, the `afterPublish` callback registered through `context.publication.add` waits for the original instance to retire, then resumes its latest queue and migrates legacy jobs without a persona. Cleanup is instance-specific; code rollback resumes existing job IDs, cursors, and pairing. See the [history bridge contract](../../../../docs/bilibili-history-bridge_en.md) for APIs and failure recovery.
