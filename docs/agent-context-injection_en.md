<!-- docs-language-switch -->
<div align="center">
English | <a href="./agent-context-injection.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Agent Context Injection

> Status: current guide. Checked against `src/routing/agentPacket.ts`, role-knowledge behavior, and routing tests.

RabiRoute wraps a routed event before delivering it to a handler. The wrapper tells the handler where the event came from, which role is active, which lightweight plan/memory/skill indexes matter, where logs live, and how a reply must return through RabiRoute.

The route template should stay thin. Users normally add only rule-specific instructions; RabiRoute generates the stable event and context sections.

## Unified trigger pipeline

Context entry points no longer call role knowledge independently. Each adapter emits a normalized trigger for `RabiContextManager`:

```text
Codex SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
RabiRoute QQ / webhook / voice / manual-trigger / heartbeat delivery
Manager or UI preview
  -> normalized ContextTrigger
  -> RabiContextManager
  -> roleKnowledgeSnapshot plus one lifecycle policy
  -> RoleKnowledgeContextView
  -> Codex additionalContext or AgentPacket
```

Adapters provide role, message or tool signal, session/turn/event identity, and source. They do not own keyword scoring, plan archival, memory activity windows, or `viewedAt`. Entry triggers use focused context by default, reasoning triggers add only newly relevant required reads for the turn, and preview forbids knowledge side effects.

## Injection principles

Default injection is lightweight:

- Essential event fields.
- CQ `reply` / `at` explanations for QQ messages. Reply chains are expanded from message records, while at mappings are collected together.
- Recent bidirectional messages allowed by the current endpoint's persona-owned `recentMessageLimits` value. The current event is excluded from this window because it already has its own section. `heartbeat` and the independent `plan_feedback` event are fixed exceptions and never read or inject message history.
- Role, route, and workspace-relative paths plus a compact persona core.
- A link to the Rabi Agent interface guide.
- Up to three highly relevant plan, memory, and skill summaries by default.
- On-demand paths for complete plan, memory, and skill indexes.
- Log paths.
- The reply API and serialized `replyContext`.

It does not inject every chat log, unrelated active indexes, complete plan body, complete memory body, consolidated-memory corpus, or full diagnostic report. The handler must fetch a specific item by ID when it needs details.

## Canonical bidirectional conversation ledger

Automatic recent context no longer builds separate one-way summaries from `group-messages.jsonl`, `voice-transcripts.jsonl`, `wecom-messages.jsonl`, and similar protocol files. Those files remain audit and compatibility evidence. The automatic-context source of truth is:

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

The ledger includes both directions: QQ replies sent by the role, ASR/TTS, WeCom, Remote Agent, role panel, RabiLink, and other integrated endpoint traffic. Each record keeps the logical adapter, physical transport, direction, speaker, conversation, status, and safe attachment metadata without persisting private absolute attachment paths.

Automatic injection must match all three scopes: the current persona, the current logical endpoint, and the current conversation (for example a QQ group/private peer, WeCom chat, or speech `sessionId`). Inbound and outbound records share one count budget. `personaConfig.json.recentMessageLimits` independently configures ordinary endpoint values from `0` to `200`; the schema default is `12`, and `0` disables only automatic injection, never recording. `heartbeat` is always treated as `0`: even when a legacy config keeps a non-zero value, AgentPacket does not read the ledger or generate a recent-message section. The independent `plan_feedback` event is also fixed at `0` and does not enter the unified conversation ledger because its dedicated feedback JSONL is the audit source of truth. There is no separate 360-entry or other count cap on `current.jsonl`.

Personas may select the injection policy in `personaConfig.json`:

```json
{
  "contextInjection": {
    "mode": "focused",
    "relevantKnowledgeLimit": 3,
    "personaMaxChars": 1600
  }
}
```

`focused` is the safe default: it injects the current conversation window, relevant summaries, and a compact persona workset. `relevantKnowledgeLimit` accepts `1–12`; `personaMaxChars` accepts `800–6000` for the Codex Hook excerpt. Set `"mode": "legacy"` to restore full active indexes, the previous 5/12 recall limits, and the 3200-character persona excerpt. Existing files without this field remain readable and require no private-value migration.

