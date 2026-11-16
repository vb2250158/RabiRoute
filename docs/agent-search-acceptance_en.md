> Historical task material, reviewed on 2026-11-14. The current C workspace and installed Host are 0.15.2 (`dcfb8a42`). This document preserves its original task-stage content. Version references, line numbers and completion markers retain their original context. Verify current behavior against the [code architecture](code-architecture_en.md), [Agent integration requirements](agent-adapter-standard-requirements_en.md) and formal acceptance evidence.

[中文](agent-search-acceptance.md)

# Agent Search Implementation and Acceptance

> Baseline correction. Verification on 2026-11-13 established that implementation and test inputs in this record came from the original workspace still labeled `0.6.0`, at HEAD `a17a1764b5ebefb7c6f8a07762e8ac2e0fde2e43`. The maintained baseline and running version are already `0.15.0`, corresponding to commit `3ba56e395d11c6210e8c6094ced61f6e8dae1cbf`, and unified search currently returns 404. Passing results below apply to the original workspace candidate. The integration task is migrating search changes into the refactored structure. Operation registration, original-owner call chains, permission behavior, all 12 scenarios and built runtime acceptance require verification after migration. Delivery status is corrected accordingly, with 0.15 search implementation acceptance still pending.

On 2026-11-13, P0/P1 source implementation, fixed-scenario regressions, a full build and isolated Manager runtime acceptance were completed under section 8.1 of the [implementation plan](agent-search-architecture_en.md). Actual Hook loading in external hosts, real multi-endpoint message coverage, physical-device acceptance and performance targets still require their environment evidence. The installed running instance awaits a switch to this candidate.

## Implementation

| Scope | Changes and evidence |
| --- | --- |
| P0-1 | Legacy knowledge queries validate the role first. Unknown roles return 404 `AGENT_NOT_FOUND` with repair through `GET /api/roles`, without creating an index for that role. |
| P0-2 | The active operation catalog supplies descriptions for its existing eight query parameters and Chinese matching. Invalid `help` queries include a working catalog-search alternative. Existing operation IDs and response fields are preserved. |
| P0-3 | `rabi-knowledge-search` uses one decision table and defaults to all roles and sources. The real installed Skill reads back `in-sync`, preserving its user-level link. Neither the current workspace nor the other project root has a localized downstream copy, so verification uses the actual user-level installation. |
| P0-4 | Bound and unbound server-side `SessionStart` regressions pass for every declared Agent type. Local Codex configuration references the Rabi context plugin, the DSH web profile declares its dependency, and WorkBuddy configuration contains a Rabi Hook and one `SessionStart` group. The installed WorkBuddy script passes its self-check. New-session loading and injection still require evidence from each host. |
| P0-5 | Existing user authorization covers removal of mandatory CLI identity pairing, implicit Hook tool denials, fixed AgentPacket denials and specification requirements for default-minimal capabilities and Action Gate checks. Skills, prompts and both language specifications are aligned. Unified permission levels and scopes retain extension points. |
| P1-1, P1-3 | Public `GET /api/search` fans out to all roles and active catalog registrations for knowledge, messages, operations and entities through their original owners. It supports keyword search, browsing, optional role selection and combined filters. |
| P1-2 | Discovery and identity verification run once. The caller and source branches share one deadline through message queueing, execution and device reads. Identity changes trigger rediscovery. |
| P1-4 | Default selection reserves matching source candidates before filling and ordering the page. Small pages rotate sources across continuation. Cursors bind filters, source versions and Manager identity. Recent ordering uses actual times. |
| P1-5, P1-8 | Source registration derives from active operation contracts. Responses carry legends, facets, coverage and degradation. HTTP, OpenAPI, MCP, CLI and the WebGUI catalog client discover the operation, and generic invocation executes it. |
| P1-9 | Caller identity metadata is optional. Empty, partial and unregistered identities can query with appropriate warnings. Complete identity uses the existing headers. |
| P1-10, P1-11 | Original owners project evidence state, confirmation references, observation time, expiry, provenance and real invocation entries. Unknown values remain null. All 12 fixed scenarios pass. |

Connection authentication, explicit user-visible settings, HTTP input correctness and original execution contracts remain effective. This version always returns an empty `coverage.excluded`, with future permission settings extending the existing contract.

## Twelve usage scenarios

Fixtures use two synthetic roles, the original knowledge index, the real SQLite FTS5 message index, the active operation catalog and synthetic device data. Tests reside in `src/manager/unifiedSearch.test.ts`.

| Scenario | Assertion | Result |
| --- | --- | --- |
| 1 | With 1,000 messages, the first page still includes relevant knowledge, messages, operations and devices | Pass |
| 2 | `limit=1` rotates sources and traverses stable data without duplicates or omissions | Pass |
| 3 | Tentative speech retains unknown state, null confidence, false user confirmation, original text and references | Pass |
| 4 | Updating memory preserves its original observation time, while unknown observations remain null | Pass |
| 5 | Old device observations and current retrieval times are distinct, preserving owner-provided expiry and confirmation metadata | Pass |
| 6 | Two air conditioners retain separate resource IDs and real state and action-contract entries | Pass |
| 7 | Owner-reported conflicts retain candidates, original evidence and checking status | Pass |
| 8 | Zero keyword hits still disclose the full operation catalog and contract entry | Pass |
| 9 | Scope, kind, all-keyword and strict filters apply together, including Chinese sentences | Pass |
| 10 | Malformed items are isolated while healthy neighbors and returned counts remain accurate | Pass |
| 11 | Failed or timed-out sources preserve successful results, with 503 when every requested source fails | Pass |
| 12 | Source-version changes expire cursors with 409, and page facets match returned items | Pass |

