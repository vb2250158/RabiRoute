<!-- docs-language-switch -->
<div align="center">
English | <a href="./current-capabilities.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Current Capabilities and Maturity

This document describes capabilities that actually exist in the RabiRoute `0.1.10` codebase. Requirements, design proposals, and external-device ideas are not presented as completed features. The conclusions come from the configuration schema, runtime entry points, Manager APIs, WebGUI, adapter implementations, and tests. On 2026-07-17, `npm test` passed all 197 tests in this repository.

## Maturity definitions

| Status | Meaning |
| --- | --- |
| `verified` | The repository contains a complete implementation, configuration/diagnostic entry points, and automated contract tests. External platforms may still require accounts, login, or real hardware. |
| `experimental` | The code path and configuration entry point exist, with partial tests or scan diagnostics, but end-to-end compatibility with the external system still requires environment-specific acceptance. |
| `stub` | Only a limited handoff exists, such as opening an app, copying a prompt, or writing a handoff file. It must not be advertised as reliable background delivery. |
| `planned` | Only a proposal or plan exists; the current code does not implement the loop. |
| `historical` | The document records a superseded route, research, or handoff and does not define the current primary path. |

These are the maturity values used by RabiRoute's own scan APIs; they are not production certifications from third-party platforms.

## Current core path

```text
Message Adapter / Manager Entry
  -> JSONL Event Store
  -> RouteDecision
  -> AgentPacket
  -> Agent Adapter
  -> Outbox / Reply
```

RabiRoute owns ingress, rule matching, context packaging, handler delivery, reply routing, and audit. Handlers own answers, execution, tool calls, and their private session state.

## Message inputs

| Input | Status | Actual boundary |
| --- | --- | --- |
| NapCat / OneBot | `verified` | Gateway child processes receive QQ group and private messages over WebSocket. The Manager can scan, add, launch, restart, remove, and repair multiple NapCat instances. OneBot HTTP provides status and outbound calls. Merged forwards are expanded into text and media evidence. |
| Heartbeat | `verified` | Gateway child processes create internal scheduled events. Rules support intervals, time windows, daily times, and one-off times, with an optional busy-thread skip for the fixed Codex thread. |
| Role panel | `verified` | A built-in local Manager/tray input rather than a standalone network listener. It uses the fixed `role_panel_message` rule and writes a role-scoped timeline. |
| Manual trigger | `verified` | Manager APIs and the log page can execute `manual_trigger` or heartbeat rules through the real delivery path. It is not a message adapter. |
| Remote Agent | `experimental` | The Manager acts as a v3 outbound controller that discovers and connects to remote bridges with a password challenge. Tasks, events, and bidirectional files are supported. The Gateway child process exposes placeholder status and does not open another listener. |
| FenneNote | `experimental` | A named webhook-like speech-transcript input. It can write only to the RabiLink ledger under record-first rules or route directly. Outbox can forward to FenneNote reply/playback endpoints. |
| XiaoAI | `experimental` | RabiRoute provides a named callback and a PC bridge directory, but open-xiaoai, xiaogpt, or another bridge must carry speaker events to the PC. The speaker does not connect directly to the core. |
| RabiLink | `experimental` | Includes a local compatibility endpoint, a global Relay Runtime, and a route worker. AIUI observations can be recorded first in one ledger; the reviewer processes them when Codex is idle, periodically, or on a touchpad wake. Proactive messages use an independent Relay downlink stream. External AIUI, phone, and wearable paths still require real-device acceptance. |
| Generic Webhook | `experimental` | Accepts POST events from sources without a dedicated adapter. Named platforms should use their own adapters to preserve logs and reply semantics. |
| WeCom | `experimental` | Uses the `@wecom/aibot-node-sdk` intelligent-bot WebSocket for group ingress and Outbox replies. Real Bot ID/Secret validation is required. |

`disabled` is a compatibility configuration value, not an input adapter.

## Routing and context

- One route can define several message adapters, per-adapter input/output policies, several Agent adapters, a pipeline, a working directory, and persona binding.
- Routing rules live in the persona's `personaConfig.json` and bind to a route by `configName`. Persona-free routes receive default rules, and the role-panel rule is always present.
- Current route kinds are `private`, `group_message`, `direct_at`, `direct_reply`, `indirect_reply`, `heartbeat`, `manual_trigger`, `role_panel_message`, `voice_transcript`, `rabilink`, and `wecom_message`.
- `RouteDecision` only matches rules. `forwarding.ts` iterates active route profiles, writes audit records, and delivers every matched rule.
- `AgentPacket` includes the event, recent messages, role and relative paths, plan/memory/skill indexes, required-read items, log paths, reply API, and `replyContext`. Skill bodies are not injected into every packet automatically.
- Delivery replay is implemented. Real delivery writes `delivery-replay-ledger.jsonl`, and attempts or stored messages can re-enter the delivery path.
- Persona-route dry runs and `AgentPacket` previews remain planned; the current WebGUI has no side-effect-free preview API.

## Handlers

