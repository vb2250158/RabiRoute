<!-- docs-language-switch -->
<div align="center">
English | <a href="./project-function-map.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Project Function Map

> Status: current fact map. Modules and maturity are checked against the code; external-system acceptance still follows [Current Capabilities](current-capabilities_en.md).

Use this page to locate the owner of a behavior before editing code. RabiRoute is the triage/dispatch layer: endpoints bring messages in, routing chooses what should happen, handlers do the work, and Outbox controls how results return.

RibiWebGUI `/#/docs` is now the task-based User Guide backed by `docs/user-guide/`. This developer fact map remains available through deeper-reading links and the repository documentation index.

## Layer map

| Layer | Owns | Must not own | Main code |
| --- | --- | --- | --- |
| Message adapter | Protocol parsing, normalization, adapter logs, health | Handler prompt or direct policy bypass | `src/adapters/*` |
| Event/history stores | Protocol/audit JSONL plus the persona-scoped bidirectional conversation ledger | Route or business decisions, or using archives as automatic context | `src/history.ts`, `src/messageContextStore.ts` |
| RouteDecision | Match rules inside one route profile | Role selection, memory reads, handler delivery | `src/routing/routeDecision.ts` |
| AgentPacket | Generated handler context and reply instructions | Route matching or platform send | `src/routing/agentPacket.ts` |
| Handler adapter | Deliver packet to Codex/other handler | Platform route semantics or external output policy | `src/agentAdapters/*`, runtime modules |
| Outbox | Resolve reply target, policy, payload, and sender | Handler reasoning | `src/outbox.ts` |
| Manager | Configuration, processes, scans, APIs, shared services | Platform-specific live parsing | `src/manager.ts`, `src/manager/*` |
| Role knowledge | Plans, memories, skills, recall, validation | Decide whether an event matches a route | `src/roleKnowledge.ts` |

## Current function index