These assertions verify that an Agent receives content meaning, evidence status and entries needed to continue calling. Device selection and execution use the original action contracts.

## Code and runtime review

The actual call chain was reviewed, corrected and retested.

- Cold knowledge loading preserves healthy records beside malformed files. Partial full reloads retain previously valid records. Legacy queries disclose partial coverage.
- Message pagination and deduplication run in the original SQLite owner. Keyword-free ordering is valid, and zero-hit responses still include window metadata.
- Explicit budgets reach original message queueing, execution and visibility flows. Device reads accept the same cancellation signal and deadline.
- Cursors validate safe integer positions. Source-version changes and role-directory changes fence stale results.
- Existing catalog operation IDs, parameters, summary fields and full contracts are preserved. OpenAPI required-property schema errors were corrected.
- Confirmed state and user confirmation require owner evidence. Retrieval time stays independent of observation time. Owner conflict reports, including empty reports, remain explicit.

### Checks

Test groups overlap and are reported separately.

| Check | Result |
| --- | --- |
| Unified search and related source regressions | 165 pass, covering the 12 scenarios, catalog, LAN admission, Hooks, AgentPacket, knowledge, message index and device sources |
| CLI, clients, MCP, dynamic Manager and query helper | 69 pass |
| Final knowledge routes, knowledge operations and message-budget regressions | 19 pass |
| Additional device metadata and all Agent-type SessionStart | 2 pass |
| `npm run test:hot-patches` | 89 pass |
| `npm run test:hot-patches:manager` | 1 pass, covering generic candidate application, receipt recovery, rollback and health |
| `npm run build` | Pass, producing backend and Web assets with plugin lifecycle notices and Vite large-chunk notices |
| Built isolated Manager search acceptance | 1 pass, approximately 17 seconds in the latest run |
| Frozen source verification | 29 production source hashes match final build inputs |
| Installed search Skill synchronization | `in-sync` |

Minimal entry points use the project test environment.

```powershell
node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/unifiedSearch.test.ts
node --test --test-name-pattern="built Manager unified search" scripts/api-contract-built-manager.test.mjs
```

Full logs, frozen inputs and runtime receipts reside in the local ignored `data/acceptance/` directory with the `agent-search-` prefix and `20261113` date. Recovery snapshots reside in the local task snapshot directory.

### Built runtime

The existing `startBuiltManager` helper starts an independent port, process and temporary data directory with test configuration. The test creates a synthetic role through the real API, reads the original knowledge index and calls unified search. Missing, partial and unknown caller identities succeed. Unknown roles return 404. Chinese operation queries return matches. OpenAPI contains `manager.search`, and returned contract URLs resolve. Shutdown follows the original test lifecycle.

| Field | Latest runtime evidence |
| --- | --- |
| Time | `2026-11-13T06:45:56.862Z` |
| requestId | `bbe4d342-9ab1-48d5-a7e7-24384a62c23a` |
| applicationGenerationId | `315ee010-2208-4ebb-9120-22e8114e95db` |
| managerInstanceId | `66368f9e-3cc5-4a46-b901-0978d4bc6eb5` |
| Registered sources | `entities / knowledge / messages / operations` |
| Results | 3 items, `coverage.state=partial` |
| Entity branch | `xiaomi_home_authorization_required`, with no test-device authorization |
| Message branch | `MESSAGE_HISTORY_INDEX_NOT_READY`, with a cold index in the new temporary instance |
| Web candidate hash | `4e4f0bc02b3c065e0ddbd919115e4a61f8ee7a7750245c0765175715afe0e32c` |

The real process exposes these gaps through original errors. Fixed scenarios use a ready original message index and synthetic devices to verify traversal, device evidence and handles separately.

## Delivery status and remaining acceptance

- Source, bilingual documentation, the installed search Skill, build assets and isolated runtime evidence are delivered. The latest read-only installed-instance probe at `2026-11-13T06:36:23.342Z` returned 404 for `GET /api/search`. Switching the running version awaits the publishing lifecycle.
- P0-4 has server-side binding tests and the installed WorkBuddy script self-check. Actual new-session Hook loading and bound-role knowledge injection require evidence from each external host. Current Antigravity configuration has no Rabi context plugin reference.
- The real device branch explicitly reports degradation under plan section 9.1. Physical-device action acceptance requires a connected environment.
- Real multi-endpoint message and archive completeness and P95 under eight-role real-data load remain unmeasured. P95 ≤ 50 ms remains a design target.
- Tests use synthetic data. Cleanup removed 27 task-owned temporary directories totaling 8,750,178 logical bytes, with zero original paths remaining. Physical space recovery was unmeasured. Recovery snapshots and runtime evidence are retained.
