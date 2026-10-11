# Cross-PC tunnels and speech server selection

English | [简体中文](rabilink-peer-tunnel.md)

Status: experimental implementation. Automated coverage includes local dual endpoints over LAN, real WebRTC, an isolated Relay, HTTP streaming, WebSocket, cancellation and RTT. Physical dual-PC operation, cross-carrier networks and target speech models require separate acceptance. Source and test results do not prove remote deployment.

## User interface

RabiLink Home and persona source selection show the RabiPC version advertised by each device, or an unknown version when it was not advertised. Home checks the device ID and GUID for its Local label. The local source option shows the actual name and current running version; this PC is not listed as another remote PC. Versions help identify running installations but do not participate in authentication, service permissions or capability checks.

The Speech service page provides a Speech server selector. Rows show the device name, online status, actual transport and measured round-trip latency. Local calls are labelled as local, never as a fabricated zero-millisecond measurement.

Opening the menu checks up to ten eligible peers with at most two concurrent connection attempts. The selected target has priority. Older devices require an upgrade; same-application peers awaiting a handshake show automatic connection. Offline peers cannot be newly selected. A selected peer going offline remains selected, without silent fallback to this PC.

Presence, connectivity and speech readiness are separate states. Disconnected channels never retain a current-transport label. RTT expires after thirty seconds and is measured with encrypted channel ping/pong, excluding model loading and speech computation. Status uses events. Visible peers receive transport keepalives while the menu is open; afterwards only the selected peer does. Unused connections expire after sixty seconds.

Selecting B sends model, voice, TTS and manual ASR operations to B. Capture devices and the host FIFO remain on A. Remote synthesis always disables playback on B; completed PCM WAV enters A's existing queue. When a Manager address is configured, resident microphone transcription checks its selected server: remote selection uses Manager transcription; local selection preserves local inference. Remote failures never trigger local inference. Model management and runtime controls address B and use its manager service through the same application connection.

## Automatic connection policy

1. Authenticate parallel LAN candidates within a two-second total budget.
2. Otherwise attempt WebRTC P2P within ten seconds, with STUN and no TURN.
3. Otherwise establish a server-mediated tunnel within five seconds.

Healthy connections are reused. Trusted LAN peers are discovered through DNS-SD's rabitunnel service and authenticated in the encrypted handshake. Already discovered LAN peers remain usable without the server. New LAN announcements can upgrade connectivity: new requests use the better connection while existing streams drain on the old one.

Connection budgets are separate from business deadlines. Accepted requests are not replayed automatically: interruption may leave an unknown result. Cancellation propagates to the target. Started audio is not restarted. Exactly-once writes require the endpoint's own idempotency contract.

## Unified RabiLink device connections

Since 0.3.22, PCs enabled in the same RabiLink application use existing application authentication to exchange and pin Ed25519 keys automatically. New PCs advertise `rabilink-application-access-v1`, send `bootstrap-application`, and sign with `rabi-application-bootstrap-v1`. Selection, probing and first requests use one connection flow, without separate speech, persona, resource or full `manager` grants. The source PC must support the new capability.

Authenticated devices can use all services actually provided by the PC, including Manager administration and knowledge writes. Application isolation, device credentials, pinned keys, encryption and current connection scope still apply. Anonymous LAN advertisements cannot establish trust. Default access does not mean a service is running, a device is online or an endpoint exists. Host lifecycle and instance-reset operations still require the local Host owner interface.

`tunnel.json` retains selection, pinned keys and application scope rather than per-device service permissions. Existing keys are preserved; successful current-application authentication migrates old records into unified connection records. An old file alone cannot prove current authentication. Every new request rechecks enablement, token scope and the pinned key. Uploads, downloads, SSE and WebSocket also recheck before forwarding body bytes and finishing streams. Disabling the connection, changing credentials or deleting records stops subsequent bytes and closes reused connections in an obsolete scope. Changed keys are never silently replaced.

The `persona` service remains the restricted reference API alias, including language-style selection; its path restrictions are not another device permission. Full administration uses `manager`; knowledge uses existing Manager APIs. The target PC owns service registration and URLs, so remote callers cannot choose arbitrary local addresses.

