<!-- docs-language-switch -->
<div align="center">English | <a href="./desktop-pet-agent-motion.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Desktop-pet motion API

See [implemented requirements](implemented-requirements_en.md) for integration, installation status and the startup timeout memo.

An Agent instructs an enabled pet through Manager; Qt Desktop uses the current pack's walking, running or teleport animations. Wandering need not be enabled and its settings remain unchanged. Application windows are neither focused nor moved.

For regular movement toward the active window, enable wandering and active-window destinations in the persona's avatar settings in WebGUI (`wanderEnabled=true`, `wanderToActiveWindow=true`). After each configured wait, the pet reads the current foreground window and chooses a reachable position. Companionship pauses wandering and restores it when ended. These settings are independent of the one-time motion API below.

Discover the current Manager through Host and verify generation/instance at `/meta`, as described in [the Agent interfaces](rabi-agent-interfaces_en.md).

`POST /api/desktop-pet/roles/:roleId/motion`, with `Content-Type: application/json` and `Idempotency-Key` equal to `requestId`:

```json
{"requestId":"pet-move-0001","mode":"auto","target":{"kind":"active-window","corner":"bottom-right"}}
```

| Field | Contract |
| --- | --- |
| `requestId` | 8–128 ASCII letters/digits/underscore/dot/hyphen, starting with a letter or digit |
| `mode` | Optional `auto` (default), `walk`, `run`, or `teleport` |
| `target.kind=position` | Integer Qt logical desktop pixels `x`,`y`, within ±100000, including negative origins. Must lie on a connected screen; clamped to its work area to keep the entire pet visible |
| `target.kind=screen-corner` | `corner`, optional exact Qt `screenName`; defaults to the pet's current screen |
| `target.kind=active-window` | Resolve the active window's visible bounds and screen when executing; travel once without continuous following |
| `corner` | `bottom-right`, `bottom-left`, `top-right`, `top-left` |

Coordinates refer to the pet window's top-left. `auto` and wandering share the same rule: run when the Euclidean distance exceeds half the available width of the pet's current screen, otherwise walk. Distance and width use Qt logical pixels, including cross-screen destinations. Automatic long-distance teleport has been removed; select `teleport` explicitly. Corner targets include an inset and are clamped to the work area.

Running requires a separate looping `run` animation and derives speed from its grounded stride and playback cycle while retaining airborne frames. Missing or uncalibratable running media fails without changing position; speeding up a walking animation does not count as running. Older packs can still use explicit walking. Import a new pack with `run` for automatic long-distance movement.

At preload, Desktop calibrates stride on a stable reference raster with a 256-pixel longest edge. Pixels with alpha >=128 define the occupied character height; its bottom 12% identifies the foot region, and approximately 1% of height averages the lowest sole rows. Ground-contact tolerance follows occupied height, while close/crossed feet do not shrink the valid sweep limit. Cycle distance comes from backward displacement of continuously grounded soles relative to source facing. Forward sweeps, support changes, still poses and unreliable jumps do not contribute. Reference stride and floor offsets scale by actual rendered dimensions into Qt logical pixels, avoiding small-size resampling drift; Qt handles screen DPI without a second scale multiplier. Speed is cycle distance divided by the actual playback period, scaling with render size and frame cap. One precise clock drives animation and continuous position updates approximately every 16ms, removing frame-sized position jumps. Delayed callbacks advance at most 50ms: animation and body slow together without catching up across the desktop. GIF walking retains original frame delays, and measured sole height stabilizes the floor without an extra hop. Unmeasurable gait refuses walking.

The pack root's `sourceFacing` declares original art facing (`left` or `right`, missing/invalid values default to `right` for compatibility). Manager validates and presents it to Desktop. Before the first step, Desktop mirrors only when the destination direction differs from source facing. After arrival, Desktop reads the current active window's center and uses a 180ms mirror transition to face it in place. Facing remains unchanged if no eligible window exists, it already faces the center, or the horizontal offset is within an 8 logical pixel deadband. Position stays fixed and frames keep playing forward. Cancellation, dragging, hiding or new travel ends the turn; new travel immediately faces its walking direction.

