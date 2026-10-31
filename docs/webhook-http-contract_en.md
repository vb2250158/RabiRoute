English | [简体中文](webhook-http-contract.md)

# Independent Webhook HTTP endpoints

Status: all five public operations use formal independent listener bindings. Controlled HTTP, discovery, generic invocation and retirement tests have passed. Installed runtime, complete Gateway process deployment and real message delivery require separate acceptance.

Generic Webhook and RabiLink each provide an exact GET readiness query and an exact POST message ingress. RabiLink also provides a GET replies query. The existing message adapter owns each independent listener; these paths are not automatically added to the Manager address.

|Adapter|Default paths|Listener configuration|
|---|---|---|
|Webhook|`/webhook`|`127.0.0.1`; `WEBHOOK_PORT`|
|RabiLink|`/rabilink`, `/rabilink/replies`|`RABILINK_WEBHOOK_HOST`, default `0.0.0.0`; `RABILINK_WEBHOOK_PORT`|

Ports retain their existing fallback configuration. This table is not a runtime address. Port zero requires discovery of the actual bound listener port. The existing readiness response's `port` field continues to report the configured value.

These are public HTTP operations defined by Rabi. The native listener has no additional token or signature validation. Migration adds no feature permissions and preserves authenticated remote access to public Manager APIs. Feishu callbacks and NapCat reverse WebSockets retain their native platform protocols; Manager or remote node credentials must never be forwarded to the platform.

`webhookHttpOwner.ts` owns native HTTP reading and reply semantics, calling the original `acceptWebhookPayload`, RabiLink reply reader and accepted response owner directly. Existing business functions continue to own records, trusted source flags, Route decisions and forwarding.

`webhookNativeOperations.ts` generates exact public contracts for the two profiles. Once the original listener binds, it registers its actual port, native admission and executable owner with `gatewayListenerRuntime`, then dispatches through that same binding. Production publication uses the Gateway's existing identity and supervisor channel; tests explicitly inject the same formal registration service. There are five public operations. Each listener also has one internal rejection contract preserving the original empty 404 for unknown paths or methods. It dispatches no business action, adds no capability and hides no unregistered operation behind a wildcard. The old boolean hook and GET/POST business branches have been removed.

Compatibility includes arbitrary Content-Type, an empty body decoded as `{}`, replacement of invalid UTF-8 bytes, the 1 MiB limit with connection destruction above that limit, existing text 500 responses for parsing and business rejection, and GET requests ignoring unknown query fields and bodies. Paths are only trimmed and given a leading slash; trailing slashes remain, including the resulting double slash in a replies path. The formal native HTTP binding retains these behaviors without substituting the common JSON decoder. Non-native methods including HEAD, OPTIONS and PATCH retain an empty 404.

The generic client selects the actual binding from current discovery and invokes the native listener through the established Manager connection. Native requests carry no node Bearer, Cookie or Agent identity. A stale listener lease returns 409 before business execution. Legacy requests without a lease retain native admission. See [independent listener contracts](external-listener-contracts_en.md).

Retirement refuses new work, closes the original HTTP server and sockets, and waits for accepted callback promises to finish before releasing the original Relay lease. Repeated disposal joins the same cleanup promise. A disconnected socket does not prove business completion.

Focused regression tests use temporary data, port zero and controlled message receivers. Native record tests explicitly disable forwarding and clear fixture Routes. No real QQ, Feishu, Agent or external service is called. See the [API contract and discovery architecture](api-contract-discovery-target-architecture_en.md).

FenneNote is retired; its former listener and two operations are not current configuration entries. Historical records retain their source identifiers.
