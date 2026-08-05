<!-- docs-language-switch -->
<div align="center">
English | <a href="./configuration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Configuration and Integrations

> Status: current reference. Fields and maturity are based on the active configuration model, Manager APIs, and scan results. See [Current Capabilities](current-capabilities_en.md) for acceptance status.

## Codex terminology

RabiRoute keeps provider, agent/runtime, transport, host, and model separate:

| Concept | Current meaning |
| --- | --- |
| Provider | OpenAI account, service, and model capabilities. |
| Agent/runtime | Desktop-managed Codex tasks, turns, tools, and execution. Stable adapter ID: `codex`. |
| Transport | Codex Desktop IPC. |
| Host/owner | Codex/ChatGPT Desktop, which owns the visible task and actual turn. |
| Model | The model selected by the target Desktop task. |

Do not rename the adapter to `chatgpt`. Desktop IPC is the formal transport. A short-lived app-server may list user-visible task metadata and bootstrap an empty named task, but it must not execute routed prompts.

## Runtime files

```text
data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
```

`adapterConfig.json` owns endpoints, ports, handler selection, cwd, pipeline, role binding, and Route-local delivery policy. `personaConfig.json` owns notification rules, speech-trigger keywords, and per-endpoint recent-context budgets. A role can be reused by several routes.

`rolePanel` is a compatibility name for Manager's built-in message path, not a configurable Gateway listener. Local role-panel input and authenticated cross-persona delivery share the fixed `role_panel_message` rule and one delivery service. Success is recorded only after handler acceptance; a failed entry records an attempt.

On a clean start, the Manager copies the public `examples/data` package when available. Only the main example is enabled. Missing examples are not a runtime failure; the Manager can create a minimal NapCat-to-Codex setup.

## Representative route

