# Generic API transport for AIUI and the phone

English | [简体中文](generic-api-transport.md)

Status: client source and regression validation. This refactor has not passed hardware acceptance as an installed runtime. Builds, deployment, model calls and actual connection paths require separate evidence.

## Ownership

The server owns the connection directory, authentication, target-PC selection and forwarding. PCs own personas, Skills, profile transactions, history and business APIs. New public Manager HTTP APIs reuse generic transport without adding a server business dispatcher.

| Call | Data and execution owner |
| --- | --- |
| `/api/rabilink/mobile/state`, `/mobile/target`, `/devices/connections` | Server connection directory and target metadata; no persona-profile authority |
| `/api/rabilink/device/api` | AIUI buffered HTTP transport carrying `{targetDeviceId, request}`; no persona or `profileRevision` interpretation |
| PC `/api/rabilink/agent-devices/{id|self}/profile`, `/profile/receipt` | Transactions and application receipts at the fixed connection owner PC |
| PC `/api/rabilink/persona-template` | Persona and Skill guidance from the selected source PC |
| PC `/api/roles/{roleId}/chat-history/aiui` | Actual user input and replies at the PC frozen for that turn |
| Other public PC paths | The same method, path, required headers and body transport; each target API enforces its contract |
| PC `/api/rabilink/mobile/device-status`, `/asr-settings` | The application directory's `connectionOwnerDeviceId` owns battery status and ASR priority independently of chat/persona target selection |

Authenticated connection identity resolves `self`; serial numbers, self-reported `appId` values and caller headers cannot impersonate it. One PC owns the writable profile. Choosing a persona from another PC updates that one profile while tools and history target the persona source PC.

## Actual transport capability

Android injects application-owned connections through `RabiLinkManagerHttpTransport`. `RabiManagerHttpTransport` reuses the existing manager service on `RabiSpeechTunnel`: authenticated LAN first, P2P next and Relay last. Responses report actual `lan`, `p2p` or `relay`; endpoint names are not evidence of a connection. Establishment may fall back, but dispatched business requests never replay on another path.

The SDK owns no sockets or business state. Without phone pairing, AIUI uses buffered Relay HTTP and reports `lan=false`, `p2p=false`, `streaming=false`, `websocket=false`. A paired phone uses an independent Eye identity for the encrypted Manager connection. The phone application identity supplies directory and signalling access; it cannot claim messages as the Eye.

“Phone direct connection / glasses pairing” in phone glasses settings displays the current address and a five-minute pairing code. “Phone direct connection” in the AIUI top bar opens a separate connection form. Pairing issues a fifteen-minute local credential. Device credentials, independent keys and local credentials remain in private connection configuration, outside personas, Skills, model context and history. Re-pairing or connection changes invalidate the original connection; dispatched requests never retry through Relay.

The Eye credential registers its key at PC `/api/rabilink/peer/device-bootstrap` through existing `/device/api`. The signature fixes the original absolute deadline. Grants last at most 45 seconds; renewal requires fresh device authentication. A live same-key renewal retains the epoch. Expiry, rotation, restart or revocation closes the original channel without substituting phone identity. Ordinary application bootstrap rejects `glasses-*` identities.

`/manager-http` preserves status, headers, body and `bodyBase64`; `/manager-stream` carries HTTP/SSE and binary chunks; `/manager-ws` forwards the PC's original `101` upgrade and duplex frames. Target and original path use request headers; the local credential uses the authorization header only. AIUI uses standard streaming `fetch` and `wx.connectSocket`; missing runtime APIs fail explicitly.

The model uses the same `rabi_api_call` with `mode=http|stream|websocket`. Streams return `chunksBase64`; WebSocket `messages` send strings or `{bodyBase64}` and observations retain text/binary messages. `maxBytes`, `maxMessages` and `maxMs` bound each observation without adding business-specific tools. WebSocket sends can mutate state and retain original operation IDs and fingerprints. Receiving frames is not a confirmed business write; disconnection or a bounded observation requires original-result reconciliation without reconnecting and resending. A connection without outbound messages is read-only. The official `SocketTask` uses `send(data)` and `close()`, not mini-program object-style send parameters.

Local protocol tests do not establish actual AIUI access to a phone private address. Official production networking requires HTTPS and a domain allowlist. The current phone HTTP address is for development validation; trusted HTTPS addressing, network reachability, firmware APIs and actual LAN/P2P paths still require hardware acceptance. Primary references: [network rules](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/0-guide/basic/network/usage.md), [WebSocket API](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/3-api/network/websocket.md).