Changing packs cancels travel before loading the replacement; late animation, preload and catalog results from the old pack cannot enter the new pack. Repeated travel states do not restart the sequence or start a second clock. Losing the rendered animation stops travel. An unavailable selected pack displays an error rather than silently choosing another cached pack. A Manager scale change prepares cached actions and recalibrates stride at the new render size.

This estimates cadence and stride from existing 2D art. Mirroring front-view marching does not provide a side-view turn, and arbitrary diagonal paths cannot guarantee a locked support foot. Strict foot locking needs directional walking art and authored contact measurements.

Companion snapshots and passive reactions do not interrupt explicit travel, dragging, click reactions or active speech. Missed reactions are dropped rather than queued. After a click reaction, drag release or arrival, Desktop resumes current speech or idle rather than an already-ended speech state. Looping reactions last at most 30 seconds and respect the Manager event expiry; passive reactions do not count as user activity or postpone sleep.

Manual dragging follows the pointer smoothly on an independent clock at approximately 16ms intervals. On Windows, cursor and window positions use the same native pixel space; a normalized grab anchor adapts to window-size changes across monitor DPI boundaries, including negative desktop origins. Mouse capture is retained while held, without screen clamping, saved-position restoration or fullscreen hiding; loading a drag animation does not pull the pet back to its original monitor. Gentle release settles toward the release-time pointer position for at most 180ms, without following later cursor movement, then clamps to that monitor's work area and saves placement. Placement keys include the screen origin for identically named monitors, preventing settings synchronization from restoring to the first matching monitor; legacy plain names remain readable. Small pointer jitter remains a click. Release outside the window, hiding and closing release drag state.

A quick flick and release estimates initial velocity from the last 100ms of native pointer samples, then applies inertia, gravity, edge bounce and ground friction. Pausing before release places the pet normally. Launch strength and gravity scale with the current window pixel size, without mixing coordinate systems across DPI boundaries. Flight integrates in substeps no longer than 1/240 second, with at most 50ms of catch-up per frame. Adjacent display seams allow passage; desktop holes and outer edges bounce, and work-area floors avoid the taskbar. Flight retains the drag interaction state so automatic walking, placement synchronization and animation completion cannot interrupt it. Once settled, placement is saved once and the current idle, companion or speech state resumes. Grabbing again takes over immediately; hiding, closing, locking, resizing or enabling click-through cancels flight.

“Hide in fullscreen” applies only to a genuinely fullscreen foreground window on the pet's monitor. Ordinary maximized windows, the desktop and fullscreen windows on other monitors do not hide the pet. Leaving fullscreen restores current animation context; disabling the pet while fullscreen does not make it reappear on a later focus change.

New actions are fully decoded before replacing playback; failures retain the current action. Stationary action changes retain the previous frame for a 120ms transition; walking, teleporting, dragging and turning do not blend frames. Repeated state requests preserve playback progress. GIF and PNG use one player: GIF frame durations are retained, while looping and the next state follow the pack declaration. Random idle actions prefer to avoid the two most recent choices, falling back to avoiding consecutive repeats for smaller pools.

Read `GET /api/desktop-pet/roles/:roleId/motion/:requestId`. `code=0`, `data` contains a receipt:

- `accepted`: queued in Manager, not claimed by Desktop.
- `running`: claimed by Desktop; animations may still be preparing.
- `succeeded`: Desktop confirmed arrival, with actual `position`, resolved `destination`, and `travelKind` (`move`/`run`/`teleport`). Being already close enough can succeed immediately.
- `failed`: unavailable/hidden/locked/dragged/busy pet, missing animation, invalid destination, or unclaimed timeout.
- `cancelled`: interrupted by a click, drag, hide, close, or screen removal.
- `uncertain`: no arrival or actual movement progress within 30 seconds after claim; movement may have happened. During a slow walk, Desktop renews `running` every five seconds with the current claim only if position changed. Progress is not arrival, and a stalled renderer does not renew indefinitely.

