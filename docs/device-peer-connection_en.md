<!-- docs-language-switch -->
English | 简体中文: [device-peer-connection.md](device-peer-connection.md)
<!-- /docs-language-switch -->

# A phone connecting on behalf of glasses

This page is for integration developers. A phone may hold a separate glasses key and use the common LAN → P2P → Relay tunnel for the glasses. Its own application connection retains the phone identity; request bodies and headers cannot declare a glasses identity. Source tests do not establish acceptance on a real phone, glasses or platform.

## Connection capabilities and verification scope

The phone `/session` pairing entry and existing leases remain available. Once connected, requests reuse existing authentication without additional per-API or per-feature grants or automatic lease removal. Only capabilities explicitly disabled by the user in WebGUI or configuration are restricted. Source fixtures cover paired HTTP, SSE, WebSocket and renewal; this does not establish QuickJS platform support or physical-device acceptance. Phone HTTP bodies have a cumulative 12 MiB limit and a 60-second read deadline to bound request resource usage, not to impose feature permissions.

## Grant and renewal

Use the glasses device credential and Relay's generic `POST /api/rabilink/device/api` to request `POST /api/rabilink/peer/device-bootstrap` on the target PC. Relay authenticates the connection and forwards the original HTTP request. It does not interpret this PC endpoint or maintain persona data or an additional public-key grant registry.

The PC accepts `{source,publicKey,target,expiresAt,nonce,signature}`. `source` must match the authenticated Relay device and `target` must identify the receiving PC. The signature domain is `rabi-device-delegation-v1`, with fields encoded in the order `source,publicKey,target,expiresAt,nonce`. The PC tunnel runtime verifies the signature and actual key possession.

Relay records `authenticatedAt` when it first admits the authenticated request. The original queue item, claims and retries retain that timestamp. The PC's internal MAC protects this timestamp together with the source, scope, application generation, method and actual path. This endpoint requires the actual `relay` ingress and original device identity. A phone's ordinary `peer` ingress, application identity or bare proxy headers cannot grant a glasses identity.

`expiresAt` is an absolute deadline. It must be in the future and no later than the original `authenticatedAt + 45000`. A late queue item, identical operation retry or fresh local MAC cannot extend it. Renewal requires another request authenticated with the actual glasses device credential; a private-key signature alone cannot renew the lease.

## Tunnel identity and invalidation

The phone completes the actual encrypted handshake using the separate glasses ID and key. The PC recognizes that source only while the device grant, key proof, scope and deadline remain valid. The phone may retain the application's Relay room credential; joining a room does not establish a glasses identity.

The phone's local HTTP facade owns transport only. It preserves the method, path and query and supports fixed-length or chunked uploads, incremental responses and binary content. WebSocket forwarding carries the actual target's `101` and raw bidirectional frames. The phone neither creates a second handshake nor reports an upgrade before the target accepts it. The connection owner verifies identity and target selection; the facade has no per-business API table. Actual socket, streaming and WebSocket fixtures remain separate from installed-phone and platform acceptance.

Ordinary application bootstrap must not register the reserved `glasses-*` identities, overwrite device grants or fall back to an application grant after a device grant becomes invalid. Expiry, an application generation change or runtime shutdown causes active reads, streams and state writes to revalidate the original authority. A PC restart must not revive an old device lease.

Revoking the device credential prevents subsequent grants and renewals. An already granted offline lease is bounded by its original absolute deadline. The PC cannot instantly discover a server-side revocation while disconnected. Formal message claims still require the original glasses session and owner epoch; a connection grant does not replace a business receipt.

Persona and workspace bindings do not restrict public APIs. Bindings select context and automatic delivery targets. See [Connection and API access](connection-access_en.md) and [Exact delivery](agent-endpoint-delivery_en.md).