PCs and phones use `bootstrap-application`. The old `bootstrap-speech`, `bootstrap-resources` and `bootstrap-persona` wire kinds have been removed and are rejected. The current persona page still calls `POST /api/rabilink/peer/persona/bootstrap`; this HTTP entry invokes only the unified application handshake and does not restore an old wire kind.

### Independent glasses identity through a paired phone

After explicit pairing, the phone may hold the glasses credential and an independent Ed25519 key. The glasses credential uses the existing generic `/device/api` forwarding path to call the target PC's `POST /api/rabilink/peer/device-bootstrap`. The PC accepts only the actual `glasses-<16 hexadecimal characters>` source attested by the current Relay owner, never an ordinary application, another peer or a device identity claimed in the body. Application bootstrap permanently rejects `glasses-*` sources; expired device identities cannot fall back to application bootstrap.

The registration body is `{source,publicKey,target,expiresAt,nonce,signature}`. The Ed25519 signature covers `rabi-device-delegation-v1` followed by JSON with fields ordered as `source,publicKey,target,expiresAt,nonce`. The nonce contains 32–128 URL-safe characters; the signature is standard Base64 of a 64-byte signature. `source` must match the authenticated source and `target` must match the target PC. The response contains `sourceDeviceId,deviceId,publicKey,generation,managerGeneration,expiresAt,epoch`; both generation fields identify the Host's `applicationGenerationId`.

The lease exists only in PC memory. Its absolute deadline must not exceed the server's original device admission time, `authenticatedAt + 45 seconds`. Queuing and retries do not refresh that timestamp; renewal independently requires the actual glasses credential. Renewal with the same active key preserves the epoch; key rotation or registration after expiry changes the epoch and closes old sessions. A PC restart invalidates leases. Without renewal, expiry fails closed; offline credential revocation can take up to the remaining lease duration, rather than taking effect immediately across devices.

The phone may use its application credential for existing P2P/relay signalling, but the inner tunnel must use the independent glasses source/key. Phone identity and forwarded private headers cannot impersonate glasses. HTTP bodies, SSE and WebSocket bytes recheck the current key, epoch, lease, scope and generation; admitted Manager requests recheck the same in-memory guard after asynchronous waits. The lease proves message ownership and does not restrict public APIs by persona, workspace or Route. The server remains responsible for connections, authentication and generic forwarding.

Actual HTTP registration and LAN handshakes, immediate first requests, same-key renewal, key rotation, expiry, scope changes and stopping SSE/upgraded bytes are covered by `src/peerTunnel/deviceDelegation.test.ts`. Physical phones/glasses and public-network paths require separate acceptance.

Read-only acceptance mode still rejects selection changes and tunnels.

## Generic API

Control endpoints use the main Manager listener and existing WebGUI authorization, including local LAN addresses and authorized remote browsers. The separate peer-discovery listener does not expose WebGUI control access.

~~~text
GET  /api/rabilink/peer/servers
POST /api/rabilink/peer/probe           { "deviceIds": ["peer-b"] }
GET  /api/rabilink/peer/selection
PUT  /api/rabilink/peer/selection       { "deviceId": "peer-b" }
GET  /api/rabilink/peer/events?ids=[...]  SSE; URL-encode ids
Supported methods /api/rabilink/peer/http/<device>/<service>/<original-path>
~~~

The same http path accepts WebSocket Upgrade for services that permit it; the restricted `persona` service rejects upgrades. Services register a baseUrl and optional pathPrefix, and the application can impose a request allowlist. The persona allowlist is fixed by the application and cannot be overridden in `tunnel.json`. Generic endpoints need no individual remote-business operation registration. Manager URLs are supplied by the current generation, and speech uses existing configuration. Additional services are local administrator configuration, never caller-provided arbitrary URLs. The application owns the built-in `manager` address and identity headers; `tunnel.json` cannot override them. Public peer directory, selection and third-PC forwarding APIs remain accessible through `manager`. Private `receive` and `tunnel/socket` handshake paths are rejected as business requests.