Archival follows record timestamps rather than deleting data at a calendar boundary. When an archive check finds any record older than 72 hours, the complete contiguous prefix older than 24 hours moves to `<firstSequence>~<lastSequence>.jsonl`. Automatic context reads only `current.jsonl`. Archives remain preserved and can be queried explicitly through the injected paths.

## User template role

A route template may be empty. Use it only for an extra constraint such as:

```text
Keep any group-chat draft short.
```

or:

```text
Record this event, but do not produce an external reply.
```

RabiRoute places this text in the `[User template supplement]` section. Event fields, role paths, logs, plan/memory indexes, and reply instructions do not need to be repeated in every rule.

## Current wrapper

The exact output omits empty or disabled sections, but its shape is:

```text
[RabiRoute event]
Event: <event label>
Route kind: <routeKind>
Event time: <time>
Current time: <currentTime>
Source: <messageTarget>
Sender: <sender>

[Message]
<message>

[Message code parsing]
[CQ:reply,id=<messageId>] : <referenced-message preview>
  [CQ:reply,id=<messageId>] : <earlier referenced-message preview>
[CQ:at,qq=<qq>] : <group card or nickname>

[Recent messages]
Current endpoint: <recentMessageEndpoint>
Current conversation: <recentConversationKey>
Latest <recentMessageLimit> bidirectional messages for this endpoint and conversation:
<recentMessages>

[Role and paths]
Role: <agentRoleId>
Role file: <agentRolePath>
Role directory: <agentRoleDir>
Runtime data directory: <dataDir>
Plans: <plansDir>
Memory: <memoryDir>

[Memory and plans]
Interface guide: <agentInterfaceDocPath>
Compact on-demand API hints
Full active-index query paths
Matched skill summaries
Matched plan/memory summaries

[Pre-action context confirmation]
<required-read items and GET endpoints>

[Logs]
Group, private, heartbeat, manual-trigger, role-panel, and voice-transcript paths
Current bidirectional conversation: <conversationCurrentPath>
Conversation archive: <conversationArchiveDir>
Conversation archive index: <conversationArchiveIndexPath>

[Reply]
Reply API: <replyApiUrl>
Current reply context: <replyContextJson>

[Reply delivery requirements]
<instructions derived from outputAdapter, source, and replyToSource>

[Remote Agent devices]
<included only when the route enables the remoteAgent message endpoint>

[User template supplement]
<optional route template>
```

For `heartbeat` and `plan_feedback`, the entire recent-message section is omitted. `{recentMessageLimit}` is `0` and `{recentMessages}` is an empty string, so a custom template cannot reintroduce historical message bodies. Heartbeat audit logs and the unified ledger continue to be recorded for explicit on-demand inspection. Plan feedback keeps only its dedicated feedback audit, AgentPacket, and delivery logs; it is not duplicated into the role-panel timeline or unified conversation ledger.

`[Message code parsing]` appears only when the current message or its reply chain contains parseable CQ codes. RabiRoute follows `CQ:reply` by `messageId` through the current route's group/private message records, while AgentPacket also accepts successful Outbox sends as a local fallback. When the live NapCat path sees a referenced ID that has not been stored, the adapter calls OneBot `get_msg` before routing, caches the returned group/private record with `lookupSource=onebot_get_msg`, and continues with the next reply level. API failures are logged as warnings and do not block the current message. Expansion stops when no reply remains, the reference still cannot be resolved, a cycle is detected, or the safety depth limit is reached. Each referenced preview is capped at 200 characters and then uses `……(更多信息调用接口查看)`. Any `CQ:at` found during the walk is deduplicated and emitted together as `[CQ:at,qq=xxxx] : group card or nickname`. This section does not add the current message ID and does not repeat the plain text body.