```json
{
  "enabled": true,
  "messageAdapters": ["napcat", "heartbeat"],
  "messageAdapterPolicies": {
    "napcat": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"],
      "allowedFileRoots": ["C:/Path/To/Your/Project/ReleasePkg"],
      "messageGrouping": {
        "settleSeconds": 6,
        "incompleteSettleSeconds": 12,
        "maxWaitSeconds": 20
      }
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ message listener",
  "codexCwd": "C:/Path/To/Your/Project",
  "codexPlanAssistantSessions": [],
  "codexHooks": {
    "sessionContextEnabled": true,
    "reasoningContextEnabled": true,
    "planTaskCompletionEnabled": true
  },
  "agentModel": "",
  "agentAdapters": ["codex"],
  "primaryAgentAdapter": "codex",
  "messageProcessingAgents": {
    "codex": {
      "enabled": true,
      "model": "gpt-5.6-luna",
      "reasoningEffort": "medium"
    }
  },
  "heartbeatSkipWhenAgentBusy": true,
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

## Core fields

- `messageAdapters`: configurable input types. Current IDs include `napcat`, `remoteAgent`, `heartbeat`, `speech`, `webhook`, `fennenote`, `xiaoai`, `rabilink`, `wearable`, `wecom`, and `weixin`. Legacy `rolePanel` entries remain compatible, but WebGUI no longer presents them as configurable because Manager provides role-panel messaging by default.
- `messageAdapterPolicies`: `inputEnabled`, `outputEnabled`, `supportedOutputs`, and adapter-specific restrictions. QQ, Weixin, Feishu, WeCom, role-panel, and RabiLink text chats use message groups automatically without an off switch. `messageGrouping` exposes only ordinary settle, unfinished-fragment settle, and maximum wait values, defaulting to `6 / 12 / 20` seconds. ASR/voice transcripts, heartbeat, commands, approvals, health alerts, and structured events continue direct delivery without this wait. Chat dispatch changes only when Codex Message Agent mode is also enabled; otherwise delivery remains per-message. Legacy allow-group/user and output-mode fields are no longer active fine-grained filters.
- `supportedOutputs`: outbound payload kinds. NapCat supports `text`, `image`, `voice`, and `file` in the current policy model.
- `allowedFileRoots`: real-path allowlist for local file output. A local QQ group-file upload is blocked when this is empty or the resolved file leaves the allowlist.
- `gatewayPort`: NapCat WebSocket Client target port.
- `napcatHttpUrl`: OneBot HTTP endpoint called by RabiRoute. Multiple Routes may explicitly share one NapCat instance and the same HTTP URL. Automatic port assignment applies only to listeners owned by RabiRoute and does not move an existing NapCat endpoint to an unstarted port.
- `webhookPort` / `webhookPath`: generic webhook endpoint; the port falls back to `gatewayPort`, and the default path is `/webhook`.
- `agentAdapters`: handler IDs. Codex is verified; Copilot CLI and AstrBot are experimental; Marvis is a manual handoff.
- `primaryAgentAdapter`: the Route's Primary Agent. It must be one of `agentAdapters`. A matched message is delivered only to this handler, not broadcast to the other configured Agents. Older configurations use the first listed Agent; removing the current Primary Agent selects the first remaining Agent.
- Agent handlers use a base capability layer for installation, authentication, project, task, and delivery support, then explicitly opt into managed-task extensions. Codex is currently the only handler declaring **Message Agent mode**, **Plan assistant tasks**, and **Hook management**. WebGUI shows them only on the Codex card, and normalization discards these settings from non-Codex Routes. A future handler with equivalent capabilities may opt into the individual features; a platform with its own Agent orchestration does not need to.
- `messageProcessingAgents.codex`: Codex Message Agent eligibility and its independent model. It defaults off. When enabled, chat messages automatically form groups and reuse or dynamically create Message Agent tasks for distinct topics. ASR and structured events continue direct delivery. `heartbeat` is one continuing inspection responsibility: the first tick selects or creates one Message Agent task, and every later tick is steered back to the most recent heartbeat worker even when that task is still active, so scheduled ticks cannot grow one task each. Task titles use the persona name as a stable prefix: one worker is named `<persona name> 协助处理消息`; when the pool expands, tasks use numbered titles such as `<persona name> 协助处理消息1` and `...消息2`. Renaming preserves the original Desktop task ID and workspace. The default model and reasoning effort are `gpt-5.6-luna` / `medium`, affecting Message Agent turns only, not Primary, Secretary, or Plan Agents.
- `codexThreadId` / `codexThreadName` / `codexCwd`: stable task binding by opaque ID plus workspace, with a visible saved name. An archived saved ID first rebinds to the unique latest active same-name task in the same workspace; if none exists it blocks and requires restore/reselection. It never permits replacement creation. Typing a new name explicitly clears the old ID before complete name lookup. Only system-owned Message Agent tasks with stable generated names use the app-server state index's name filter, avoiding a full-catalog scan on first delivery; ordinary task binding retains complete lookup. One or more exact same-name/workspace matches bind the unique latest `updatedAt`; only zero matches for an empty, invalid, or missing ID may create, and a tied or unusable maximum requires selection.
- `codexPlanAssistantSessions`: exact persistent Desktop-task bindings used as plan-management secretary slots. Each entry keeps the full task ID, visible name, workspace, one-based slot index, and initialization time. One slot is named `<main task name> 协助处理计划`; multiple slots use numbered suffixes. Expanding renames the original slot; shrinking detaches extra tasks without deleting them. Secretary slots are control-plane sessions and are never stored in a plan's `taskBinding`. They maintain plans and memory, deduplicate business tasks, inspect status, consume results, and continue the independent business task; they do not investigate, implement, test, or modify business files. Real multi-task Desktop acceptance is still pending, so the feature remains experimental.
- `codexHooks.sessionContextEnabled`: defaults to `true`. Controls `SessionStart` / `UserPromptSubmit`, triggered when a Codex task starts, resumes, clears, or compacts and when the user submits a new message.
- `codexHooks.reasoningContextEnabled`: defaults to `true`. Controls `PreToolUse` / `PostToolUse`, triggered before and after tool calls and returning only newly matched plan, memory, or skill context for the turn.
- `codexHooks.planTaskCompletionEnabled`: defaults to `true`. Controls `Stop` completion reminders after a plan-bound execution task outputs its final answer for the turn. Delivery uses role-panel, Forwarding, AgentPacket, and the target persona Route's handler task. Turning it off only makes Manager ignore or reject the Hook; it does not unregister or rewrite the Codex plugin Hook.
- `copilotThreadName` / `copilotCwd`: independent Copilot CLI session configuration.
- `agentModel`: legacy compatibility only. The Codex Desktop path ignores it; the target Desktop task owns its model.
- `heartbeatSkipWhenAgentBusy`: applies only while Codex Message Agent mode is off. With Message Agent mode on, heartbeat goes immediately to an independent Message Agent and is not skipped because the Primary task is active. Other message kinds are unaffected.
- `speechPushMode`: Route-owned speech delivery mode. `hot` delivers every completed ASR segment immediately. `keyword` records every segment but wakes the Agent only after a persona-keyword match. WebGUI's **Hot delivery** switch maps On to `hot` and Off to `keyword`.
- `speechTriggerKeywords`: persona-owned names, common addresses, and wake phrases in `personaConfig.json`. When the list is empty and Hot delivery is off, ASR remains recorded and never silently falls back to `hot`.
- `recentMessageLimits`: persona-owned `0–200` auto-injection budgets for `napcat`, `remoteAgent`, `heartbeat`, `rolePanel`, `speech`, `fennenote`, `xiaoai`, `rabilink`, `wearable`, `webhook`, `wecom`, and `weixin`. The schema default is `12`; `0` disables only automatic injection. Legacy `recentMessageLimit` and explicit endpoint values remain effective.
- `contextInjection`: persona-owned focused-context policy. It defaults to `{"mode":"focused","relevantKnowledgeLimit":3,"personaMaxChars":1600}`; `mode=legacy` restores full active indexes. The numeric ranges are `1–12` and `800–6000`.
- `dataDir`, `rolesDir`, `configName`, `agentRoleId`, `agentRoleFile`: storage and role binding.

Windows paths may use either slash style in WebUI. Only hand-written JSON requires escaped backslashes.

## Message adapters

| Adapter | Maturity | Notes |
| --- | --- | --- |
| `napcat` | verified | Inbound OneBot WebSocket and outbound OneBot HTTP. |
| `heartbeat` | verified | Internal scheduled events. **Trigger now** waits only for Manager acceptance and releases the button immediately; the adapter log reports the final Agent delivery result. A repeated request for the same Route and rule is not started again while the first delivery remains active. |
| `speech` | experimental | RabiPC/RabiSpeech resident ASR. Hot delivery sends every segment; keyword mode records all segments and sends only persona-keyword matches. Successful same-session TTS joins ASR in the bidirectional persona context. |
| `rolePanel` | verified | Built-in Manager/Qt role conversation capability. It is available by default, hidden from WebGUI's configurable adapter list, and is not a network listener. |
| Plan approval | verified system event | Not a message adapter. Manager emits `plan_feedback` after persisting the feedback audit; it has no configurable recent-message budget and does not enter the role timeline or unified conversation ledger. |
| `remoteAgent` | experimental | Manager discovers and connects remote bridges for tasks/events/files. |
| `webhook` | experimental | Generic POST source for systems without a dedicated adapter. |
| `fennenote` | experimental | Voice-transcript input and optional output bridge. |
| `xiaoai` | experimental/design-dependent | Dedicated integration route; verify the actual bridge environment. |
| `rabilink` | experimental | Relay/worker/device observation and downlink path. |
| `wecom` | experimental | WeCom smart-bot WebSocket and Outbox group sends. |
| `weixin` | experimental prototype | OpenClaw iLink QR login and long-poll ingress for personal Weixin. Text and allowlisted local-file replies are source-session-only; inbound media is record-only. |
| `feishu` | implemented locally; real credentials pending | Feishu enterprise-app event callback with signature/encryption checks, durable deduplication, and source-chat text replies. |
| `wearable` | experimental | Structured wearable health observations through the global RabiLink Relay worker. Samples enter a role-scoped timeline; only threshold or sleep-state alerts reach the Agent as `wearable_health_alert`. |

Named platforms should use their dedicated adapter rather than being folded into the generic webhook.

NapCat credentials and Tencent security verification never belong in RabiRoute configuration. The explicit **Open NapCat** action can start a bound instance, use an existing quick-login account, and repair OneBot endpoints; human verification remains in NapCat WebUI.

## Handler adapters

- `codex`: reads user-visible names from short-lived app-server `thread/list`, merges local cwd/archive/time/owner state by full ID, binds by full task ID and workspace, and asks the Desktop owner to start or steer the real turn through Desktop IPC. SQLite `threads.title` is mutable prompt metadata and is never the same-name lookup source.
- `copilotCli`: calls a local Copilot CLI with a dedicated session name/cwd and records output. It does not inject into an existing VS Code Copilot panel thread.
- `astrbot`: supports Dashboard login checks, project/session scans, plugin deployment, and ChatUI delivery; continuous real-session acceptance remains pending.
- `marvis`: writes prompt files, copies text, and opens/focuses the desktop application. It cannot reliably inject into a background session.

## Desktop-owner requirement

Codex/ChatGPT Desktop must be running for real delivery. RabiRoute may open `codex://threads/<id>` to load a task and retry briefly, but it does not start a fallback execution Runtime. Model, tools, sandbox, and approvals remain owned by the target task.