## Targets, idempotency and outcomes

`rabi_api_help` and `rabi_api_call` accept optional `targetDeviceId`. Without it, they use the persona PC frozen when the turn model is created; an unbound device freezes its current selected connection. Another PC must belong to the application's authenticated connection scope. Personas do not grant or restrict permission.

Writes retain their original `operationId`, `Idempotency-Key` and required version conditions. Fingerprints include the actual target PC, method, path, headers and body digest. Changing target or content under one operation ID is rejected. Timeout, disconnection and failed identity readback remain unconfirmed; reconciliation reads the original receipt/resource without automatic replay. Client journals store digests rather than extra copies of sensitive bodies.

`/meta` verifies nonempty application-generation and Manager-instance identity; business calls also check applicable readiness. Post-write checks compare identity only; health fluctuation does not imply a new generation. HTTP return, business acceptance, business completion and phone/glasses application are distinct facts. `202` is not business completion.

Buffered Relay HTTP retains body, response-size and time bounds. Phone streams and upgrades reuse the encrypted frame protocol with Eye authority checked on each IO. Persistent streams, WebSocket and large files use the streaming entry rather than a single buffered JSON result.

## Validation

Phone write journals are scoped by Relay address and stable Eye ID; resetting the device credential preserves original operation IDs. Confirmed result payloads are cached for seven days and at most 128 entries. Retired payloads retain the original ID, fingerprint and terminal metadata, so old requests require resource reconciliation without redispatch. Unknown results never expire by age. At most 128 unconfirmed intents are admitted; a new write fails before network dispatch when full, while reads and original-request reconciliation remain available. Streamed writes become confirmed only after normal response end, a non-5xx status and successful identity readback; disconnection and 5xx remain unknown.

`Smoke-GenericManagerTransport.mjs` covers unknown future APIs, generic profiles, original history targets, retained writes, cross-target replay rejection and journals without sensitive bodies. `Smoke-AiuiPersonaIntegration.mjs` checks frozen default PCs and history settlement. Android `ManagerHttpTransportTest` covers SDK injection, unknown APIs, target scope and no retry after dispatch failure. Actual LAN/P2P/Relay paths, host-model behavior and ASR/TTS concurrency still require runtime evidence.

`Smoke-PhoneEyeTransport.mjs` uses actual HTTP, SSE and WebSocket to verify the AIUI pairing protocol and byte readback. Android `TunnelCryptoTest` verifies actual PC delegation signatures. `TunnelHttpExchangeTest` uses the actual PC Runtime and independent Eye encrypted handshake for future paths, binary, SSE and upgrades. `PhoneEyeHttpServerTest` checks the actual phone-edge socket protocol. These validate separate protocol layers, not glasses firmware or the complete phone hardware runtime.

Opening the phone glasses settings refreshes a five-minute pairing code while reusing the same connection service and preserving paired glasses. The private local connection credential lasts fifteen minutes. An active client checks it every minute and calls local `/session/renew` when five minutes remain. The phone re-authenticates the original stored device credential against Relay, verifies the actual device ID and checks the original connection scope and session before and after that request. Success extends only the same private access credential. The PC forty-five-second delegation continues to renew independently through its original device-token chain. Failed authentication, revocation, scope changes or an already expired credential stop the connection, including streams; they never revive an old session or resend a business operation.

Failed renewal retains the disabled pairing configuration, so subsequent requests continue to fail closed. Only explicit re-pairing or clearing changes transport selection; failed renewal never falls back to finite Relay HTTP to replay a write.

The authenticated device-profile response publishes `timeoutOverrides`, cached by Relay and target PC. `aiui.http.request` overrides the previous 8/12/30/45-second HTTP defaults; `aiui.phone.request` overrides the 60-second phone-bridge default. Refreshing the profile updates subsequent requests; clearing overrides restores each call’s default. The cache contains no credentials and is isolated across target PCs. Source smoke tests pass; installation and physical-device acceptance remain pending.

Snapshots are isolated by Relay, account digest, and target PC. `aiui.model.*` configures model responses, whole turns, creation, availability checks, and configuration inference; `aiui.playback` configures playback completion. HTTP sends the current request budget through `X-Rabi-Timeout-Ms` to the authenticated Relay request; it does not change other clients or Relay global settings.
