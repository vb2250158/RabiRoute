<!-- docs-language-switch -->
English | [简体中文](dsh-browser-auth.md)
<!-- /docs-language-switch -->

# DSH Web session bridge authentication

Status: managed deployment and formal round-trip delivery accepted. Authentication alone does not prove delivery; verify the separate receipts below.

2026-09-14 verification: all 11 authentication/protocol tests and the full build passed. Host Developer candidate 0.3.1-b51d2326b858 activated with required capabilities and plan storage ready. The formal thread bridge read an exact session, created a session, and sent a follow-up to the same session with delivered / dsh_session_owner receipts. The recipient formally replied DSH_AUTH_DELIVERY_OK; Manager readback showed responded. Real images and model changes remain unverified. Plan-binding mutations still require a caller supporting strong ETags and idempotency headers; message acceptance is not binding acceptance.

## One owner and authentication path

RabiRoute continues using the current DSH Web owner's session API. It does not start another Runtime, disable DSH authentication, read signing keys, or forge cookies. DSH owns sessions, execution, models, tools and permissions; Manager owns plans and delivery receipts.

Current DSH Web exchanges its process launch URL for a cookie at the root path. An unauthenticated legacy bridge receives HTTP 401. Changing the port alone cannot fix authentication or the legacy RPC contract.

## Local configuration

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
