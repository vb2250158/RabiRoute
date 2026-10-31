English | [简体中文](persona-health-api-contracts.md)

# Executable contracts for role health APIs

This group registers native wearable-health configuration, state, history, summaries and observations through executable definitions. Original `wearableHealth` storage retains samples, policy, deduplication, state and alert computation. The original Manager router retains alert delivery.

| Operation ID suffix | Method | Role path |
| --- | --- | --- |
| `summary.compat` | GET | `/:roleId/health` |
| `state` | GET | `/:roleId/health/state` |
| `history` | GET | `/:roleId/health/history` |
| `summary` | GET | `/:roleId/health/summary` |
| `config.read` | GET | `/:roleId/health/config` |
| `config.patch` | PATCH | `/:roleId/health/config` |
| `observations` | POST | `/:roleId/health/observations` |

Each operation retains `/api/roles` and `/roles`, giving fourteen concrete routes. Full IDs start with `manager.personas.health.`; `/roles` IDs add `.alias`. Original `knowledge` and `knowledge-alias` IDs remain aliases. Authenticated empty nodes can invoke public operations without role, Route or feature grants.

## Observation writes and generation

POST retains the existing Host lifecycle fence. Callers read `/meta` through the current dynamically discovered address and send `x-rabiroute-expected-application-generation-id` and `x-rabiroute-expected-manager-instance-id`. Missing/malformed headers return 400, stale identities return 409, and an unavailable Host-owned generation returns 503. Validation precedes body consumption. Read operations do not require these observation-write headers.

Each request captures the current role directory, original authenticated connection and Manager identity, then rechecks before mutation and after awaited delivery. Changed Hosts, directories or generations prevent later writes or stale disclosure. Lifecycle fencing binds execution to the intended generation while connection permissions follow the unified model.

## Native storage and alerts

Observations retain the native top-level/nested `health` overlay. Nested fields override top-level values; policy/samples retain native null fallback. Original owners retain sample/metadata normalization, the recent-ID window, duplicate handling, cooldown and state staleness. Retries should preserve event/sample IDs and reconcile current state/history.

History preserves repeated/comma-separated metric selectors, device/time/limit/order behavior and ignored unknown metrics. `health` and `health/summary` use the same native summary implementation. Config/observation bodies retain production `maxBytes=0`, empty `{}` and native normalization without another feature gate.

Only explicit `deliverAlerts=1/true/yes` with newly generated native alerts invokes the existing delivery owner. Samples persist before delivery is awaited. Delivery failure keeps committed samples and uncertainty. Caller cancellation still joins accepted original delivery and never re-ingests the sample. HTTP 202 describes observation processing and does not establish actual message delivery.

## Verification and scope

Isolated tests cover all fourteen routes with actual empty-node authentication, native config/state/history/summary/replay, pre-body 400/409/503, nested precedence, controlled alert delivery/failure readback, cancellation joins, directory/Host changes and original storage/projection regressions. Only temporary health data is written; controlled drivers send no real message.

This group changes no role lifecycle, business authority or health-storage format. Source verification does not establish installed-runtime or physical-device acceptance. Remaining owners retain their separate legacy-prefix migration boundaries.
