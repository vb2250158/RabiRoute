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

`api-tool-ledger.js` owns the AIUI page's journal, partitioned by a digest of the existing connection scope. Opening any connection first migrates legacy single-scope rows to their original scope before allocating a new session; failures do not treat the old journal as empty. Session IDs isolate local call IDs, while operation IDs survive model recreation/page reopen. Writes are saved and read back before dispatch; storage failure, replacement ownership or release during identity lookup prevents dispatch. Reopening retains operation digests and retires old-session reads without rerunning unknown operations.

Tool observations retain the original call/session IDs, generated or supplied `operationId`, and verified target PC in `requestIdentity`. This correlates a request; it is not a business receipt. Transport exceptions return `TOOL_OUTCOME_UNCONFIRMED` without arbitrary exception text. Failed settlement storage returns `TOOL_RECEIPT_SAVE_UNCONFIRMED` while preserving any received result and original identity; the existing pending record still prevents replay. Duplicate calls report `resultAvailable=false`: a local completed digest neither reconstructs the original result nor establishes business completion. The model reads the original receipt/resource through the discovered API contract. Preflight errors proven to precede dispatch remain explicit rejections.

The glasses candidate currently retains at most 128 operation digests per connection scope, including confirmed and unconfirmed outcomes, plus 128 read records per session. Full write history blocks only new writes and leaves read capacity for receipt queries. There is no user-facing archival/cleanup workflow or automatic age-based forgetting of operation IDs. This differs from the phone journal's limit of 128 unconfirmed intents below; they are separate implementations.

`/meta` verifies nonempty application-generation and Manager-instance identity; business calls also check applicable readiness. Post-write checks compare identity only; health fluctuation does not imply a new generation. HTTP return, business acceptance, business completion and phone/glasses application are distinct facts. `202` is not business completion.

Buffered Relay HTTP retains body, response-size and time bounds. Phone streams and upgrades reuse the encrypted frame protocol with Eye authority checked on each IO. Persistent streams, WebSocket and large files use the streaming entry rather than a single buffered JSON result.

## Generic asynchronous task follow-up

`rabi_task_follow` is a local Page tool, not a new backend dispatcher. After reading actual API contracts and acceptance receipts, the model registers the original `taskId`, `targetDeviceId`, read-only GET `path`, JSON Pointer `statusPointer` and `terminalValues` with `watch`. Pointers start at the HTTP JSON body root; optional `resultPointer` selects the retained result. IDs, fields and terminal values must not be invented, and registration never redispatches business work. Formal device-mailbox deliveries retain their existing consumer.

| action | Behavior |
| --- | --- |
| `watch` | Saves a query contract; repeats for the same target/task/path return the original record, conflicts fail, stopped/announced records are not revived |
| `list` | Reads local record metadata and bounded polling error codes |
| `read` | Reads the original contract, saved result and summary by returned record `id` |
| `stop` | Stops polling/notification for this record without cancelling backend work |

Each poll reuses authenticated transport and `/meta` identity checks. Intervals default to ten seconds, configurable from one to sixty seconds. Polling requires a visible Page; hiding releases it, and reopening the same connection, target and persona-prompt binding restores it. Unknown results, missing fields, storage failures and obsolete owners never confirm completion; only declared terminal values qualify. Terminal observations are limited to 60000 characters and summaries to 16000. Oversized results retain their subscription with an error code. At most 16 watching/ready records and 32 recently announced/stopped records are retained. Retiring these read-only subscriptions never clears API mutation identities; polling does not consume the session's 128 tool-read slots.

Task results and summaries reside in private device storage without additional request headers or credentials. The same assistant and global prompt generate summaries with tools disabled, prioritizing foreground input and playback. Notifications create neither fabricated user turns nor ordinary chat-history entries. A summary is saved before the current Page's `setData` callback acknowledges its update, then may enter the speech queue. The receipt proves a local Page update, not that the user saw/heard it or audio played. A crash after acknowledgement does not cause replay, but `read` still retrieves the saved result. Event push and execution while the app is hidden are not implemented.

Thirteen `Smoke-TaskFollow.mjs` regressions and compiled/supplied-AIX Page integration cover persistence, argument snapshots, storage failures, stop races, obsolete owners, foreground priority and same-model serialization. They use fixtures and do not establish real PC tasks or audible device behavior.

## Validation

