<!-- docs-language-switch -->
<div align="center">English | <a href="./implemented-requirements.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Implemented desktop-pet requirements

Code integration and installed acceptance are recorded separately. Deployment status is dated 2026-10-17. Windows acceptance machine A's identity, installation pointer and screenshots remain in private deployment receipts, outside public source.

| Requirement | Implementation in main | Installation and validation |
| --- | --- | --- |
| Smooth dragging, negative desktop coordinates, release outside the window | `19333c18` | Acceptance machine A: 0.3.53 installed; native Qt drag fixture passed using installed Python |
| Throw inertia, gravity, bounce, landing recovery and recapture | `19333c18` | Same machine, 0.3.53; physics regressions and installed throwing/landing recovery passed |
| Live size slider preview using canvas pixels | `19333c18` | Same machine, 0.3.53; the 512px acceptance canvas produced 128/256/384px at 25%/50%/75%, with decoded frames retained during preview |
| Restore saved relative placement after shrinking | `7e4c4dc9` | Same machine, 0.3.53; production-window scaling restored the original monitor, native position and saved scale |
| First-frame placement uses the real canvas and preserves user drags during loading | `074c19c9` | Same machine, 0.3.53; initial production placement matched saved ratios; late-frame/drag regressions passed |
| Fixed pixel size across monitors with different DPI | `19333c18` | Same machine, 0.3.53; round-trip 100%/150% DPI drag fixture passed; the Host-owned pet was moved through Manager to both monitors, captured and restored; decoded images stayed 256px (native edge rounding at most 1px) |
| Pet manager retained for application lifetime; recovery from an empty startup roster | `af39725a`, `7754eee0` | Same machine, 0.3.53; Host-owned pet visible and runtime files matched the candidate |
| One-shot `lift` and `throw`, looping `airborne`, slight flight tilt | `20a88832` | Same machine, 0.3.53 with v20; correct phase order, all 34 airborne frames and one complete loop observed; landing reset tilt |
| Developer readiness deadline covers Host startup | `562b4a4c` | Same machine, 0.3.53; controlled activation and Host/Manager/Tray identity checks passed without rollback |
| Raise the thread bridge threadId/sourceThreadId limit from 80 to 512 (#10) | `4a68bc27` (merge `fb6423a3`) | 68 targeted tests passed; backend build and type checking passed |
| DSH reconnect verification requests the first paged session/list result, with a 60-second timeout and 32 MiB cap for verification only (#11) | `2356d0be` (merge `0ae8c76e`) | 6 connection tests passed (paging, >10 s response, 8-32 MiB response, over-cap rejection); backend build and CodeQL/Gitleaks/dependency audit passed |
| Route save lock is rechecked with the original owner after child termination before reopening; delivery rules are validated only within the Route being saved (fixes Grok Bot settings failing to save; from Codex session 01a14ac1) | PR #12 | Targeted tests and full build: see PR |
| DSH reconnect validation sends `session/list` args as an object (fixes the 502 root cause), surfaces DSH error code/message with credential redaction, and raises the total connection timeout from 25 to 90 seconds (#13) | `9efcea18` (merge commit pending) | 14 DSH connection tests passed; backend build passed |

Drag fixtures use real Qt windows, monitors and native coordinates with pointer traces injected inside the test process. They do not establish manual mouse acceptance. See [the motion contract](desktop-pet-agent-motion_en.md) for action semantics, stride calibration and APIs. Check the source pack, persona binding and runtime cache separately; importing a pack does not activate it.

## 0.3.49 activation timeout memo

Developer apply and publish scripts defaulted to 120 seconds. Host permits 180 seconds for Manager readiness and 120 seconds for Tray readiness, plus health admission and bootstrap time. The shorter outer deadline can roll back a candidate that is still starting within Host's own budget.

Local logs show that the candidate Manager had run for only about 66 seconds when rollback arrived. Its replacement then encountered the previous Manager's single-instance guard. Version 0.3.50 sets both script defaults to 420 seconds and includes the updated scripts in immutable Developer candidates. Generation fencing, pointer compare-and-swap, complete readiness checks and rollback remain enforced.

The 420-second deadline is bounded; it cannot guarantee readiness on every slow storage system. Child shutdown after startup cancellation, heartbeat-triggered restarts and degraded plan storage require separate investigation. This budget fix does not establish that those issues are resolved. Similar slow-start symptoms were reported on another machine, but its logs have not been verified and a shared root cause is unconfirmed.

The installed release is `0.3.53-de9597b1bb16`, built from `074c19c9`, using the v20 acceptance pack. All 222 pet regressions and installed acceptance passed. Private deployment receipts retain machine identity, full generation checks, production-window captures on both monitors and installed drag/throw/airborne/scaling evidence. Screenshots and runtime data stay outside public source. Overall Host health remains `degraded`; pet acceptance does not establish that every background feature is healthy.

## Source integrated in the same batch

Production-window acceptance exposed two placement defects: 0.3.50 retained the enlarged window's position when shrinking from 75% to 50%, leaving a 128px gap; initial placeholder dimensions also caused a 10px horizontal offset. Fixes `7e4c4dc9` and `074c19c9` are both included in the installed 0.3.53 release.

The production window returned to its original position and size after 25%→50%→75%→50%, preserving saved placement. Separate regressions cover initial placement, drags completed before late asset loading, and retaining current position on unrelated settings refreshes.

[PR #6](https://github.com/vb2250158/RabiRoute/pull/6), [PR #7](https://github.com/vb2250158/RabiRoute/pull/7) and [PR #8](https://github.com/vb2250158/RabiRoute/pull/8) are included in the main history above. [PR #9](https://github.com/vb2250158/RabiRoute/pull/9), media inspector `860b4c15`, is merged with 0.3.51; six image/audio/video acceptance and rejection samples passed.
