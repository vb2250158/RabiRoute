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

Adapters provide role, message or tool signal, session/turn/event identity, and source. They do not own keyword scoring, plan archival, memory activity windows, or `viewedAt`. Entry triggers inject a lightweight full view, reasoning triggers add only newly relevant required reads for the turn, and preview forbids knowledge side effects.

## Injection principles

Default injection is lightweight:

- Essential event fields.
- Recent-message summaries when `recentMessageLimit` enables them.
- Role, route, and workspace-relative paths.
- A link to the Rabi Agent interface guide.
- Active-plan, recent-memory, and role-skill indexes.
- Matches and required-read items relevant to the current message.
- Log paths.
- The reply API and serialized `replyContext`.

It does not inject every chat log, complete plan body, complete memory body, consolidated-memory corpus, or full diagnostic report. The handler must fetch a specific item by ID when it needs details.

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

[Recent messages]
Latest <recentMessageLimit> messages:
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
API hints
Available skills
Active plans
Recent memories
Matched skills
Matched knowledge

[Pre-action context confirmation]
<required-read items and GET endpoints>

[Logs]
Group, private, heartbeat, manual-trigger, role-panel, and voice-transcript paths

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

When a `voice_transcript` explicitly comes from the RabiPC `speech` message endpoint or RabiSpeech, `AgentPacket` resolves that turn to `voice_chat` and writes `characterTtsDialogue=true` into `replyContext`. `[Reply delivery requirements]` tells the handler to enter character-TTS dialogue mode and POST a short spoken line, semantically identical to the visible reply, to the normal reply API. Outbox then freezes the current Route persona, voice, model, `sessionId`, and autoplay choice before entering the host-wide RabiSpeech FIFO. QQ, the role panel, ordinary text inputs, and other `voice_transcript` sources do not inherit this switch.

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

`[Memory and plans]` lists active plans and recent memories by ID and title. A recent memory is considered active using the later of `updatedAt` and `viewedAt`; the default direct-display window is 24 hours.

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
{replyApiUrl}
{replyContextJson}
{rolePanelLogPath}
```

Active-plan, recent-memory, skill, and match indexes are produced by the wrapper itself. They are not independent free-form route-template variables. See [Routing Configuration](routing-configuration_en.md) for the broader template vocabulary.

## Boundary

Context injection is not a long-term-memory database, planner, or executor. It provides a compact evidence index and safe return path. The handler reads details by ID, writes recent memory when appropriate, and submits replies through RabiRoute rather than bypassing the message adapter.