Third-PC access uses the existing public API. After A connects to B, A can request B's `/api/rabilink/peer/http/pc-c/manager/api/example`; B then accesses C through its existing connection owner. Explicit nesting is limited to four forwarding hops. Self-targets, repeated targets and over-limit paths are rejected, without denying the entire `/api/rabilink/peer/` namespace. An unavailable remote target fails instead of executing locally.

Public request headers use the shared `packages/rabi-api-contract` contract, retaining `If-Match`, `Idempotency-Key`, expected generation/instance and future business fields. Only credentials, proxy identity, HTTP framing, Connection-nominated hop fields and invalid line breaks are removed. New business headers require no Relay or tunnel enumeration change. Each forwarding request into Manager or its resource-download API receives a MAC from a process-memory key, binding the authenticated source, method, raw target, application scope, generation and unique nonce. Public generation IDs, loopback addresses and bare identity headers cannot replace this proof. The same request can be rechecked, but another request replaying its nonce is rejected, as are expired scopes and generations. Caller-supplied private headers are removed first and the proof is never returned externally. Independent speech services retain their own authentication.

HTTP, binary, uploads, downloads, SSE and WebSocket share framing, multiplexing and per-stream flow control. Each connection supports sixteen streams; frames are bounded to roughly thirty-two KiB, with twelve-KiB data chunks. Whole files are not buffered into JSON. Existing speech control APIs retain their bounded-buffer semantics; streaming consumers use the generic path.

For services permitting redirects, same-service redirects retain the target prefix and cross-origin redirects fail; `persona` rejects every redirect. Body URLs remain application data and are not guessed or rewritten; extension APIs should return service-relative paths. Browser credentials are not copied to peers. Administrators can configure target-owned service headers for independent service authentication.

## Security, Relay and lifecycle

Pinned Ed25519 identities authenticate ephemeral X25519 sessions with direction-specific AES-GCM keys and ordered replay protection. All transports use identical authentication and grants. Relay rooms are application-isolated opaque byte channels.

A room has at most two endpoints, sixteen KiB of pre-pair buffering, two MiB of queued sends, and an eight-MiB-per-second limit. Pairing and idle lifetimes are bounded. Limits close connections with an explicit interruption rather than unlimited buffering. Connections do not survive Manager generations. Plugin disposal closes channels, streams and event subscriptions.

The separate direct-video channel retains its no-video-relay contract.

## Compatibility and acceptance

`peer-rpc-v1` now carries only `system.describe` and `transport.offer` / `transport.tunnel` signalling. The business `/api/rabilink/peer/call` endpoint, `plans.list` / `persona.manifest` registrations, per-business-call P2P caller and obsolete manifest helper are removed. The dispatcher refuses to execute or advertise business operations even if accidentally registered. All reads and writes use the generic `manager` connection described here.

Supported existing phones still require `transport.offer` and its old DataChannel receiver for control traffic; this retains no second business implementation. New PCs use one signalling exchange bound to the target generation/instance and never replay connection allocation across transports. Remove the old offer/DataChannel receiver after supported clients migrate to `transport.tunnel`, old control-wire usage reaches zero and device acceptance is complete.

All 66 focused transport tests passed. Coverage includes A→B→C LAN forwarding across three real local runtimes, an unknown PUT endpoint, unknown request/response headers, 100 KiB binary data, connection reuse, real local WebRTC, Relay, SSE/WS revocation and no replay after write failure. Entry points are `src/peerTunnel/tunnel.test.ts`, `http.test.ts`, `personaBootstrap.test.ts`, `src/rabiPeerClient.test.ts` and `src/manager/rabiPeerRoutes.test.ts`. Speech presentation and playback have separate checks in `speechAdapter.test.ts`, `ribiwebgui/tests/peer-server-presentation.test.ts` and the Python speech API/peer_compute tests. Physical acceptance must record each transport, RTT, a newly added endpoint without tunnel changes, target switching, interruption, permission denial and actual playback. Public-network and remote-upgrade evidence is separate from local tests.
