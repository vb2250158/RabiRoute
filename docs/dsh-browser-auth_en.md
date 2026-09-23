<!-- docs-language-switch -->
English | [简体中文](dsh-browser-auth.md)
<!-- /docs-language-switch -->

# DSH Web session bridge authentication

Status: managed deployment and formal round-trip delivery accepted. Authentication alone does not prove delivery; verify the separate receipts below.

2026-09-14 verification: all 11 authentication/protocol tests and the full build passed. Host Developer candidate 0.3.1-b51d2326b858 activated with required capabilities and plan storage ready. The formal thread bridge read an exact session, created a session, and sent a follow-up to the same session with delivered / dsh_session_owner receipts. The recipient formally replied DSH_AUTH_DELIVERY_OK; Manager readback showed responded. Real images and model changes remain unverified. Plan-binding mutations still require a caller supporting strong ETags and idempotency headers; message acceptance is not binding acceptance.

## One owner and authentication path

RabiRoute continues using the current DSH Web owner's session API. It does not start another Runtime, disable DSH authentication, read signing keys, or forge cookies. DSH owns sessions, execution, models, tools and permissions; Manager owns plans and delivery receipts.

Current DSH Web exchanges its process launch URL for a cookie at the root path. An unauthenticated legacy bridge receives HTTP 401. Changing the port alone cannot fix authentication or the legacy RPC contract.

## Session bridge endpoint selection

The session bridge first uses an explicit `dshBaseUrl` from call options, then the address of a complete DSH primary binding, and finally the shared `resolveDshBaseUrl()`. Without a complete primary binding, default read and list requests also use existing local discovery: `DSH_WEB_URL` first, then clean loopback origins from known launch logs under `DSH_HOME`. If neither provides an address, the original `DEFAULT_DSH_BASE_URL` remains the fallback. An address without a valid session ID and working directory is not a complete primary binding.

This fix does not scan ports, retry against candidate addresses, extract credentials from discovery logs, or change the no-automatic-replay rules for 401 responses and writes. Endpoint selection and authentication remain separate. Isolated HTTP fixtures cover default reads/lists and primary/explicit endpoint priority; live deployment acceptance is still pending.

## Connect in WebGUI (in development; deployment not accepted yet)

Use **Connect DSH** in the local RabiRoute console's DSH settings:

1. Start DSH and copy its current login link. It contains credentials: do not share it in chat or documents.
2. Paste it into **DSH login link** and connect. RabiRoute verifies the login and read-only session API, protects the authorization on this computer, and fills in the credential-free address. No log lookup or manual JSON editing is needed.
3. Use the existing scan button to choose a session, then save the Route. Connecting or removing authorization never creates, deletes, or replaces session bindings.
4. Existing log-based installations can explicitly **Verify and save existing connection**. If the log is unavailable, provide the current login link instead.

Authorization is stored only in this computer's `stateRoot/data/dsh-connections/`, outside persona synchronization. Windows uses current-user DPAPI; other platforms use encryption with a restricted local key. DSH grants access to the entire Web owner, not a delivery-only or session-specific scope. Removing authorization stops RabiRoute from using it; it does not revoke other clients.

An unexpired authorization survives ordinary DSH restarts at the same address with the same signing configuration. Reconnect after hostname/port changes, expiry, or signing configuration changes. RabiRoute does not scan ports or silently select another instance. LAN/Relay pages cannot authorize the local DSH: perform setup on the RabiRoute computer. Authorize each computer separately and use remote Agent integration for cross-computer collaboration; do not share cookies.

### API and security boundaries

- `GET /api/agent-adapters/dsh/connections`: returns `ok`, `revision`, and `endpoints` containing clean addresses, states, and timestamps only. `saved` does not mean online.
- `GET /api/agent-adapters/dsh/connection?baseUrl=<origin>`: returns one connection's metadata and global configuration revision; no session scan.
- `POST /api/agent-adapters/dsh/connection`: JSON `{launchUrl, expectedRevision}`, or explicit migration `{baseUrl, expectedRevision}`. Performs a strictly origin-bound exchange and a read-only `session/list` verification, then returns `connection` and the new revision.
- `DELETE /api/agent-adapters/dsh/connection`: JSON `{baseUrl, expectedRevision}`. Persists a disconnected marker so legacy logs cannot silently restore authorization.
- Mutations require a local same-origin browser with a matching Origin header. LAN, forwarded, cross-site, and Relay requests are rejected. Request limit: 16 KiB. Conflicts return 409; reread and let the user decide before submitting again. No automatic replay.
- Authentication accepts only a local loopback root URL with one token, never follows redirects, and never exposes credentials in ordinary configuration, API responses, errors, or logs. Exchange and verification each have a ten-second deadline. Task RPCs retain their no-automatic-replay boundary.

2026-09-17 development verification: focused authentication, session-bridge, and UI-client tests passed, including real Windows DPAPI storage, same-address reads, no 401 replay, no legacy fallback after disconnect/expiry, revision conflicts, and Relay/cross-site rejection. Backend/frontend type checks, an isolated full `npm run build`, and all five dynamic Manager contract tests passed. A managed candidate started successfully and its live APIs verified metadata reads, rejection of mutations without Origin, and migration/protected storage of a real existing DSH authorization. Another release subsequently replaced it, so final stable-runtime acceptance is still pending, along with real-browser and second-computer acceptance. This is not a fully accepted rollout.

### Legacy log compatibility exit criteria

To avoid breaking existing installations during upgrade, log authentication remains only for legacy endpoints with no protected-store record. The only migration path is WebGUI **Verify and save existing connection**, or pasting the current login link. Once authorization is saved, expires, or is removed, business RPCs never use that endpoint's old log again. Reconnecting after removal requires the login link. After every configured endpoint migrates, the old `dsh-auth.json` can be removed; new installations do not need it. Authorization saves immediately and is not rolled back by cancelling the Route form. Disconnect blocks requests not yet dispatched but cannot retract tasks already handed to DSH.

Legacy configuration supplies credentials for each origin; it is not an endpoint access allowlist. A valid configuration without a matching entry no longer blocks dispatch: the request carries no other origin's cookie, and the target DSH decides whether to accept it. Authentication failures are not retried. Expired or explicitly disconnected protected records still block dispatch and never fall back to logs. This change has not yet passed deployment acceptance.

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

A 401 invalidates the cookie but never replays that RPC. A timed-out or disconnected write may have an unknown outcome: inspect its original session and receipt before retrying, never create another task blindly. Only an absent default configuration retains unauthenticated access for deployments that do not require this exchange. An explicitly selected missing file or missing endpoint mapping fails before RPC without downgrade. Cache lifetime is bounded by Cookie Max-Age/Expires and a local five-minute refresh limit; expired/deletion cookies are rejected.

## Verification and deployment

- Isolated tests cover origin binding, credential non-disclosure across endpoints, no 401 replay, no RPC redirect following, and existing session/workspace boundaries.
- Start with real read-only session discovery; distinguish authentication, successful RPC and exact session identity. Do not print full histories or credentials.
- Then read the exact ID through Manager's formal bridge, validate source identity and verify an authorized delivery and reply.
- This bridge is not a supported source hot-patch module. After matching tests and a full build, create an immutable Developer candidate and switch generations through Host. Never overwrite installed dist or restart DSH. Preserve unrelated changes and verify the candidate scope.

Without real delivery receipts, the integration remains experimental. A single HTTP 200 is not complete acceptance.