| Function | Maturity | Source / trigger | Side effects | API / UI | Main code |
| --- | --- | --- | --- | --- | --- |
| NapCat inbound/outbound | verified | OneBot WS/HTTP | message logs and external QQ sends | route config and message scan | `src/adapters/napcatAdapter.ts`, `src/napcat.ts`, `src/outbox.ts` |
| Heartbeat | verified | interval | heartbeat log and possible handler turn | route message-adapter config | heartbeat adapter/forwarding |
| Manual trigger | verified | Manager/WebGUI action | manual-trigger log and handler turn | Manager control plane | `src/manualTrigger.ts`, `src/manager/controlPlaneRoutes.ts` |
| Role panel | verified | Qt/Manager local message | role timeline and handler turn/reply | Manager/Qt | role-panel modules and Outbox |
| Windows tray | current | packaged Qt frontend and the same Manager HTTP backend as RibiWebGUI | starts/connects/exits Manager and asynchronously renders Manager DTOs; never reads runtime `data/` directly | `/gateways?summary=1`, `/api/roles/:roleId/*`, tray executable | `desktop/tray-task-window/`, `scripts/build-tray-exe.ps1` |
| Remote Agent | experimental | discovered bridge and explicit task | connection/task/event/file runtime data | `/api/remote-agent/*` | `src/messageEndpoints/remoteAgentManager.ts` |
| Generic webhook | experimental | HTTP POST | adapter/event logs and handler turn | configured port/path | webhook adapter/scans |
| FenneNote compatibility | retired/hidden | legacy transcript webhook and output bridge | compatibility logs only when an old route still references it | no longer offered by the add-adapter UI | webhook-like adapter, Outbox |
| WeCom | experimental | smart-bot WebSocket | message/status logs and group send | scan and route config | `src/adapters/wecomAdapter.ts`, `src/wecom.ts`, `src/messageEndpoints/wecomManager.ts` |
| Glasses endpoint through RabiLink | experimental; legacy internal key `rabilink` | glasses observations and downlink | conversation ledger, compatibility logs, device output | route message-adapter entry | RabiLink adapter/worker/Outbox |
| Wearable health endpoint | experimental; internal key `wearable` | structured Relay observations from Health Connect or a trusted ADB bridge | role-scoped health timeline, Manager queries, `wearable_health_alert` | route message-adapter entry and `/api/roles/:roleId/health/*` | `src/adapters/wearableAdapter.ts`, `src/wearableHealth.ts`, `src/manager/wearableHealthRoute.ts` |
| RabiLink system transport | experimental; internal contracts tested | global Relay configuration, remote WebGUI, speech, and observation queues | Manager registration and transport queues; does not select a Route or own an Agent | Rabi instance on Console | `src/manager/rabiLinkRelayRuntime.ts`, Relay scripts |
| RabiSpeech TTS / ASR | experimental | machine-local registry, environment-variable API secrets, persona `voice/voice-profile.json` as the TTS model/voice/language/style truth source, persona `voice/cache/tts-audio/` for finalized audio, host `output/playback-settings.json`, and private fallback/model caches and workers; the host owns microphone, ASR/VAD, and segmentation while Routes own only speech subscription, delivery policy, and reply playback | persona-selected TTS; host-wide microphone/ASR/VAD and `0–100` playback controls; one resident transcription broadcast to every subscribed Route, each applying its own hot/persona-keyword policy; embedded persistent bidirectional records with safe cache references and expected expiry; unknown/known speaker cards with latest-ten-utterance previews and human or Agent labeling; meeting speaker turns, 24-hour bounded TTS audio cache, and global SoundFile/PortAudio FIFO playback; no separate meeting-record card | `/#/speech`, `/v1/models`, `/v1/records`, `/v1/speaker-identities`, `/v1/microphone/settings`, `/v1/playback/settings`, direct APIs, static report | `plugin-adapters/rabi-speech/`, `src/manager/speechServiceStatus.ts` |
| Rabi LAN Voice Client | experimental | private RabiSpeech `remote_audio` settings, dedicated stream token, and current audio-stream selection | meeting-room PC acts only as a remote microphone/speaker; its standalone GUI manages host connection, device selection, live level, and capture/playback state while host VAD, segmentation, ASR, TTS, FIFO, and Route broadcast stay unchanged | client GUI or `--headless`; Speech Service **Audio stream type** selector | `plugin-adapters/rabi-speech/rabispeech/remote_audio.py`, `desktop/rabi-voice-client/` |
| Speech push policy | current | Route `speechPushMode`; persona `speechTriggerKeywords` | `hot` delivers every completed ASR segment immediately; `keyword` records every segment but wakes the Agent only on a persona-name/wake-keyword match; an empty list never falls back to hot | Route Hot delivery switch; persona keyword editor | `src/routing/speechPushPolicy.ts`, `src/index.ts` |
| Per-endpoint recent context | current | persona `recentMessageLimits` for 11 logical endpoints | `0–200`, default `100`; `0` disables auto-injection only. Inbound and outbound records share the budget within the current persona, logical endpoint, and conversation | persona sliders plus exact numeric inputs | shared config model and AgentPacket |
| Persona avatar | current | `personaConfig.json.avatar` referencing a PNG/JPEG/WebP/GIF inside the persona directory | Manager writes a content-addressed image and atomically switches the config; both WebGUI and Qt consume the constrained Manager API, and Qt does not read persona files directly | persona page, Quick Setup, Route overview, speech page, Qt role panel | `src/personaAvatar.ts`, `src/manager/personaAvatarRoutes.ts`, `ribiwebgui/src/components/PersonaAvatar.vue` |
| Persona conversation ledger | current | `data/roles/<RoleId>/conversation/current.jsonl` plus `archive/<n>~<m>.jsonl` and `index.json` | no entry-count cap on current; an archive check triggered by data older than 72 hours moves the complete contiguous prefix older than 24 hours; automatic context never reads archives | injected paths in AgentPacket | `src/messageContextStore.ts` |
| Codex handler | verified | AgentPacket | matched ordinary messages try `steer` on the active turn and otherwise `start`; Heartbeat may separately skip while busy, and speech may separately use keyword wake policy | route handler config | `src/codexRuntime.ts`, `src/codexDesktopBridge.ts` |
| Rabi Codex Context plugin | 0.3 unified-trigger version | real Codex session ID, explicit RoleId binding, and Manager-owned role configuration | full entry context plus deduplicated Pre/Post reasoning deltas through the same manager used by message delivery | strict `[rabi:use <RoleId>]` controls or exact-session proactive binding | `src/context/rabiContextManager.ts`, `plugins/rabi-codex-context/`, `docs/rabi-codex-context-plugin_en.md` |
| Copilot CLI | experimental | AgentPacket | local CLI process/output state | handler scan/config | `src/copilotCli.ts` |
| AstrBot | experimental | AgentPacket | Dashboard/ChatUI API calls | handler scan/config | `src/agentAdapters/astrbotAdapter.ts`, `src/agentAdapters/managerApi.ts` |
| Marvis | stub/manual | AgentPacket | prompt file, clipboard, app focus | handler config | `src/marvis.ts` |
| Agent thread bridge | current | `/api/agent/threads` | list/read/create/send formal Codex threads | local Manager API | `src/agentThreads.ts`, `src/manager/controlPlaneRoutes.ts` |
| Plan API | current | handler/Manager call | plan files and timestamps | `/api/roles/:roleId/plans` | `src/roleKnowledge.ts`, role route parser/control plane |
| Recent memory | current | handler/Manager call or recall hit | files, `updatedAt`, `viewedAt` | `/api/roles/:roleId/memory/recent` | `src/roleKnowledge.ts` |
| Consolidated memory | current | consolidation result/read/recall | stable files and `viewedAt` | `/api/roles/:roleId/memory/consolidated` | `src/roleKnowledge.ts` |
| Memory consolidation | current explicit flow | manual `memory-consolidation` trigger or API request | create run; result marks inputs and writes output | `/api/roles/:roleId/memory/consolidation-*` | `src/roleKnowledge.ts`, Manager role API |
| Role skills | current | Markdown metadata and item reads | skill index/required-read context | `/api/roles/:roleId/skills` | `src/roleKnowledge.ts` |
| WebGUI locale and User Guide | current | browser `rabiroute:webgui:locale`, reviewed UI catalog, `docs/user-guide/*.md` | changes interface copy and `<html lang>` only | top-bar `中 / EN`, `/#/docs` | `ribiwebgui/src/i18n/*`, `LocaleSwitcher.vue`, `ProjectDocsPage.vue` |
| Route/packet preview | planned | future side-effect-free simulation | must not write logs, deliver, or refresh memory | future persona workbench | design document only |

