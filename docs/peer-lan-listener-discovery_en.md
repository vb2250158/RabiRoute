English | [简体中文](peer-lan-listener-discovery.md)

# Peer LAN listener discovery

For integration developers and maintainers. The source helper, listener seams and controlled loopback tests are implemented. Manager integration and packaged runtime acceptance are verified separately.

Peer LAN uses one existing HTTP / WebSocket listener for two native transport protocols:

|Method and path|Original protocol owner|
|---|---|
|POST `/api/rabilink/peer/receive`|Original encrypted Peer dispatcher: application packet authentication, target, expiry, generation and transport control checks|
|GET Upgrade `/api/rabilink/peer/tunnel/socket`|Original Peer tunnel: application bootstrap, public-key handshake, connection and socket lifetime|

Unified discovery provides one `listeners[]` entry with `protocol: "rabilink-peer-lan"`, `invocation: "discovery-only"` and native authentication. It contributes **zero public business operations**. This discovery label does not change the wire protocol. Node Bearer credentials do not replace the native Peer handshake. Authenticated remote connections retain access to all public Manager APIs under the existing contract.

`peerLanListenerMetadata.ts` only manages that metadata record through the formal `registerExternalListener` API. It contains no message handler, upgrade handler or new RPC dispatcher. Original Peer code continues to own HTTP ingress, WebSocket handshakes, sockets and shutdown. Its OpenAPI external listener entry retains empty `paths`.

`PeerLanServer.boundAddress()` returns the address and port of the actual listening socket, or `undefined` when it is not listening. It is separate from the candidate addresses in `peerUrls()`. Port zero uses the operating system's assigned port. Wildcard bind addresses are not published as connectable hostnames; explicit loopback bindings retain their loopback address. `subscribeStatus()` adds an observer only; unsubscribing does not close the listener.

## Lifecycle integration

Each Peer activation constructs one helper using its original `PluginIdentity`, the original `PeerLanServer`, the formal operations service and a catalog refresh callback.

1. Candidate preparation only constructs the helper.
2. After publication and `previousRetirement`, the original `peer.start()` calls the helper's `start()`. It subscribes and immediately reads the current socket. A socket surviving plugin replacement therefore receives a metadata lease owned by the new activation.
3. An address change or listener stop withdraws the old lease before disposing its registration. Status callbacks register under the captured activation, preventing an old socket's asynchronous context from assigning metadata to its predecessor.
4. The original Peer's `stopAccepting()` calls the helper's matching method, and its `stop()` awaits the helper's `stop()`. Repeated stops join the same cleanup promise.

Stopping the helper removes only its own subscription and metadata lease. It closes neither the original listener nor another activation's record. Registration failures are reported through diagnostics while preserving original Peer ingress; `stop()` reports cleanup failures.

Controlled tests cover real loopback ports, port zero, a socket surviving activation changes, stale asynchronous context, rejected candidates, cancelled startup, discovery removal and waiting for actual registration cleanup. Existing HTTP dispatch and upgraded socket drain tests remain. Tests contact no real Peer or platform.

See [independent listener contracts](external-listener-contracts_en.md) for the binding format. Global coverage follows the [API contract architecture](api-contract-discovery-target-architecture_en.md) and its corresponding acceptance evidence.