Only one Agent motion per persona may be active. An explicit request wakes sleep, while user interaction and visibility/locking retain precedence. An existing wander movement fails the request; wait for it to end before submitting a new ID. The selected movement requires `move`, `run`, or both `teleport-out` and `teleport-in`. Animation preparation waits at most ten seconds.

Identical ID/body returns the original receipt without repeating movement; a changed body returns `409`. HTTP `202` proves acceptance only. Query the original ID before any retry; never replace an uncertain ID automatically.

Receipts are generation-local memory, retained for one hour after completion, capped at 1000. A restart/expiry/generation change returning `404` means the result is unavailable, not proof that movement did not occur. Unclaimed requests fail after 20 seconds. Runtime claim/result endpoints are excluded from Agent tools and public receipts contain no claim token.

Manual dragging follows the pointer smoothly on an independent clock at approximately 16ms intervals. On Windows, cursor and window positions use the same native pixel space; a normalized grab anchor is retained while native pixel size stays fixed across monitor DPI boundaries, including negative desktop origins. Mouse capture is retained while held, without screen clamping, saved-position restoration or fullscreen hiding; loading a drag animation does not pull the pet back to its original monitor. Gentle release settles toward the release-time pointer position for at most 180ms, without following later cursor movement, then clamps to that monitor's work area and saves placement. Placement keys include the screen origin for identically named monitors, preventing settings synchronization from restoring to the first matching monitor; legacy plain names remain readable. Small pointer jitter remains a click. Release outside the window, hiding and closing release drag state.

A quick flick and release estimates initial velocity from the last 100ms of native pointer samples, then applies inertia, gravity, edge bounce and ground friction. Pausing before release places the pet normally. Launch strength and gravity scale with the current window pixel size, without mixing coordinate systems across DPI boundaries. Flight integrates in substeps no longer than 1/240 second, with at most 50ms of catch-up per frame. Adjacent display seams allow passage; desktop holes and outer edges bounce, and work-area floors avoid the taskbar. Flight retains the drag interaction state so automatic walking, placement synchronization and animation completion cannot interrupt it. Once settled, placement is saved once and the current idle, companion or speech state resumes. Grabbing again takes over immediately; hiding, closing, locking, resizing or enabling click-through cancels flight.

Pet size uses native pixels: the pack canvas multiplied by the 10%–200% scale determines a fixed pixel size. Switching displays or Windows DPI retains those image pixels; only the Qt logical window size changes, with native sizing and fixed-pixel images; the transparent window edge may retain up to one pixel of fractional rounding. Crossing screens preserves decoded frames and playback progress. Strides and bubble anchors convert to the current Qt units while their physical pixel dimensions remain constant. The context-menu size slider previews decoded frames directly and saves scale together with placement when the menu closes; preview does not repeatedly decode or restart animation.

Packs may add `lift` (one-shot pickup, then `drag`), `throw` (one-shot launch, then `airborne`), and looping `airborne` states. Flight keeps the airborne animation running with a small velocity-driven tilt and sway, without resizing the window. Landing or grabbing again clears the tilt and restores the current companion, speech or idle context. Older packs retain `drag`; these states do not enter the random idle pool.

When settings change scale, Desktop reapplies the saved monitor and relative placement after resizing. A floor-anchored pet remains on the floor after growing against an edge and shrinking again. Other changes, such as opacity, retain its current travel position.

Once the first animation establishes the real canvas size, Desktop reapplies saved placement to remove placeholder-size offsets. A drag completed while assets were loading retains its current position; a late first frame does not pull the pet back.
