<!-- docs-language-switch -->
<div align="center">
English | <a href="./current-capabilities.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Current Capabilities and Maturity

This document describes capabilities that actually exist in the current RabiRoute `0.1.x` working tree. Requirements, design proposals, and external-device ideas are not presented as completed features. The conclusions come from the configuration schema, runtime entry points, Manager APIs, WebGUI, adapter implementations, and current automated tests.

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
| RabiSpeech message endpoint | `experimental` | RabiSpeech owns one ASR/VAD pipeline and FIFO. Audio defaults to the host sound card, or an online LAN Rabi Voice Client can act as a remote microphone/speaker without segmenting or running models. Transcripts are still broadcast to all subscribed Routes, and a disconnected remote client never silently falls back to the host microphone. |
| FenneNote | `retired compatibility` | No longer offered by add-endpoint or new-rule UI; old Routes remain readable and keep historical webhook/Outbox migration compatibility. |
| XiaoAI | `experimental` | RabiRoute provides a named callback and a PC bridge directory, but open-xiaoai, xiaogpt, or another bridge must carry speaker events to the PC. The speaker does not connect directly to the core. |
| RabiLink | `experimental` | Includes a local compatibility endpoint, a global Relay Runtime, and a route worker. AIUI observations can be recorded first in one ledger; the reviewer processes them when Codex is idle, periodically, or on a touchpad wake. Proactive messages use an independent Relay downlink stream. External AIUI, phone, and wearable paths still require real-device acceptance. |
| Wearable health endpoint | `experimental` | Structured `wearable.health` observations enter a daily role-scoped timeline. Manager exposes state/history/summary queries, and threshold/cooldown matches become `wearable_health_alert` Agent deliveries. Android selects Health Connect or a PC ADB Companion; the latter is now mobile-configured and real-device verified for heart rate, sleep session/stages, sleep state, deduplication, queries, and a logon-resident task. ADB-free MiWear SPP is not the default collector. |
| Generic Webhook | `experimental` | Accepts POST events from sources without a dedicated adapter. Named platforms should use their own adapters to preserve logs and reply semantics. |
| WeCom | `experimental` | Uses the `@wecom/aibot-node-sdk` intelligent-bot WebSocket for group ingress and Outbox replies. Real Bot ID/Secret validation is required. |

`disabled` is a compatibility configuration value, not an input adapter.

## Routing and context

- One route can define several message adapters, per-adapter input/output policies, several Agent adapters, a pipeline, a working directory, and persona binding.
- Routing rules live at the root of persona `personaConfig.json`. Several Routes bound to the same persona reuse its rules, speech keywords, and context budgets. Persona-free routes receive default rules, and the role-panel rule is always present.
- Current route kinds are `private`, `group_message`, `direct_at`, `direct_reply`, `indirect_reply`, `heartbeat`, `manual_trigger`, `role_panel_message`, `voice_transcript`, `rabilink`, `wearable_health_alert`, and `wecom_message`.
- `RouteDecision` only matches rules. `forwarding.ts` iterates active route profiles, writes audit records, and delivers every matched rule.
- `AgentPacket` includes the event, recent bidirectional messages for the current persona/logical endpoint/conversation, role and relative paths, plan/memory/skill indexes, required-read items, log paths, reply API, and `replyContext`.
- Persona `recentMessageLimits` configures 11 endpoint budgets from `0` to `200`, with a schema default of `100`; zero disables only injection. `conversation/current.jsonl` has no entry-count cap, time-based archives use `archive/<n>~<m>.jsonl`, and automatic context never reads archives.
- Matched ordinary messages go directly to the Desktop owner through `steer/start`. Heartbeat may separately skip while busy, and speech may separately use hot/keyword delivery.
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
| FenneNote | Retired; reply/playback forwarding remains only for legacy Routes, not as a new output design. |
| RabiLink | Route policy gates reply or proactive text entering the continuous Relay stream. Proactive downlink does not require a fabricated source task. |
| Role panel | Appends directly to the role timeline and may include attachment descriptors. |

There is no generic persistent Action Queue with a WebGUI approval center today. `draft` is an Outbox result and audit state, not a completed unified approval product.

## Manager and WebGUI

- The Manager serves RibiWebGUI and HTTP APIs at `http://127.0.0.1:8790/` by default and owns route configuration, child-process lifecycle, scans, logs, and global settings.
- Current WebGUI areas are Console, Message Adapters, Rabi Persona, Log Diagnostics, and User Guide. Quick Setup selects inputs, handlers, and a persona.
- Console manages the Rabi instance name/GUID, global RabiLink Relay connection, route/role directories, and route lifecycle.
- Message Adapters includes NapCat multi-instance management, Remote Agent discovery/connection, external-adapter diagnostics, Agent scans, pipelines, and working-directory configuration.
- Persona manages persona content, route variables, rules, route kinds, regex, schedules, and templates. The proposed dry-run preview is not implemented.
- Log Diagnostics displays connection state, the Codex delivery channel, recent logs, and manual triggers. Delivery replay has a Manager API and ledger, but the current page has no replay control.
- The top bar supports runtime switching between Simplified Chinese and English. Locale state has one owner and is stored in browser `localStorage` under `rabiroute:webgui:locale`, with `<html lang>` kept in sync. It is a UI preference and is not written to Route, role, or Manager configuration.
- English mode translates only registered interface copy and dynamic status text. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime data remain unchanged. User Guide renders the manually maintained Chinese and English Markdown under `docs/user-guide/` instead of creating a third page-content source.
- Manager also exposes Agent thread bridge, Role Knowledge, Remote Agent, multi-Rabi, NapCat management, and RabiLink remote-WebGUI proxy APIs.

## Role knowledge and runtime data

- Plans, recent memory, consolidated memory, consolidation runs, and skill indexes all have Manager APIs and file sources of truth.
- AgentPacket `message_delivery` and Codex session, prompt, PreToolUse, and PostToolUse events all enter `RabiContextManager`; it is the only production role-knowledge snapshot call site. Entry events use full context, while reasoning hooks inject only newly matched deltas for the turn.
- Memory hits refresh `viewedAt` through one policy; the same item revision is not refreshed twice in one turn. Only an explicit `memory-consolidation` manual trigger or Manager API request creates a run; submitting its result marks the inputs and writes consolidated memory. There is no time-only resident background scheduler today.
- The Codex plugin only forwards lifecycle events and injects Manager output. It owns no binding, trigger policy, or knowledge copy. The internal `preview` policy is side-effect-free, but no WebGUI preview surface exists yet.
- Runtime records are primarily JSONL: messages, adapter logs, AgentPacket, Outbox, heartbeat, manual trigger, role panel, RabiLink conversation, role-scoped wearable health timelines, and delivery replay.
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
