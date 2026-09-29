# Phone glasses knowledge authorization (experimental)

English | [简体中文](knowledge-grant-phone-ui.md)

An MCP reference in a device Agent profile is not authorization. This editor separately selects role IDs, a fixed supported tool list and writes (disabled by default). It accepts no PC address, token or connection credentials. Role IDs must match existing PC roles. Effective permissions remain the intersection of Relay device grants, PC-local device grants and MCP service policy.

The panel indicates missing explicit PC selection or missing bridge capability. Saving confirms Relay authorization storage only, not effective local authorization or a successful call. Recent-memory details update view time and also require write permission. The current glasses single-step layer still advertises read-only tools; enabling writes does not automatically implement write interactions.

## Save and recovery

Writes use `expectedRevision` and a stable `idempotencyKey`. The frozen request is first retained in `sessionStorage`, scoped by account, app and device; storage failure prevents dispatch. A 200 receipt must match the full grant, revision and key. Network failures or incomplete receipts never trigger automatic replay or a replacement key.

After refresh, an authenticated ownership read precedes pending recovery. `GET /manage/api/apps/:appId/devices/:bindingId/knowledge-grant/operations/:key` returns `{code:0,data:{receipt:null|{idempotencyKey,revision,grant}}}`. Only a fully matching historical receipt releases pending state, even after another client has saved a newer revision. A null receipt or 404 does not prove failure. Closing the tab or clearing browser data may lose session recovery records.

Each device retains at most 128 grant receipts. Capacity exhaustion rejects writes; do not retry with another key. The editor does not change PC-local security configuration, launch MCP or execute knowledge operations.

## Verification status

Pure Node DOM tests execute the independent editor function and cover frozen requests, refresh recovery, complete receipts, owner isolation, storage failure and historical readback. The management page now exposes Knowledge authorization next to Agent settings. An isolated real Relay HTTP test covers historical receipts, cross-owner rejection and unknown keys. All six UI and HTTP tests pass. A simulated DOM is not phone layout or device acceptance; no public deployment or real business operation was performed.

Subsequent isolated local Chrome checks found that the editor incorrectly bound native `fetch` to its environment, throwing `Illegal invocation` before authorization requests were sent. The injection now uses a wrapper, with a receiver regression test executing the actual injection line. After correction, widths of 320, 390 and 768 pixels completed profile and grant saves and revision readback. Long Skill JSON did not widen the document; save buttons remained reachable by scrolling and long tool labels were clickable. This is desktop-browser narrow-screen verification, not physical phone touch or glasses acceptance. The earlier frozen Windows release lacks this correction and has a known phone authorization defect; it must not be recommended for deployment using these corrected-source results. Role and tool inputs are frozen during initial reads, saves and uncertain pending operations to avoid late reads overwriting edits. Tools and write permission use separate full-row labels with a 44-pixel minimum height and 20-pixel checkboxes, without changing global styles or authorization policy.
