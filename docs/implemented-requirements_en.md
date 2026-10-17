<!-- docs-language-switch -->
<div align="center">English | <a href="./implemented-requirements.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Implemented desktop-pet requirements

Code integration and installed acceptance are recorded separately. Deployment status is dated 2026-10-17. The local Windows acceptance machine's identity, installation pointer and screenshots remain in private deployment receipts, outside public source.

| Requirement | Implementation in main | Installation and validation |
| --- | --- | --- |
| Smooth dragging, negative desktop coordinates, release outside the window | `19333c18` | Local Windows acceptance machine: 0.3.48 installed; native Qt drag fixture passed |
| Throw inertia, gravity, bounce, landing recovery and recapture | `19333c18` | Same machine, 0.3.48; physics and landing recovery regressions passed |
| Live size slider preview using canvas pixels | `19333c18` | Same machine, 0.3.48; scaling regressions passed |
| Fixed pixel size across monitors with different DPI | `19333c18` | Same machine, 0.3.48; round-trip 100%/150% DPI fixture passed, with 256px decoded images and native window dimensions (at most 1px edge rounding) |
| Pet manager retained for application lifetime; recovery from an empty startup roster | `af39725a`, `7754eee0` | Same machine, 0.3.48; Host-owned pet window acceptance passed |
| One-shot `lift` and `throw`, looping `airborne`, slight flight tilt | `20a88832` | 0.3.49 source and native Qt preview passed; formal activation timed out and rolled back to 0.3.48; installed acceptance remains pending |

Drag fixtures use real Qt windows, monitors and native coordinates with pointer traces injected inside the test process. They do not establish manual mouse acceptance. See [the motion contract](desktop-pet-agent-motion_en.md) for action semantics, stride calibration and APIs. Check the source pack, persona binding and runtime cache separately; importing a pack does not activate it.

## 0.3.49 activation timeout memo

Developer apply and publish scripts defaulted to 120 seconds. Host permits 180 seconds for Manager readiness and 120 seconds for Tray readiness, plus health admission and bootstrap time. The shorter outer deadline can roll back a candidate that is still starting within Host's own budget.

Local logs show that the candidate Manager had run for only about 66 seconds when rollback arrived. Its replacement then encountered the previous Manager's single-instance guard. The next version sets both script defaults to 420 seconds and includes the updated scripts in immutable Developer candidates. Generation fencing, pointer compare-and-swap, complete readiness checks and rollback remain enforced.

The 420-second deadline is bounded; it cannot guarantee readiness on every slow storage system. Child shutdown after startup cancellation, heartbeat-triggered restarts and degraded plan storage require separate investigation. This budget fix does not establish that those issues are resolved. Similar slow-start symptoms were reported on another machine, but its logs have not been verified and a shared root cause is unconfirmed.

After formal deployment, record the final commit, full releaseId, installed machine, Host/Manager generation verification, active pack, and evidence for dragging, throwing, airborne looping, scaling and round-trip monitor dragging.
