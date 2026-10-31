<!-- docs-language-switch -->
English | [简体中文](dsh-browser-auth.md)
<!-- /docs-language-switch -->

# DSH Web session bridge authentication

Status: deployment and formal round-trip delivery accepted. Authentication alone does not prove delivery; verify the separate receipts below.

2026-09-14 verification: all 11 authentication/protocol tests and the full build passed. Host Developer candidate 0.3.1-b51d2326b858 activated with required capabilities and plan storage ready. The formal thread bridge read an exact session, created a session, and sent a follow-up to the same session with delivered / dsh_session_owner receipts. The recipient formally replied DSH_AUTH_DELIVERY_OK; Manager readback showed responded. Real images and model changes remain unverified. Plan-binding mutations still require a caller supporting strong ETags and idempotency headers; message acceptance is not binding acceptance.

## One owner and authentication path

RabiRoute continues using the current DSH Web owner's session API. It does not start another Runtime, disable DSH authentication, read signing keys, or forge cookies. DSH owns sessions, execution, models, tools and permissions; Manager owns plans and delivery receipts.

Current DSH Web exchanges its process launch URL for a cookie at the root path. An unauthenticated legacy bridge receives HTTP 401. Changing the port alone cannot fix authentication or the legacy RPC contract.

## Session bridge endpoint selection

The session bridge first uses an explicit `dshBaseUrl` from call options, then the address of a complete DSH primary binding, and finally the shared `resolveDshBaseUrl()`. Without a complete primary binding, default read and list requests also use existing local discovery: `DSH_WEB_URL` first, then clean loopback origins from known launch logs under `DSH_HOME`. If neither provides an address, the original `DEFAULT_DSH_BASE_URL` remains the fallback. An address without a valid session ID and working directory is not a complete primary binding.

Discovery does not scan ports or switch owners. Authentication uses only the target origin's launch log. A session-list 401 may restore authentication and retry once; writes never replay automatically.

## Automatically connect to a running local DSH

Opening a session selector or delivering a request restores expired authentication before dispatch. Existing endpoint log configuration takes priority. Without a default authentication configuration, or when its retired launcher log is missing, the bridge uses the discovered local `DSH_HOME/logs/web-host.stdout.log`. It reads at most the last 256 KiB and selects only a current login link matching the exact target origin. No additional **Connect DSH** click is required. Expired credentials are protected and saved after login exchange and read-only session verification; session bindings remain unchanged and revision checks protect concurrent edits. An explicitly injected configuration remains authoritative.

An explicit disconnect stays disconnected. Missing or mismatched logs and failed login verification produce an actionable error with the manual connection entry retained. Only `session/list` may recover and retry once after a 401. Task writes, timeouts and transport failures never replay automatically. Recovery runs on demand, adds no background session polling, and starts no second DSH Runtime.

DSH endpoint probes allow up to ten seconds. A host loading its catalog must not be marked offline by the generic 1.2-second probe budget before session lookup and automatic recovery can run.

## Connect in WebGUI (in development; deployment not accepted yet)

Use **Connect DSH** in the local RabiRoute console's DSH settings:

1. Start DSH and check the DSH address below. If authorization is already saved, or this browser is signed in to DSH on the same hostname, click **Connect DSH** directly without entering a key or login link.
2. Without a valid login, expand **Connect using a login link**, paste DSH's current login link, and connect. The link contains credentials: do not share it. RabiRoute verifies the login and read-only session API, protects authorization on this computer, and fills in the credential-free address.
3. Use the existing scan button to choose a session, then save the Route. Connecting or removing authorization never creates, deletes, or replaces session bindings.
4. Existing log-based installations use the same **Connect DSH** button to verify and migrate. If the log is unavailable, use the browser login or current login link.

Browser login is reused only when the user clicks Connect. The backend selects the browser's automatically attached HttpOnly cookie by the DSH hostname and port, verifies it with DSH, and saves its original expiry. It does not read browser credential stores or signing keys, extend authorization, or forward other cookies. `localhost` and `127.0.0.1` are different hostnames: use the same hostname for the console or provide a login link. Expired records may recover through the local launch log described above; explicitly disconnected records require an explicit reconnection.

Authorization is stored only in this computer's `stateRoot/data/dsh-connections/`, outside persona synchronization. Windows uses current-user DPAPI; other platforms use encryption with a restricted local key. DSH grants access to the entire Web owner, not a delivery-only or session-specific scope. Removing authorization stops RabiRoute from using it; it does not revoke other clients.

An unexpired authorization survives ordinary DSH restarts at the same address with the same signing configuration. Expiry or signing changes may recover through the local launch log. Hostname/port changes still use the explicitly selected address; RabiRoute does not scan ports or silently select another instance. Connection-management APIs retain the current connection authentication contract. Authorize each computer separately; do not share cookies.

### API and security boundaries

