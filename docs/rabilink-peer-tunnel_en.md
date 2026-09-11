# Cross-PC tunnels and speech server selection

English | [简体中文](rabilink-peer-tunnel.md)

Status: experimental implementation. Automated coverage includes local dual endpoints over LAN, real WebRTC, an isolated Relay, HTTP streaming, WebSocket, cancellation and RTT. Physical dual-PC operation, cross-carrier networks and target speech models require separate acceptance. Source and test results do not prove remote deployment.

## User interface

The Speech service page provides a Speech server selector. Rows show the device name, online status, actual transport and measured round-trip latency. Local calls are labelled as local, never as a fabricated zero-millisecond measurement.

Opening the menu checks up to ten eligible peers with at most two concurrent connection attempts. The selected target has priority. Older devices require an upgrade; untrusted devices require explicit trust. Offline peers cannot be newly selected. A selected peer going offline remains selected, without silent fallback to this PC.

Presence, connectivity and speech readiness are separate states. Disconnected channels never retain a current-transport label. RTT expires after thirty seconds and is measured with encrypted channel ping/pong, excluding model loading and speech computation. Status uses events. Visible peers receive transport keepalives while the menu is open; afterwards only the selected peer does. Unused connections expire after sixty seconds.

Selecting B sends model, voice, TTS and manual ASR operations to B. Capture devices and the host FIFO remain on A. Remote synthesis always disables playback on B; completed PCM WAV enters A's existing queue. When a Manager address is configured, resident microphone transcription checks its selected server: remote selection uses Manager transcription; local selection preserves local inference. Remote failures never trigger local inference. Model management and runtime controls address B and require its manager-service grant.

## Automatic connection policy

1. Authenticate parallel LAN candidates within a two-second total budget.
2. Otherwise attempt WebRTC P2P within ten seconds, with STUN and no TURN.
3. Otherwise establish a server-mediated tunnel within five seconds.

Healthy connections are reused. Trusted LAN peers are discovered through DNS-SD's rabitunnel service and authenticated in the encrypted handshake. Already discovered LAN peers remain usable without the server. New LAN announcements can upgrade connectivity: new requests use the better connection while existing streams drain on the old one.

Connection budgets are separate from business deadlines. Accepted requests are not replayed automatically: interruption may leave an unknown result. Cancellation propagates to the target. Started audio is not restarted. Exactly-once writes require the endpoint's own idempotency contract.

## Establish trust once

Both endpoints need peer-tunnel-v1 and the Relay needs /api/rabilink/tunnel/socket. Discover the current managerBaseUrl using Host status --json and verify health, generation and instance through /meta. Do not persist Manager ports.

Local GET /api/rabilink/peer/identity returns the device ID, generation and public Ed25519 key. The application-generated private key lives in runtime data/rabilink/tunnel-identity.json, is never returned by that API, and must never enter version control.

After verifying each peer's public key, configure runtime data/rabilink/tunnel.json on each PC:

~~~json
{
  "selectedDeviceId": "",
  "trustedDevices": [
    {
      "deviceId": "peer-b",
      "publicKey": "Complete verified peer PEM public key",
      "services": ["speech"]
    }
  ],
  "services": {}
}
~~~

The services list grants that peer access to this PC. An outgoing-only trust record may use an empty services list. B must grant speech to A before accepting its synthesis requests. A manager grant grants full Manager administration and must be an explicit administrator choice.

Shared application tokens do not establish independent device trust. Changed keys fail closed until reverified. Invalid configuration disables access instead of resetting selection to local. Grants are checked for every new request.

Read-only acceptance mode rejects server selection changes, incoming tunnels and generic proxy requests.

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

The same http path accepts WebSocket Upgrade. Services register a baseUrl and optional pathPrefix once; new endpoints need no tunnel-specific operation registration. Manager URLs are supplied by the current generation, and speech uses existing configuration. Additional services are local administrator configuration, never caller-provided arbitrary URLs. Recursive tunnel control is denied.

HTTP, binary, uploads, downloads, SSE and WebSocket share framing, multiplexing and per-stream flow control. Each connection supports sixteen streams; frames are bounded to roughly thirty-two KiB, with twelve-KiB data chunks. Whole files are not buffered into JSON. Existing speech control APIs retain their bounded-buffer semantics; streaming consumers use the generic path.

Same-service redirects retain the target prefix; cross-origin redirects fail. Body URLs remain application data and are not guessed or rewritten; extension APIs should return service-relative paths. Browser credentials are not copied to peers. Administrators can configure target-owned service headers for independent service authentication.

## Security, Relay and lifecycle

Pinned Ed25519 identities authenticate ephemeral X25519 sessions with direction-specific AES-GCM keys and ordered replay protection. All transports use identical authentication and grants. Relay rooms are application-isolated opaque byte channels.

A room has at most two endpoints, sixteen KiB of pre-pair buffering, two MiB of queued sends, and an eight-MiB-per-second limit. Pairing and idle lifetimes are bounded. Limits close connections with an explicit interruption rather than unlimited buffering. Connections do not survive Manager generations. Plugin disposal closes channels, streams and event subscriptions.

The separate direct-video channel retains its no-video-relay contract.

## Compatibility and acceptance

peer-rpc-v1 remains for legacy read-only clients and small signalling exchanges. New generic requests do not use legacy operation dispatch. Signalling uses a single Relay exchange and does not replay allocation across transports. Remove the legacy DataChannel and dispatch at the migration milestone after all supported peers have upgraded, signalling has migrated, legacy usage is zero and dual-PC acceptance is complete.

Tests include src/peerTunnel/tunnel.test.ts, src/peerTunnel/speechAdapter.test.ts, ribiwebgui/tests/peer-server-presentation.test.ts and the Python speech API/peer_compute tests. Physical acceptance must record each transport, RTT, a newly added endpoint without tunnel changes, target switching, interruption, permission denial and actual playback. Public-network and remote-upgrade evidence is separate from local tests.
