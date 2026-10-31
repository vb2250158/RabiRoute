<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.rabilink-relay

Built-in Manager plugin. Instance `manager:rabilink-relay` provides `manager.rabilink-relay@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

Candidates prepare only their own Peer instance, video receiver, and routes. Publication uses the SDK's `context.publication.add`: synchronous `publish/rollback` switches or restores the Peer pointers and synchronization callback inside the same Manager. After publication, LAN discovery and Relay synchronization start only after the previous activation fully retires. Preparation or pointer publication failure preserves the previous instance; startup failure after publication follows kernel runtime-failure handling.

Retirement releases only the activation's own routes and native sessions, joining accepted requests, streams, connection attempts, and actual HTTP/WebSocket producers. Only the owner of the current synchronization callback may stop the shared Relay/LAN services; an old activation cannot close its replacement. This lifecycle does not change the public API capabilities available to authenticated remote connections.

Isolated verification: `node --import tsx --test --test-concurrency=1 src/peerTunnel/pluginRuntime.test.ts` covers candidate failure, publication rollback, successful replacement, old slow-request drain, native HEAD, and actual cancellation cleanup without connecting to real remote peers. Installed-runtime acceptance belongs to the coordinated publication workflow.