| Handler | Status | Actual boundary |
| --- | --- | --- |
| Codex | `verified` | Real messages travel only through Desktop IPC to the Codex/ChatGPT Desktop task owner. A valid task ID plus workspace is a stable binding; Desktop renames, stale index titles, and completed goals do not create duplicates. RabiRoute may deeplink an unloaded task and retry, but it never starts a fallback execution Runtime. App-server is limited to empty-task metadata bootstrap. |
| Copilot CLI | `experimental` | Invokes the local Copilot CLI with a dedicated session name and cwd and records output/state. The scan API explicitly reports that repeated same-session end-to-end smoke testing is incomplete. |
| AstrBot | `experimental` | Supports Dashboard login checks, project/session scans, RabiRoute plugin deployment, and ChatUI-session delivery. The scan API explicitly reports that real repeated-send acceptance remains pending. |
| Marvis | `stub` | Writes a prompt, copies it to the clipboard, and opens or focuses Marvis. It cannot reliably list, create, or repeatedly inject into one session. |

Command, file, network, permission, and tool approval in the target Desktop task remains separate from RabiRoute's external-message Outbox policies.

## Outbox and replies

`POST /api/agent/replies` is implemented and returns `sent`, `draft`, `blocked`, or `failed`.

| Output | Current behavior |
| --- | --- |
| Local Agent session | The legacy default uses `outputAdapter=agent`. Without an explicit external target, the result remains in the Agent session and does not create a draft. |
| QQ / NapCat | Supports source replies and explicit group/private targets, with text/image/voice/file payloads. Local group files must pass `allowedFileRoots` and use `upload_group_file`. Real quoted-reply segments are supported. |
| WeCom | Supports source-group replies and explicit chat/group targets through the SDK, gated by adapter policy. |
| FenneNote | Forwards a reply or playback request according to the pipeline/request while preserving voice parameters. |
| RabiLink | Route policy gates reply or proactive text entering the continuous Relay stream. Proactive downlink does not require a fabricated source task. |
| Role panel | Appends directly to the role timeline and may include attachment descriptors. |

There is no generic persistent Action Queue with a WebGUI approval center today. `draft` is an Outbox result and audit state, not a completed unified approval product.

## Manager and WebGUI

- The Manager serves RibiWebGUI and HTTP APIs at `http://127.0.0.1:8790/` by default and owns route configuration, child-process lifecycle, scans, logs, and global settings.
- Current WebGUI areas are Console, Message Adapters, Rabi Persona, Log Diagnostics, and Project Documentation. Quick Setup selects inputs, handlers, and a persona.
- Console manages the Rabi instance name/GUID, global RabiLink Relay connection, route/role directories, and route lifecycle.
- Message Adapters includes NapCat multi-instance management, Remote Agent discovery/connection, external-adapter diagnostics, Agent scans, pipelines, and working-directory configuration.
- Persona manages persona content, route variables, rules, route kinds, regex, schedules, and templates. The proposed dry-run preview is not implemented.
- Log Diagnostics displays connection state, the Codex delivery channel, recent logs, manual triggers, and delivery replay.
- The top bar supports runtime switching between Simplified Chinese and English. Locale state has one owner and is stored in browser `localStorage` under `rabiroute:webgui:locale`, with `<html lang>` kept in sync. It is a UI preference and is not written to Route, role, or Manager configuration.
- English mode translates only registered interface copy and dynamic status text. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime data remain unchanged. The English Project Docs view loads the repository's `docs/**/*_en.md` files on demand instead of creating a third documentation source of truth.
- Manager also exposes Agent thread bridge, Role Knowledge, Remote Agent, multi-Rabi, NapCat management, and RabiLink remote-WebGUI proxy APIs.

## Role knowledge and runtime data

- Plans, recent memory, consolidated memory, consolidation runs, and skill indexes all have Manager APIs and file sources of truth.
- Building an AgentPacket takes a role-knowledge snapshot, and memory hits refresh `viewedAt`. Only an explicit `memory-consolidation` manual trigger or Manager API request creates a run; submitting its result marks the inputs and writes consolidated memory. There is no time-only resident background scheduler today.
- Runtime records are primarily JSONL: messages, adapter logs, AgentPacket, Outbox, heartbeat, manual trigger, role panel, RabiLink conversation, and delivery replay.
- Runtime `data/`, logs, tokens, real account IDs, real group IDs, and Cookies must not enter the repository.

## Capabilities that must not be advertised as complete

- A generic Action Queue / approval center and automatic retry queue.
- Side-effect-free WebGUI preview for persona routing, RouteDecision, and AgentPacket.
- Reliable background Marvis session injection.
- A production-complete loop for every RabiLink phone, glasses, watch, and Xiaomi Health route. The repository contains implementations, probes, acceptance material, and designs, but their maturity is not the same as the core router.
- Future APIs, UI, and hardware paths described only in design, research, or handoff documents.

## Sources of truth

- Configuration and types: `src/shared/gatewayConfigModel.ts`
- Gateway runtime: `src/index.ts`
- Manager APIs: `src/manager/controlPlaneRoutes.ts`
- Message-adapter maturity scans: `src/messageEndpoints/*`, `src/manager/controlPlaneRoutes.ts`
- Agent maturity scans: `src/agentAdapters/managerApi.ts`
- Routing and context: `src/forwarding.ts`, `src/routing/*`
- Replies: `src/outbox.ts`
- Codex Desktop owner: `src/codexDesktopBridge.ts`, `src/codexRuntime.ts`; empty-task metadata: `src/codexAppServerClient.ts`
- WebGUI: `ribiwebgui/src/pages/*`
- Automated contracts: `src/**/*.test.ts`