## RabiLink global configuration

The PC identity and Relay connection live in `data/Config.json`, including `rabiGuid` and `rabiLinkRelay` (`enabled`, `url`, `token`, `deviceId`, and timing options). Remote WebGUI identifies the PC at `/manage/<account>/<RabiGUID>/`; the legacy `/webgui` child path remains only for compatibility. Manager registers the PC and proxies remote RibiWebGUI independently of one route process. It also subscribes to local Manager `/api/events` and forwards non-`ready` events to the Relay's remote-WebGUI SSE; attachments, downloads, and media ranges use the same constrained WebGUI channel. A route still needs the `rabilink` message adapter to consume device observations.

The same file owns `webguiLan`, the local Manager's LAN WebGUI switch and access key. It defaults to `enabled=false`, keeping Manager on `127.0.0.1`. Enabling it from the local Console creates a random 32-byte access key when needed; after Manager restarts it listens on `0.0.0.0`. Use `http://<Rabi-PC-LAN-IP>:8790/#/overview?webgui_token=<key>`. The browser keeps the captured key only for the current session and removes it from the address bar. Enable, generate, and rotate operations accept only requests originating from the Manager PC itself, through either loopback or one of that PC's own LAN addresses; other devices remain denied, and rotation invalidates old links immediately.

Legacy per-route Relay fields remain readable for compatibility; new configuration belongs in the global file. Public examples never include a Relay URL/token.

