# AIUI device Agent profile HTTP (experimental)

English | [简体中文](aiui-agent-profile-http.md)

Relay stores configuration on existing application `deviceBindings`, without model or MCP credentials. Source and local isolated HTTP tests are complete; deployment and device acceptance are pending.

## Management account

`GET /manage/api/apps/:appId/devices/:bindingId/agent-profile` returns `{code:0,data:{profile,applied,savedRevision}}`. An authenticated account must own the application.

`PUT` uses JSON `{expectedRevision,idempotencyKey,profile}` and requires `Content-Type: application/json` plus `X-RabiLink-Profile-Write: 1`. `Sec-Fetch-Site: cross-site` is rejected; supplied Origin must match request Host (host/port). The custom header forces browser preflight; this contract grants no credentialed CORS. Reverse proxies must preserve the public Host, not bypass checks through forwarded headers. Existing account session/Basic authentication applies; device tokens cannot manage profiles.

Profile fields: `{revision,id,name,systemPrompt,skills,mcp}`. Revisions increase from 1; initial expectedRevision is 0. Skills contain `{id,title,content,enabled}`; MCP contains only `{id,label,enabled}` references, never tokens, URLs or commands. Limits are enforced by `scripts/rabilink-agent-profile.mjs`.

CAS conflicts return 412, reused keys with different intent return 409, identical retries return the original receipt. Each device retains at most 128 operation receipts; capacity fails closed rather than evicting keys and replaying old intent. A controlled receipt lifecycle is required before claiming unlimited production updates.

## Phone management UI

Sign in to Relay `/manage` in a phone browser and select **Agent 设置** on a bound glasses device. ID, name and system prompt use form fields; Skills use visual entries for ID, title, instruction content and enabled state, with add/remove controls. Limits remain 16 entries, 8000 content characters per entry and 24000 total, with buttons at least 44px high. Advanced JSON and visual modes are mutually exclusive: entering JSON synchronizes the draft; returning or saving requires the same profile validation. Invalid JSON remains visible and prevents sending, without creating a second configuration authority. MCP provides an enable checkbox and display label for the fixed `rabi-knowledge` reference. An absent reference is added only by explicitly enabling it; disabling preserves its entry and label. Unknown references retain order and enabled state in a read-only display explaining that this application does not support them; only explicit advanced JSON edits change or remove them. Sixteen existing entries without the known reference prevent insertion, never evicting entries. Advanced JSON and the form are mutually exclusive views of one draft; invalid text is retained and prevents sending. Open the device's separate knowledge authorization panel for grants. URL, token and command fields are rejected; this does not install third-party services or expand permissions. Saved revision, model application receipt and **MCP unverified** are shown separately; saving a reference never claims a connection.

All fields and Skill controls are frozen during initial readback, saving and pending confirmation. The complete profile is validated before sending. A late response after an account change neither clears the original intent nor advances its revision, and cannot reinsert the old panel into the new account's blocking set. Network failures or incomplete receipts freeze the original body and idempotency key and allow readback only, with no automatic resend or replacement key. Before sending, the exact body and key are saved in tab-scoped `sessionStorage`, isolated by authenticated account ID, app ID and binding ID; storage failure prevents sending and no token is stored. Hard refresh restores pending intent only after the same account passes the device ownership GET, never replaying it. Success requires a complete normalized profile match and valid applied fields; matching key and revision alone is insufficient. Pending writes query the original key at `GET /manage/api/apps/:appId/devices/:bindingId/agent-profile/operations/:key` (`{code:0,data:{receipt}}`), so a historical write can be confirmed even when a newer profile has replaced it. `receipt:null` is not proof of failure and never triggers a resend. Confirmed success or explicit refusal clears it; logout hides the editor and other accounts cannot restore it. Closing the tab or clearing browser data may still lose intent, so navigation warns and application-list refresh cannot overwrite the editor. A 412 requires fresh readback and confirmation. The 128-receipt capacity error directs maintenance instead of key rotation. Readback replaces unsaved edits; retain any draft first.

A dependency-free minimal DOM harness using Node built-ins runs the real management-page JavaScript (not browser layout tests), covering safe text rendering, double-click prevention, write headers, refresh recovery, cross-account isolation, storage failure refusal, uncertain-result readback, 412 and capacity errors. The related tests pass 18/18. Real Chrome at 320/390/768px verifies visual Skill addition, saving and matching GET readback; invalid advanced JSON sends no mutation and retains its text, with no horizontal overflow and buttons at least 44px high. Actual-page DOM tests cover uncertain receipts and late account isolation. The later MCP selector passes 13/13 related pure and actual-page DOM tests. Chrome at 320/390/768px verifies enabling the reference, editing its label, saving and matching GET readback while preserving the existing Skill; invalid advanced JSON sends zero PUT requests and retains its text, without horizontal overflow or page errors. Pure tests cover preservation of enabled unknown references, the sixteen-entry boundary, validation and freezing. Deployment and physical phone acceptance remain pending. The MCP selector adds a fourteenth Relay module; frozen thirteen-module candidate `0.3.15-d1ae4d594048` excludes this later UI, so its evidence does not replace acceptance of the new editor.

## Device

Use the existing `x-rabilink-token` header. Only independent credentials of enabled device bindings are accepted; application tokens are rejected.

- `GET /api/rabilink/device/agent-profile`: own profile only.
- `POST /api/rabilink/device/agent-profile/applied`: `{idempotencyKey,appliedRevision,status,errorCode?}`. Status is `applied` or `failed`; failures require a restricted errorCode. Unsaved revisions or regression below an acknowledged version are rejected.

Saved does not mean applied on glasses; application acknowledgements do not prove actual MCP connectivity or execution.

## Storage and verification

Transactions synchronously read-modify-write in the existing single Relay process, without await gaps. The full store is written to an exclusive same-directory temporary file, fsynced, then renamed. Read or persisted-profile validation failures stop processing instead of replacing data with an empty store. Multi-process shared-file writes and cross-platform power-loss guarantees are not claimed.

The isolated fixture starts a real Relay with temporary accounts, devices and files. It covers identity, CSRF, CAS, idempotency, restart recovery and corrupt-store fail-closed behavior. No public Relay or real user configuration is modified.