When a `voice_transcript` explicitly comes from the RabiPC `speech` message endpoint or RabiSpeech, `AgentPacket` resolves that turn to `voice_chat` and writes `characterTtsDialogue=true` into `replyContext`. `[Reply delivery requirements]` tells the handler to enter character-TTS dialogue mode and POST a short spoken line, semantically identical to the visible reply, to the normal reply API. Outbox resolves model, voice, language, speed, and speaking instructions from the current persona's `voice/voice-profile.json`, preserves the original `sessionId`, and enters the host-wide FIFO. Same-session ASR and TTS then share the persona's `speech` recent-context budget. QQ, the role panel, ordinary text inputs, and other `voice_transcript` sources do not inherit this switch.

Speech also has an explicit record-before-wake policy. Route `speechPushMode=hot` delivers every completed ASR segment immediately. `keyword` records every segment and delivers only when the persona-owned `speechTriggerKeywords` matches; an empty keyword list never falls back to hot. Matched ordinary endpoint messages otherwise enter Desktop `steer/start` directly, while Heartbeat's busy skip remains a separate switch.

The processing host, voiceprint IDs, and persona voice-identity file path appear only on voice-transcript records. QQ, role-panel, and other non-audio events omit these voice-specific fields.

When no role is bound, RabiRoute uses a direct-message section instead of role knowledge. It still injects the event, logs, reply context, and delivery requirements.

## Workspace-relative paths

Role and log paths are rendered relative to the RabiRoute workspace when possible:

```text
data/roles/Rabi/persona.md
data/roles/Rabi/plans
data/roles/Rabi/memory
data/route/default-main/group-messages.jsonl
docs/rabi-agent-interfaces.md
```

This avoids leaking usernames or machine-specific absolute paths into prompts and public examples.

## Recall and required reads

`[Memory and plans]` lists active plans and recent memories by ID and title. Only top-level `进行中` plans are active; `暂停` plans remain non-archived and searchable but are not injected as active work. A recent memory is considered active using the later of `updatedAt` and `viewedAt`; the default direct-display window is 24 hours.

Before delivery, RabiRoute performs lightweight matching over metadata only:

- plan, memory, and skill IDs;
- titles;
- Agent-maintained `keywords`;
- small ranking bonuses for active plans and active recent memories.

It does not tokenize or scan every body on the hot path. The top relevant items, normally up to five, become `[Pre-action context confirmation]` entries with GET endpoints. The handler must read these items before replying, changing plans or memories, creating tasks, or taking an external action. If an item cannot be read or is insufficient, the handler should state the uncertainty or ask the user.

Matching a recent or consolidated memory refreshes its `viewedAt`. Reading a memory by ID also refreshes `viewedAt`; updating recent memory refreshes both `updatedAt` and `viewedAt`.

## Explicit memory consolidation

Memory consolidation uses a `manual_trigger` event with `triggerId=memory-consolidation`, or an explicit Manager API request. The request evaluates the current 72/24-hour thresholds and creates a pending run when due. Time passing alone does not start a resident background consolidation job.

When a pending run is attached, the wrapper includes:

- `runId`;
- the result endpoint;
- the consolidation instruction;
- eligible recent-memory bodies.

The handler returns consolidated memories to the result endpoint; it does not move files or choose the input set.

## Template-value boundary

Advanced route templates can use actual values such as:

```text
{agentInterfaceDocPath}
{plansDir}
{memoryDir}
{recentMessages}
{recentMessageLimit}
{recentMessageEndpoint}
{recentConversationKey}
{conversationCurrentPath}
{conversationArchiveDir}
{conversationArchiveIndexPath}
{replyApiUrl}
{replyContextJson}
{rolePanelLogPath}
```

Focused match summaries and full-index query paths are produced by the wrapper itself. Legacy mode expands the active-plan, recent-memory, and skill indexes. None of these are independent free-form route-template variables. See [Routing Configuration](routing-configuration_en.md) for the broader template vocabulary.

## Boundary

Context injection is not a long-term-memory database, planner, or executor. It provides a compact evidence index and safe return path. The handler reads details by ID, writes recent memory when appropriate, and submits replies through RabiRoute rather than bypassing the message adapter.