Record-first sources such as FenneNote can be selected through `routeVariables.rabilinkRecordFirstSources`. Configure one owning route only; do not let another direct-delivery route consume the same webhook and create duplicate Agent turns.

## WeCom

`wecomBotId`, `wecomBotSecret`, and optional `wecomWsUrl` configure the smart-bot WebSocket. Prefer `WECOM_BOT_ID`, `WECOM_BOT_SECRET`, and `WECOM_WS_URL` for real credentials. See [WeCom Integration](wecom-integration_en.md).

## Personal Weixin prototype

`weixinBaseUrl` and `weixinBotType` configure the OpenClaw/iLink prototype and default to `https://ilinkai.weixin.qq.com` and `3`. `WEIXIN_BASE_URL` and `WEIXIN_BOT_TYPE` may override them. QR-login tokens, account identifiers, sync cursors, and per-session context tokens stay protected under runtime `data/` and must never enter examples or logs. On restart, WebGUI distinguishes restoring, restored, temporarily unreachable with credentials retained, explicitly invalid, and never logged in. A QR is fetched only after the user explicitly clicks **Generate login QR**; temporary network/5xx/scan failures never clear the session, while explicit `-14` or HTTP 401/403 rejection does. Historical message counts do not imply current authentication. Outbox remains source-session-only and real-account longevity is still unverified.

## Feishu enterprise-app endpoint

`feishuAppId`, `feishuAppSecret`, `feishuVerificationToken`, and `feishuEncryptKey` configure one Feishu enterprise application. `feishuWebhookPort` and `feishuWebhookPath` configure the local callback listener. Keep `feishuEventSubscriptionEnabled` false until the platform-side HTTPS callback and `im.message.receive_v1` subscription are confirmed. The adapter handles URL challenges, validates the raw-body signature and Verification Token, decrypts Encrypt Key payloads, persists `event_id` deduplication, isolates context by source `chat_id`, and sends text only back to that source chat under adapter output policy. An incoming-bot webhook cannot replace these application credentials. See [Feishu Endpoint Integration](feishu-integration_en.md).

## Multiple routes and shared roles

Each folder under `data/route` is independently startable and may have its own endpoints and handler workspace. Several Routes may bind the same `agentRoleId`; they reuse that persona's root-level rules, speech keywords, and context budgets while retaining their own endpoint, pipeline, hot-delivery, and handler configuration.

Once an ordinary message matches a rule, it is delivered directly to the Route's Primary Agent. When Codex is primary, RabiRoute uses `steer` for an active Desktop turn or `start` for an idle task. Ordinary endpoints do not need another hot-push toggle. Heartbeat's busy-skip switch and speech's hot/keyword mode are explicit exceptions.

The automatic recent-context source is `data/roles/<RoleId>/conversation/current.jsonl`, scoped to the current persona, logical endpoint, and conversation. Inbound and outbound records count together. Time-based archives live under `conversation/archive/` and are not injected automatically.

When adding a new platform, create a module under `src/adapters/` and normalize it into the common event/forwarding path. Do not put unrelated protocol logic into the NapCat adapter.

## RibiWebGUI and plugins

RibiWebGUI edits runtime configuration through Manager APIs. Plugin and external integration pages should show actual scan maturity and requirements rather than treating the presence of configuration fields as proof of a verified end-to-end integration.