## Boundary rules

- `adapterConfig.json` owns route runtime settings; `personaConfig.json` owns the optional avatar reference, role notification rules, speech keywords, and recent-message limits.
- Matched ordinary endpoint messages are delivered immediately: `steer` while a turn is active, otherwise `start`. Only explicit endpoint policy creates an exception, such as Heartbeat's busy-skip switch or speech keyword wake-up.
- `speechPushMode=hot` delivers every completed ASR segment. `keyword` still records every segment and delivers only when `speechTriggerKeywords` matches; an empty keyword list stays record-only.
- `recentMessageLimits` is persona-owned and independently configures 11 logical endpoints. A zero value never disables recording.
- `agentRoleId` binds one route to one reusable role. A rule does not choose another role.
- RabiLink is a Manager-owned system transport. The glasses entry is an endpoint using that transport; RabiSpeech uses the same transport without entering message routing or an Agent.
- Codex adapter ID stays `codex`; Codex/ChatGPT Desktop is the required task owner.
- Desktop IPC is the only real-message Codex transport. App-server is limited to empty-task metadata bootstrap.
- A valid saved task ID plus workspace is stable; Desktop renames, stale index titles, and completed goals do not create duplicates.
- Outbox is the only normal external-reply path.
- `sent`, `draft`, `blocked`, and `failed` are results, not a persistent approval queue.
- Packet construction may refresh memory `viewedAt`; explicit memory consolidation can create a run. A future preview must avoid these side effects.
- WebGUI locale is only a browser UI preference. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values are not translated; User Guide selects the matching file under `docs/user-guide/`.

## Runtime data

Common route files:

```text
group-messages.jsonl
private-messages.jsonl
wecom-messages.jsonl
voice-transcripts.jsonl
heartbeat-events.jsonl
manual-trigger-events.jsonl
agent-packets.jsonl
outbox-adapter.log.jsonl
gateway-status.json
```

Role data:

```text
data/roles/<RoleId>/plans/
data/roles/<RoleId>/memory/
data/roles/<RoleId>/skills/
data/roles/<RoleId>/role-panel/
data/roles/<RoleId>/voice/voice-profile.json
data/roles/<RoleId>/voice/cache/tts-audio/
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

The conversation ledger is the automatic recent-context source. It is scoped by persona, logical endpoint, and conversation; inbound and outbound records count together. `current.jsonl` has no entry-count cap, while archives remain explicit-query evidence and are never read automatically. Persona TTS output under `voice/cache/tts-audio/` is a rebuildable 24-hour per-file cache; public read models expose only safe relative references and expected expiry, never host absolute paths. These are runtime/private sources of truth and are not public examples.

## Change-entry map

| Goal | Files to inspect first | Key constraint |
| --- | --- | --- |
| New message platform | `src/adapters/`, shared config model, endpoint scan/manager, Outbox if bidirectional | Normalize into common events; do not grow NapCat. |
| Change matching | `src/routing/routeDecision.ts` | Keep it deterministic and side-effect-free. |
| Change handler prompt | `src/routing/agentPacket.ts`, `src/roleKnowledge.ts` | Preserve thin user templates and reply context. |
| Change Codex delivery | `src/codexRuntime.ts`, `src/codexDesktopBridge.ts`; `src/codexAppServerClient.ts` only for empty-task metadata | Desktop IPC only for real messages; no shared port, per-route stdio, CLI, app-server execution fallback, or model override. |
| Change external send | `src/outbox.ts` and platform sender | Preserve policy, explicit targets, and audit statuses. |
| Change role knowledge | `src/roleKnowledge.ts`, Manager role API | Account for validation, timestamps, and consolidation side effects. |
| Change WebGUI config | Vue page/store plus shared schema | Update both language guides and examples when behavior changes. |

## New-feature checklist

1. Which layer owns the behavior?
2. What is the normalized input and source of truth?
3. What side effects occur?
4. Is maturity verified, experimental, stub, planned, or historical?
5. Which policy gates external actions?
6. Which logs and status fields make failure diagnosable?
7. Which bilingual public guides/examples must change?
8. Could preview or scan accidentally trigger live work or touch role memory?
