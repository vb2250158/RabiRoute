<!-- docs-language-switch -->
<div align="center">English | <a href="./implemented-requirements.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Implemented desktop-pet requirements

Code integration and installed acceptance are recorded separately. Deployment status is dated 2026-10-17. The local Windows acceptance machine's identity, installation pointer and screenshots remain in private deployment receipts, outside public source.

| Requirement | Implementation in main | Installation and validation |
| --- | --- | --- |
| Smooth dragging, negative desktop coordinates, release outside the window | `19333c18` | Local Windows acceptance machine: 0.3.50 installed; native Qt drag fixture passed using installed Python |
| Throw inertia, gravity, bounce, landing recovery and recapture | `19333c18` | Same machine, 0.3.50; physics regressions and installed throwing/landing recovery passed |
| Live size slider preview using canvas pixels | `19333c18` | Same machine, 0.3.50; 25%/50%/75% produced 128/256/384px, retained the frame cache and preserved the binding |
| Fixed pixel size across monitors with different DPI | `19333c18` | Same machine, 0.3.50; round-trip 100%/150% DPI drag fixture passed; the Host-owned pet was moved through Manager to both monitors, captured and restored; decoded images stayed 256px (native edge rounding at most 1px) |
| Pet manager retained for application lifetime; recovery from an empty startup roster | `af39725a`, `7754eee0` | Same machine, 0.3.50; Host-owned pet visible and runtime files matched the candidate |
| One-shot `lift` and `throw`, looping `airborne`, slight flight tilt | `20a88832` | Same machine, 0.3.50 with v20; correct phase order, all 34 airborne frames and one complete loop observed; landing reset tilt |
| Developer readiness deadline covers Host startup | `562b4a4c` | Same machine, 0.3.50; controlled activation and Host/Manager/Tray identity checks passed without rollback |

Drag fixtures use real Qt windows, monitors and native coordinates with pointer traces injected inside the test process. They do not establish manual mouse acceptance. See [the motion contract](desktop-pet-agent-motion_en.md) for action semantics, stride calibration and APIs. Check the source pack, persona binding and runtime cache separately; importing a pack does not activate it.

## 0.3.49 activation timeout memo

Developer apply and publish scripts defaulted to 120 seconds. Host permits 180 seconds for Manager readiness and 120 seconds for Tray readiness, plus health admission and bootstrap time. The shorter outer deadline can roll back a candidate that is still starting within Host's own budget.

Local logs show that the candidate Manager had run for only about 66 seconds when rollback arrived. Its replacement then encountered the previous Manager's single-instance guard. Version 0.3.50 sets both script defaults to 420 seconds and includes the updated scripts in immutable Developer candidates. Generation fencing, pointer compare-and-swap, complete readiness checks and rollback remain enforced.

The 420-second deadline is bounded; it cannot guarantee readiness on every slow storage system. Child shutdown after startup cancellation, heartbeat-triggered restarts and degraded plan storage require separate investigation. This budget fix does not establish that those issues are resolved. Similar slow-start symptoms were reported on another machine, but its logs have not been verified and a shared root cause is unconfirmed.

The installed release is `0.3.50-00c1b4327a20`, built from `562b4a4c`, with active pack `yeyu-library-flat-wide-airborne-v20`. Private deployment receipts retain machine identity, full generation checks, production-window captures on both monitors and installed drag/throw/airborne/scaling evidence. Screenshots and runtime data stay outside public source. Overall Host health remains `degraded`; pet acceptance does not establish that every background feature is healthy.

## Source integrated in the same batch

Additional production-window scaling acceptance found that 0.3.50 retained the larger window's vertical position when shrinking from 75% to 50%, leaving a 128px gap. Version 0.3.52 reapplies saved placement after scale changes, with regressions for restoring the floor anchor and preserving current position on unrelated setting changes. Installed revalidation is recorded separately.

Installed 0.3.52 revalidation confirmed height recovery and exposed a 10px horizontal offset from calculating initial placement with the placeholder size. Version 0.3.53 reapplies placement after the first real frame, while preserving a user drag completed before loading finished. Final installed revalidation is recorded separately.

[PR #6](https://github.com/vb2250158/RabiRoute/pull/6), [PR #7](https://github.com/vb2250158/RabiRoute/pull/7) and [PR #8](https://github.com/vb2250158/RabiRoute/pull/8) are included in the main history above. [PR #9](https://github.com/vb2250158/RabiRoute/pull/9), media inspector `860b4c15`, is merged with 0.3.51; six image/audio/video acceptance and rejection samples passed. This is source integration; the installed 0.3.50 package does not claim to include that later restoration.
