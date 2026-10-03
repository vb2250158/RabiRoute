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

`tunnel.json` retains selection, pinned keys and application scope rather than per-device service permissions. Existing keys are preserved; successful current-application authentication migrates old records into unified connection records. An old file alone cannot prove current authentication. Every new request rechecks enablement, token scope and the pinned key. Disabling the connection, changing credentials or deleting records rejects old sessions. Changed keys are never silently replaced.

The `persona` service remains the fixed read-only API alias used by references; its path restrictions are not another device permission. Full administration uses `manager`; knowledge uses existing Manager APIs. The target PC owns service registration and URLs, so remote callers cannot choose arbitrary local addresses.

Compatibility: supported older phone/glasses clients may send `bootstrap-speech`, `bootstrap-resources` or `bootstrap-persona`. Their original signature domains are validated, but all use the unified application connection policy. New PCs send only the new signal. Remove legacy wire kinds once supported clients are upgraded and old usage reaches zero. `POST /api/rabilink/peer/persona/bootstrap` remains for released persona pages, accepting only a device ID and invoking the unified handshake; remove the alias after page migration.

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

The same http path accepts WebSocket Upgrade for services that permit it; the restricted `persona` service rejects upgrades. Services register a baseUrl and optional pathPrefix, and the application can impose a request allowlist. The persona allowlist is fixed by the application and cannot be overridden in `tunnel.json`. Generic endpoints need no individual remote-business operation registration. Manager URLs are supplied by the current generation, and speech uses existing configuration. Additional services are local administrator configuration, never caller-provided arbitrary URLs. Recursive tunnel control is denied.

HTTP, binary, uploads, downloads, SSE and WebSocket share framing, multiplexing and per-stream flow control. Each connection supports sixteen streams; frames are bounded to roughly thirty-two KiB, with twelve-KiB data chunks. Whole files are not buffered into JSON. Existing speech control APIs retain their bounded-buffer semantics; streaming consumers use the generic path.

For services permitting redirects, same-service redirects retain the target prefix and cross-origin redirects fail; `persona` rejects every redirect. Body URLs remain application data and are not guessed or rewritten; extension APIs should return service-relative paths. Browser credentials are not copied to peers. Administrators can configure target-owned service headers for independent service authentication.

## Security, Relay and lifecycle

Pinned Ed25519 identities authenticate ephemeral X25519 sessions with direction-specific AES-GCM keys and ordered replay protection. All transports use identical authentication and grants. Relay rooms are application-isolated opaque byte channels.

A room has at most two endpoints, sixteen KiB of pre-pair buffering, two MiB of queued sends, and an eight-MiB-per-second limit. Pairing and idle lifetimes are bounded. Limits close connections with an explicit interruption rather than unlimited buffering. Connections do not survive Manager generations. Plugin disposal closes channels, streams and event subscriptions.

The separate direct-video channel retains its no-video-relay contract.

## Compatibility and acceptance

peer-rpc-v1 remains for legacy read-only clients and small signalling exchanges. New generic requests do not use legacy operation dispatch. Signalling uses a single Relay exchange and does not replay allocation across transports. Remove the legacy DataChannel and dispatch at the migration milestone after all supported peers have upgraded, signalling has migrated, legacy usage is zero and dual-PC acceptance is complete.

Tests include src/peerTunnel/tunnel.test.ts, src/peerTunnel/speechAdapter.test.ts, ribiwebgui/tests/peer-server-presentation.test.ts and the Python speech API/peer_compute tests. Physical acceptance must record each transport, RTT, a newly added endpoint without tunnel changes, target switching, interruption, permission denial and actual playback. Public-network and remote-upgrade evidence is separate from local tests.
