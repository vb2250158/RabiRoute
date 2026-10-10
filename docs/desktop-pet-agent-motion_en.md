<!-- docs-language-switch -->
<div align="center">English | <a href="./desktop-pet-agent-motion.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Desktop-pet motion API

An Agent instructs an enabled pet through Manager; Qt Desktop uses the current pack's walking/teleport animations. Wandering need not be enabled and its settings remain unchanged. Application windows are neither focused nor moved.

Discover the current Manager through Host and verify generation/instance at `/meta`, as described in [the Agent interfaces](rabi-agent-interfaces_en.md).

`POST /api/desktop-pet/roles/:roleId/motion`, with `Content-Type: application/json` and `Idempotency-Key` equal to `requestId`:

```json
{"requestId":"pet-move-0001","mode":"auto","target":{"kind":"active-window","corner":"bottom-right"}}
```

| Field | Contract |
| --- | --- |
| `requestId` | 8–128 ASCII letters/digits/underscore/dot/hyphen, starting with a letter or digit |
| `mode` | Optional `auto` (default), `walk`, or `teleport` |
| `target.kind=position` | Integer Qt logical desktop pixels `x`,`y`, within ±100000, including negative origins. Must lie on a connected screen; clamped to its work area to keep the entire pet visible |
| `target.kind=screen-corner` | `corner`, optional exact Qt `screenName`; defaults to the pet's current screen |
| `target.kind=active-window` | Resolve the active window's visible bounds and screen when executing; travel once without continuous following |
| `corner` | `bottom-right`, `bottom-left`, `top-right`, `top-left` |

Coordinates refer to the pet window's top-left. Auto uses the existing wander policy: walk on the same screen and across nearby monitor edges within one current-screen diagonal; teleport to farther cross-screen destinations. Corner targets include an inset and are clamped to the work area.

At preload, Desktop measures grounded soles in the rendered frames and calibrates cycle distance from backward displacement relative to source facing. Forward sweeps, support changes, still poses and unreliable jumps do not contribute to calibration. Speed is cycle distance divided by the actual playback period, scaling with render size and frame cap. One precise clock drives animation and continuous position updates approximately every 16ms, removing frame-sized position jumps. Delayed callbacks advance at most 50ms: animation and body slow together without catching up across the desktop. GIF walking retains original frame delays, and measured sole height stabilizes the floor without an extra hop. Unmeasurable gait refuses walking.

The pack root's `sourceFacing` declares original art facing (`left` or `right`, missing/invalid values default to `right` for compatibility). Manager validates and presents it to Desktop. Before the first step, Desktop mirrors only when the destination direction differs from source facing and retains facing after arrival. Horizontal squashing no longer simulates a turn.

This estimates cadence and stride from existing 2D art. Mirroring front-view marching does not provide a side-view turn, and arbitrary diagonal paths cannot guarantee a locked support foot. Strict foot locking needs directional walking art and authored contact measurements.

Read `GET /api/desktop-pet/roles/:roleId/motion/:requestId`. `code=0`, `data` contains a receipt:

- `accepted`: queued in Manager, not claimed by Desktop.
- `running`: claimed by Desktop; animations may still be preparing.
- `succeeded`: Desktop confirmed arrival, with actual `position`, resolved `destination`, and `travelKind` (`move`/`teleport`). Being already close enough can succeed immediately.
- `failed`: unavailable/hidden/locked/dragged/busy pet, missing animation, invalid destination, or unclaimed timeout.
- `cancelled`: interrupted by a click, drag, hide, close, or screen removal.
- `uncertain`: no arrival or actual movement progress within 30 seconds after claim; movement may have happened. During a slow walk, Desktop renews `running` every five seconds with the current claim only if position changed. Progress is not arrival, and a stalled renderer does not renew indefinitely.

Only one Agent motion per persona may be active. An explicit request wakes sleep, while user interaction and visibility/locking retain precedence. An existing wander movement fails the request; wait for it to end before submitting a new ID. Walking requires `move`; teleport requires `teleport-out` and `teleport-in`. Animation preparation waits at most ten seconds.

Identical ID/body returns the original receipt without repeating movement; a changed body returns `409`. HTTP `202` proves acceptance only. Query the original ID before any retry; never replace an uncertain ID automatically.

Receipts are generation-local memory, retained for one hour after completion, capped at 1000. A restart/expiry/generation change returning `404` means the result is unavailable, not proof that movement did not occur. Unclaimed requests fail after 20 seconds. Runtime claim/result endpoints are excluded from Agent tools and public receipts contain no claim token.
