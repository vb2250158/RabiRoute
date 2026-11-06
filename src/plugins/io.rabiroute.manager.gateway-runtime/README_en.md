<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.gateway-runtime

Built-in Manager plugin. Instance `manager:gateway-runtime` provides `manager.gateway-runtime@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Generation updates

Candidates register only their own control operations; they neither acquire the published enablement lease nor start, stop, or restart Gateways. `context.publication.add` acquires the host-resource lease in the synchronous publication transaction. Publication failure releases only the candidate lease and preserves the previous generation.

Each candidate obtains its own catalog projection through the host's `createGatewayListenerProjection()`. The one Manager-lifetime host owns the original Gateway child's stdout parser, partial-line buffer, and verified listener-contract cache; a projection is visible only while its activation is published. Failed candidates and retired activations dispose only their own projection. They neither dispose the lifetime host, replay stdout, nor restart preserved Gateway processes.

After publication, `afterPublish` waits for the previous activation to retire completely, checks cancellation, then invokes the existing Gateway scheduler subject to Manager readiness and read-only configuration. The new generation acquires its lease before the previous one releases it. Existing Gateway processes remain running during plugin updates; only the last published owner waits for those processes to stop when disabled or uninstalled. Repeated disposal shares one release and join.

Isolated validation in `src/manager/gatewayWearablePublication.test.ts` covers preparation failure, publication rollback, old slow-operation drain, replacement, revision rollback, and final disposal using controlled Gateway callbacks without starting real message endpoints.
