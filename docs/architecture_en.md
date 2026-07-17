<!-- docs-language-switch -->
<div align="center">
English | <a href="./architecture.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Architecture

> Status: current architecture guide. Calibrated against the Codex Desktop owner, message-endpoint maturity, and the actual Outbox boundary.

RabiRoute is an open-source message gateway and Policy Router. It normalizes incoming events, records them, evaluates routing policy, builds handler context, delivers work to a handler, and controls how results may return.

It is not a complete Agent OS, a chatbot framework replacement, a workflow engine, or the shell around one handler product.

## One-sentence model

```text
Message endpoints
  -> normalized event records
  -> RouteDecision
  -> AgentPacket/context
  -> handler adapter
  -> Outbox / Action Gate / reply route
```

A persistent generic Action Queue and WebGUI approval center are planned capabilities, not part of the current flow.

## What RabiRoute owns

- Inbound protocol boundaries and endpoint health.
- Append-only event and delivery records.
- Route matching and policy decisions.
- Stable context/prompt wrapping.
- Handler selection and thread/session delivery.
- Reply routing and adapter output policy.
- Local control-plane APIs and WebGUI.

Handlers own the actual answer, code change, workflow, system query, or tool execution.

## Codex five-layer boundary

| Layer | Current meaning |
| --- | --- |
| Provider | OpenAI services and model capabilities. |
| Agent/runtime | Desktop-managed Codex tasks, turns, tools, and execution. |
| Transport | Codex Desktop IPC. |
| Host/owner | Codex/ChatGPT Desktop, which owns the visible task and actual turn. |
| Model | The model selected by the target Desktop task. |

Codex/ChatGPT Desktop is both the visible host and the required task owner. RabiRoute delivers only through Desktop IPC and does not start a second execution Runtime or fallback.

## Layers

### 1. Platform/message adapter

Protocol-specific code converts a NapCat, WeCom, webhook, RabiSpeech, XiaoAI, RabiLink, role-panel, heartbeat, or Remote Agent input into the common event vocabulary. FenneNote parsing remains legacy-only.

Verified inputs: NapCat/OneBot, heartbeat, role panel, and manual trigger. Other external endpoints are experimental until their real environment has passed acceptance.

New platforms belong under `src/adapters/` or a dedicated Manager-level endpoint module. Do not grow the NapCat adapter into a universal integration file.

### 2. Event store

RabiRoute uses JSONL runtime records for inbound messages, adapter diagnostics, packets, Outbox results, heartbeat/manual events, role-panel messages, RabiLink conversation, and replay attempts.

These files support audit and troubleshooting. They are runtime/private data and are not committed.

### 3. Router / policy engine

`RouteDecision` evaluates route kind, target constraints, regex, route profile, and supplemental values. It should remain deterministic and side-effect-free.

Role knowledge does not decide whether a route matches. It is attached after a rule match when the `AgentPacket` is built.

### 4. Prompt / context template

The packet wrapper injects event fields, recent messages, role-relative paths, plan/memory/skill indexes, required reads, logs, reply context, and delivery instructions. The user rule template is a small supplement.

### 5. Handler registry

- Codex: verified.
- Copilot CLI and AstrBot: experimental.
- Marvis: manual handoff/stub.

Handler adapters receive packets. They do not own platform routing semantics or external-output policy.

### 6. Session / turn control

Codex delivery prefers a valid saved task ID in the same workspace. Desktop renames, stale SQLite titles, and completed goals do not create duplicates. Only an explicitly cleared or missing ID falls back to name-plus-cwd lookup or idempotent empty-task creation. Desktop owns turn start/steer, model, tools, sandbox, and approvals.

The local `/api/agent/threads` bridge exposes controlled list/read/resolve/create/send operations for background handlers that lack Desktop task tools. App-server is used only for empty-task metadata bootstrap; real prompts still go to the Desktop owner.

### 7. Outbox / Action Gate

`src/outbox.ts` resolves source/explicit targets, pipeline, adapter policy, payload support, and endpoint configuration. Results are:

```text
sent | draft | blocked | failed
```

Supported current outputs include NapCat, WeCom, RabiLink, and role panel. FenneNote remains only for old Route compatibility. Legacy/default `outputAdapter=agent` retains a response in the Agent session when no external target is requested.

There is no generic persistent approval queue or automatic retry queue. A future Action Queue should extend this policy/audit layer rather than reimplement platform sending.

## Current runtime topology

```text
RibiWebGUI / Qt panel / CLI
          |
          v
Manager on 127.0.0.1:8790
  |-- configuration and scan APIs
  |-- gateway subprocess lifecycle
  |-- role knowledge and Agent reply APIs
  |-- Remote Agent and role-panel endpoints
  |-- Codex Desktop IPC bridge
  |
  +--> gateway subprocesses
        |-- message adapters
        |-- history
        |-- forwarding / RouteDecision / AgentPacket
        +-- handler adapters and status reports

Codex/ChatGPT Desktop task owner
  ^ real messages arrive through Desktop IPC
```

RabiLink adds a public Relay and PC worker without exposing the local Manager directly. The phone/eyewear path is an endpoint around the same routing core, not a second Agent owner.

## Relationship to an Agent OS or workbench

An Agent OS would own autonomous planning, broad tool execution, long-term memory policy, skills, cron, and self-directed action. RabiRoute deliberately stops at routing, context, delivery, and controlled return paths.

A workbench or execution bridge may be one downstream handler. It should receive a packet through the handler interface rather than define RabiRoute's platform or policy boundaries.

## Evolution order

1. Keep current endpoint and handler maturity visible and testable.
2. Add a persistent Action Queue/approval state machine on top of Outbox results.
3. Complete real end-to-end acceptance for experimental adapters.
4. Add side-effect-free route/packet preview without calling live forwarding or touching memory timestamps.
5. Deepen replay and observability using recorded decisions rather than reconstructing them from prompts.

## Architecture red lines

- Do not make RabiRoute a full Agent OS.
- Do not let a handler adapter redefine route semantics.
- Do not bypass Outbox for user-facing external sends.
- Keep Desktop IPC as the only real-message Codex transport.
- Do not add shared-port, per-route stdio, CLI, or app-server execution fallbacks.
- Do not commit credentials or runtime `data/`.
- Do not describe planned approval/retry features as already implemented.
