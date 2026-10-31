<!-- docs-language-switch -->
<div align="center">English | <a href="./agent-thread-api-contracts.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Agent session control API contracts

This page is for Manager, plugin and Agent integration developers. `agentThreadControlOperations.ts` installs routes and publishes discovery from the same executable definitions. The functional owner in `agentThreadControlRoutes.ts` retains native orchestration. Original adapters/drivers still discover, read, create metadata, rename and execute messages; this migration adds no execution Runtime.

## Actual entry points and actions

| Current operation ID | HTTP entry point | Behavior |
| --- | --- | --- |
| `manager.agent.threads.list` | `GET /api/agent/threads` | Original default adapter's `list`, accepting `query`, `limit` and `offset` |
| `manager.agent.threads.action` | `POST /api/agent/threads` | JSON `action` selects an existing native operation |

The original directory IDs `agent:GET:/api/agent/threads` and `agent:POST:/api/agent/threads` resolve as aliases without installing duplicate handlers. Responses retain their original top-level `code`, `action`, `threads/thread`, `communication`, `delivery` and error fields, without an extra `{data: ...}` envelope.

| POST action | Actual owner | Meaning |
| --- | --- | --- |
| `list` / `read` | Original adapter discovery/exact read | Full IDs, visible names and native session content; no creation |
| `open` | Original host's session-opening function | Retains actual host support; does not prove prompt execution |
| `resolve` / `create` | Original resolver and durable creation reservation | Existing name/ID/workspace, archive and idempotency rules |
| `rename` | Original owner's metadata API | Changes the display name without replacing full task identity |
| `send` | Original owner, endpoint delivery and ledger | Distinguishes `delivered`, `delivery_unconfirmed` and tracking failures |
| `reconcile_delivery` | Original delivery reservation and receipt recovery | Reconciles the original delivery without sending again |

Each adapter retains its actual protocol support. This owner has no `delete` or `cancel` action; discovery does not invent business capabilities. Real Codex messages still enter only the Desktop task owner. Metadata bootstrap never executes a real prompt, and absent Desktop never creates a fallback Runtime. Model, tools, approvals and host lifecycle keep their original ownership; see the [Desktop contract](./codex-desktop-agent-acceptance_en.md).

## Preparation, provenance and execution

Preparation captures the original trusted connector/device before body parsing, then rechecks the admitted lease, source node/connector/provider and device identity. Context, personas, Routes, Skills and saved sessions do not grant individual features. An authenticated empty node can list and manage sessions; sends still require provable original source identity.

A remote Agent may explicitly attribute an unsaved `sourceThreadId` and display its canonical `messageSource.sessionName`. Node and connector identity always come from authenticated ingress. Body fields named `remoteSource`, `trustedDeviceSource` or `callerExecutionOptions` cannot create provenance or replace the internal snapshot. An application connection cannot stand in for a real Desktop Agent or device source.

Caller-selected `cwd/model/reasoningEffort/sandbox/dshDeliveryMode` form a frozen snapshot before Route defaults apply. Execution still calls the same native `handleAgentThreadRequest` and options. Contracts do not implement another resolver, model selector, tool system or delivery engine.

## Parameters, receipts and lifetime

GET retains the first value from `URLSearchParams.get`. Native listing defaults to 100, caps at 200, floors finite values and clamps their range; invalid limits use the default and invalid/negative offsets become zero. Follow `nextOffset` for later pages instead of treating the first 100/200 sessions as the complete inventory. Original drivers validate adapter-specific full IDs and workspaces.

POST describes the public DTO structure while the original driver/ledger retains semantic checks for actions, path roots, sources, prompt/images, models, creation reservations and idempotency. Native null/default/coercion and extension-field behavior remains; an empty JSON body defaults to `{}` with no added application byte cap. Unknown actions fail without switching hosts.

Handoffs still update the same `AgentRequestStore` and message-processing board before publishing original events and refreshing reminders. An accepted answer with failed return tracking retains `delivered_tracking_failed` and its warning; this does not authorize resending. Provenance is rechecked after native completion. If a mutating call has returned but its source becomes invalid, retain an uncertain result and the original delivery ID for reconciliation.

Unloading stops new admission and joins accepted body/native-driver work through actual completion. HTTP close or cancellation does not mean the native owner has stopped. Retirement waits for cleanup; cancellation fences later work and tracking without pretending an executing driver already finished.

## Verification boundary

Isolated tests cover successful authenticated empty-node calls, 205-session pagination, complete names/IDs, forged and explicitly unsaved sources, device revocation, caller snapshots, source/generation replacement, actual drain after disconnect and original-ledger reconciliation from both language documentation examples. Controlled drivers and temporary stores send no tasks to real Desktop, devices or other users and do not raise host maturity. Full builds, installed-runtime and physical two-computer acceptance remain gates of the [overall architecture](./api-contract-discovery-target-architecture_en.md).