`rabi_api_help` uses the Manager's `cursor` / `limit` pagination (`limit`: integer 1–200). Without an exact operation/path it defaults to 32 compact index entries, marked `apiHelpView=index` and `completeContracts=false`. Follow `nextCursor` unchanged with the original target and filters. An exact `operationId` or `path` defaults to one complete contract per page. HTTP 409 snapshot changes and 400 invalid cursors remain actual errors without automatic retries or mixed snapshots. Projection reduces model observations; the server still transfers full contracts for the selected page. Oversized individual contracts and transport limits remain possible.

Recovery uses the identity required by the actual contract. Transport `operationId`, business `deliveryId` and server `requestId` are not interchangeable. For example, `/api/agent/send` receipts use the original `deliveryId`; local `requestIdentity` neither guarantees every business identifier nor creates a missing backend query capability.

`Smoke-AiuiApiDiscoveryHttp.mjs` uses the real Manager registry and an isolated HTTP server with fixture model/business data: the complete 43-operation catalog is 1,254,942 characters; the two model index observations are 10,021 / 4,262 characters, the selected contract observation is 64,859 characters, and the selected business API is called once. Three tests cover pagination without duplicates/omissions, complete contracts, changed snapshots, invalid cursors and argument validation. Compiled-source and supplied-AIX tests also exercise the actual page adapter's index/detail paths. This does not establish installed-PC, Relay or physical-device connectivity.

Phone write journals are scoped by Relay address and stable Eye ID; resetting the device credential preserves original operation IDs. Confirmed result payloads are cached for seven days and at most 128 entries. Retired payloads retain the original ID, fingerprint and terminal metadata, so old requests require resource reconciliation without redispatch. Unknown results never expire by age. At most 128 unconfirmed intents are admitted; a new write fails before network dispatch when full, while reads and original-request reconciliation remain available. Streamed writes become confirmed only after normal response end, a non-5xx status and successful identity readback; disconnection and 5xx remain unknown.

`Smoke-GenericManagerTransport.mjs` covers unknown future APIs, generic profiles, original history targets, retained writes, cross-target replay rejection and journals without sensitive bodies. `Smoke-AiuiPersonaIntegration.mjs` checks frozen default PCs and history settlement. Android `ManagerHttpTransportTest` covers SDK injection, unknown APIs, target scope and no retry after dispatch failure. Actual LAN/P2P/Relay paths, host-model behavior and ASR/TTS concurrency still require runtime evidence.

`Smoke-PhoneEyeTransport.mjs` uses actual HTTP, SSE and WebSocket to verify the AIUI pairing protocol and byte readback. Android `TunnelCryptoTest` verifies actual PC delegation signatures. `TunnelHttpExchangeTest` uses the actual PC Runtime and independent Eye encrypted handshake for future paths, binary, SSE and upgrades. `PhoneEyeHttpServerTest` checks the actual phone-edge socket protocol. These validate separate protocol layers, not glasses firmware or the complete phone hardware runtime.

Opening the phone glasses settings refreshes a five-minute pairing code while reusing the same connection service and preserving paired glasses. The private local connection credential lasts fifteen minutes. An active client checks it every minute and calls local `/session/renew` when five minutes remain. The phone re-authenticates the original stored device credential against Relay, verifies the actual device ID and checks the original connection scope and session before and after that request. Success extends only the same private access credential. The PC forty-five-second delegation continues to renew independently through its original device-token chain. Failed authentication, revocation, scope changes or an already expired credential stop the connection, including streams; they never revive an old session or resend a business operation.

Failed renewal retains the disabled pairing configuration, so subsequent requests continue to fail closed. Only explicit re-pairing or clearing changes transport selection; failed renewal never falls back to finite Relay HTTP to replay a write.

The authenticated device-profile response publishes `timeoutOverrides`, cached by Relay and target PC. `aiui.http.request` overrides the previous 8/12/30/45-second HTTP defaults; `aiui.phone.request` overrides the 60-second phone-bridge default. Refreshing the profile updates subsequent requests; clearing overrides restores each call’s default. The cache contains no credentials and is isolated across target PCs. Source smoke tests pass; installation and physical-device acceptance remain pending.

Snapshots are isolated by Relay, account digest, and target PC. `aiui.model.*` configures model responses, whole turns, creation, availability checks, and configuration inference; `aiui.playback` configures playback completion. HTTP sends the current request budget through `X-Rabi-Timeout-Ms` to the authenticated Relay request; it does not change other clients or Relay global settings.
