<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-codex-context-plugin.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context plugin

> Status: 0.3 unified-trigger and context-management version. Source lives in `plugins/rabi-codex-context/`.

## Single ownership boundary

Rabi PC / RabiRoute Manager is the sole owner of persona configuration, Codex session bindings, plans, recent and consolidated memory, role skills, recall scoring, `viewedAt`, plan archival, memory edit windows, and consolidation.

The Codex plugin only forwards `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` events to Manager and injects the returned `additionalContext`. It does not scan role directories, parse plan or memory files, score keywords, store bindings, or keep an offline knowledge cache.

```text
Codex hook event
  -> POST /api/codex-hook/context
  -> Rabi PC Manager session binding
  -> RabiContextManager trigger policy, recall, and side effects
  -> sole roleKnowledgeSnapshot() call site
  -> shared RoleKnowledgeContextView
  -> additionalContext
  -> Codex hook injection

RabiRoute message delivery
  -> normalized message_delivery trigger
  -> the same RabiContextManager
  -> AgentPacket
```

## Unified trigger policy

| Normalized trigger | Source | Context shape | Lifecycle |
|---|---|---|---|
| `session_start` | Codex `SessionStart` | full entry context | normal archival; persona resent when needed |
| `user_prompt` | Codex `UserPromptSubmit` | full entry context | normal recall and matched-memory refresh |
| `reasoning_pre_tool` | Codex `PreToolUse` | newly relevant turn delta | no repeated archival; new hits refresh `viewedAt` |
| `reasoning_post_tool` | Codex `PostToolUse` | newly relevant turn delta | same, including knowledge created or changed by a tool |
| `message_delivery` | normal RabiRoute delivery | full entry context | existing plan, memory, and consolidation rules |
| `preview` | Manager or UI caller | full preview | no archival, `viewedAt` refresh, or consolidation run |

Reasoning hooks do not copy every tool input or output into the model context. Manager scores bounded text against the same ID, title, and `keywords` metadata and returns nothing when no role knowledge or explicit Rabi knowledge path matches. A `turn_id` ledger deduplicates by item type, ID, and revision time, so Pre/Post do not repeatedly inject or refresh the same item.

## Codex-only mode

A Codex-only user still runs the Rabi Manager context service, but may disable automatic gateway startup:

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

This mode does not start Route-config polling. Persona, plan, memory, and skill data is still read from Manager's current `rolesDir` for each Hook request, and an explicit Manager-config change takes effect immediately. This keeps the knowledge service stable on NAS workspaces without repeatedly scanning or migrating Route configuration for Gateways that are not running.

Manage `rolesDir` through Rabi PC / Manager configuration. The plugin no longer supports `source add` or a private plugin-owned `roles/` directory.

### Migrating from plugin 0.1

Role-root registrations and session bindings stored in the plugin user directory by version 0.1 are not migrated automatically. After upgrading to 0.3, start Rabi PC Manager and bind each persona again with the exact complete `session_id`; never infer it from a task title, workspace, or recent timestamp. The former implementation remains only as a read-only migration reference under `archive/plugins/rabi-codex-context-v0.1.0-local-context/` and must not return to the active call path.

New bindings live in Manager-private runtime data at `data/codex-hook/sessions.json`. Do not commit that file, the old plugin user directory, or any real persona data.

## Session controls

Use strict markers inside a task:

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

Manager interprets the markers. Ordinary prose never changes a binding. Rabi PC may also bind proactively with the exact complete session ID:

```text
PUT    /api/codex-hook/sessions/{sessionId}  { "roleId": "YeYu" }
GET    /api/codex-hook/sessions/{sessionId}
DELETE /api/codex-hook/sessions/{sessionId}
```

Never infer a session ID from a task title, workspace, or timestamp.

## Manager API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/codex-hook/context` | Accept a raw Hook event and build unified context |
| GET | `/api/codex-hook/roles` | List Manager-owned personas |
| GET | `/api/codex-hook/sessions` | List Manager-owned Codex bindings |
| GET/PUT/DELETE | `/api/codex-hook/sessions/{sessionId}` | Inspect, proactively bind, or remove a binding |
| GET | `/api/codex-hook/doctor` | Inspect rolesRoot, roles, and bindings |

Binding state lives in private RabiRoute runtime data at `data/codex-hook/sessions.json`. It is not plugin data and must not be committed.

## Recall and consolidation

Manager routes every normalized trigger through `RabiContextManager`, the sole caller of the existing `roleKnowledgeSnapshot()`. This preserves the same ID/title/keyword scoring, active-item boosts, required-read protocol, memory `viewedAt` refresh, plan archival, edit windows, validation, and consolidation APIs used by normal RabiRoute Agent packets.

The Hook does not embed full matched items. Codex must read every Manager GET path in `[处理前上下文确认]`, then use the existing plan and memory APIs for changes. It must not edit JSON directly and claim that the Manager lifecycle succeeded.

## Installation and acceptance

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

After installation or update, start a new Codex task and trust the commands through `/hooks`. Verify Manager outages never trigger plugin-local knowledge fallback, unbound sessions emit no context, marker binding injects in the same turn, keyword matches refresh memory `viewedAt`, sessions remain isolated, Rabi PC can bind exact sessions proactively, `SessionStart` reinjects after startup/resume/clear/compaction, Pre/Post reasoning hooks emit only relevant deltas, same-turn duplicates stay silent, and normal message delivery uses the same context manager.