- `GET /api/agent-adapters/dsh/connections`: returns `ok`, `revision`, and `endpoints` containing clean addresses, states, and timestamps only. `saved` does not mean online.
- `GET /api/agent-adapters/dsh/connection?baseUrl=<origin>`: returns one connection's metadata and global configuration revision; no session scan.
- `POST /api/agent-adapters/dsh/connection`: JSON `{launchUrl, expectedRevision}`, or direct connection `{baseUrl, expectedRevision}`. Direct connection reuses saved authorization, then the target DSH cookie attached to the same-hostname request, then explicit legacy log configuration for an unmigrated endpoint. Credentials remain origin-bound and read-only `session/list` verification precedes returning `connection` and the new revision. Cookies are not accepted in the request body.
- `DELETE /api/agent-adapters/dsh/connection`: JSON `{baseUrl, expectedRevision}`. Persists a disconnected marker so legacy logs cannot silently restore authorization.
- Mutations follow the current connection authentication contract: local requests and authenticated remote connections not disabled by the user are accepted. Local browser requests validate Origin; forged identities, cross-site requests and untrusted forwarding headers are rejected. Request limit: 16 KiB. Conflicts return 409; reread before deciding to submit again. No automatic replay.
- Authentication accepts only a local loopback root URL with one token, never follows redirects, and never exposes credentials in ordinary configuration, API responses, errors, or logs. Login exchange allows ten seconds and read-only session verification allows sixty seconds. Task writes retain their no-automatic-replay boundary.

2026-09-17 development verification: focused authentication, session-bridge, and UI-client tests passed, including real Windows DPAPI storage, same-address reads, no 401 replay, no legacy fallback after disconnect/expiry, revision conflicts, and Relay/cross-site rejection. Backend/frontend type checks, an isolated full `npm run build`, and all five dynamic Manager contract tests passed. A candidate started successfully and its live APIs verified metadata reads, rejection of mutations without Origin, and migration/protected storage of a real existing DSH authorization. Another release subsequently replaced it, so final stable-runtime acceptance is still pending, along with real-browser and second-computer acceptance. This is not a fully accepted rollout.

### Legacy log compatibility exit criteria

`dsh-auth.json` provides explicit endpoint log mappings for nonstandard launchers. The default launcher uses its known local log without additional configuration. Legacy endpoints without a protected record retain short-lived in-memory authentication; expired protected records verify and save a fresh login from the same target's log. An explicit disconnect blocks log recovery and requires explicit reconnection. Authorization saves immediately and is not rolled back by cancelling the Route form. Disconnect cannot retract tasks already handed to DSH.

Legacy configuration supplies credentials for each origin; it is not an endpoint access allowlist. With valid configuration but no matching entry, requests carry no other origin's cookie and the target DSH decides whether to accept them. Explicitly disconnected protected records always block automatic recovery.

The presentation layer classifies legacy connection configuration failures as `dsh_connection_configuration`, and owner authentication exchange, expiry or disconnect failures as `dsh_connection_required`, rather than a generic Agent permission denial. Responses preserve raw diagnostics and include `errorMessages.zh-CN/en`. WebGUI language is stored in the browser, not a global Manager language setting; API consumers should select the corresponding field. Recovery guidance points to the local Route → Message adapters → Agent → DSH → Connect DSH panel. Automatic onboarding and live deployment still require separate acceptance.

For `DSH RPC transport failed; result may be unknown, check the original receipt before retrying.`, the presentation layer uses `dsh_transport_failed` before the generic HTTP 400 validation classification. It means the DSH connection transport did not complete, not that request parameters are invalid or Agent business permissions were denied. The original English `message` and `retryable: false` remain unchanged. The request is not automatically replayed, and its outcome may be unknown: check the original session and operation receipt before retrying; do not assume execution never started. This presentation-only correction changes neither HTTP status codes nor authentication/RPC execution logic and has not passed deployment acceptance.

## Legacy local configuration (compatibility entry)

Configure `stateRoot/data/dsh-auth.json` under the Host's stable state root, or explicitly select the file using the process variable `RABI_DSH_AUTH_FILE`. No user-level environment or DSH launch changes are needed. Replace example values with verified local settings:

```json
{
  "endpoints": [
    {
      "baseUrl": "http://127.0.0.1:3000",
      "launchLogPath": "/absolute/path/to/owner-stdout.log"
    }
  ]
}
```

The configuration contains no token or cookie. Do not commit deployment paths. The log must belong to the target DSH owner's existing launcher and contain its current `dsh web:` launch URL. This mode supports explicit loopback endpoints only; remote authentication is out of scope. Do not search disks, browsers or unrelated logs for credentials.

The bridge reads at most the final 256 KiB and selects the last matching origin/root URL with exactly one token. Authentication and RPC redirects are never followed. The exchange must return a root 303 and one supported HttpOnly cookie. Cookies remain in memory for a short time; concurrent exchanges are coalesced and endpoint/log-path changes do not reuse old cache entries. Errors never expose launch URLs, cookies or log contents.

A 401 invalidates the cookie; only a session-list query may recover and retry once. A timed-out or disconnected write may have an unknown outcome: inspect its original session and receipt before retrying, never create another task blindly. Without a matching log or protected record, the target may accept an unauthenticated request. An explicitly selected missing authentication file still produces a configuration error. Cache lifetime never exceeds Max-Age/Expires or the local five-minute refresh ceiling; deletion and expired cookies are rejected.

## Verification and deployment

- Isolated tests cover origin binding, credential non-disclosure across endpoints, no 401 replay, no RPC redirect following, and existing session/workspace boundaries.
- Start with real read-only session discovery; distinguish authentication, successful RPC and exact session identity. Do not print full histories or credentials.
- Then read the exact ID through Manager's formal bridge, validate source identity and verify an authorized delivery and reply.
- Evaluate the bridge's dependencies and imports against the running version's source hot-patch support matrix. When a controlled switch is required, create an immutable Developer candidate and activate it through Host. Never overwrite installed dist or restart DSH. Preserve unrelated changes and verify the candidate scope.

Without real delivery receipts, the integration remains experimental. A single HTTP 200 is not complete acceptance.
