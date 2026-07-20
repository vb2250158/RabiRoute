---
name: use-rabi-codex-context
description: Bind, inspect, refresh, switch, or remove Rabi PC-managed persona context for one Codex session and understand its entry, reasoning, and message-delivery triggers. Use when a user asks the current Codex conversation to use a named Rabi persona, asks about the Rabi Codex hook, runs Rabi in context-only mode for Codex, proactively binds an exact Codex session from Rabi PC, or troubleshoots Manager-owned persona, plan, memory, recall, viewedAt, consolidation, role-skill injection, PreToolUse/PostToolUse refresh, or per-turn deduplication.
---

# Use Rabi Codex Context

Treat Rabi PC Manager as the only owner of persona configuration, Codex-session bindings, plans, memories, role skills, recall, `viewedAt`, archiving, consolidation, and trigger policy. Treat the Codex Hook as a thin event trigger and `additionalContext` injector. Never scan or score role files inside the plugin as a fallback.

## Check the Manager

Use the plugin root that contains this skill. Run:

```text
node <plugin-root>/scripts/rabi-context.mjs doctor
node <plugin-root>/scripts/rabi-context.mjs roles
```

The default Manager URL is `http://127.0.0.1:8790`. Set `RABI_MANAGER_URL` only when the local Rabi Manager uses another base URL. If the Manager is unavailable, report that no fresh Rabi context was injected; do not recover from a plugin-local role cache.

For Codex-only use, run RabiRoute Manager with gateway autostart disabled. Keep persona, plan, memory, validation, and consolidation APIs active:

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

Configure the roles directory through Rabi PC / Manager configuration. Do not register role roots in the plugin.

## Bind or switch the current session

Ask the user to submit one strict marker:

```text
[rabi:use <RoleId>]
```

Example:

```text
[rabi:use YeYu]
从这一轮开始使用夜雨人格。
```

`UserPromptSubmit` sends the real `session_id` and raw prompt to Rabi Manager. The Manager validates the role, persists the binding, runs the normal Rabi role-knowledge snapshot, and returns the context for same-turn injection.

## Inspect, refresh, or disable

Use exactly one marker:

```text
[rabi:status]
[rabi:refresh]
[rabi:off]
```

- Use `status` to read the Manager-owned binding.
- Use `refresh` to force the Manager to resend the persona base context.
- Use `off` to remove only this Codex session binding. Do not delete role knowledge.

## Bind proactively from Rabi PC

Use the exact Codex session ID. Never infer it from a title, workspace, or timestamp:

```text
node <plugin-root>/scripts/rabi-context.mjs bind --session <session-id> --role <RoleId>
node <plugin-root>/scripts/rabi-context.mjs status --session <session-id>
node <plugin-root>/scripts/rabi-context.mjs unbind --session <session-id>
```

These commands call Rabi Manager session APIs. They do not write plugin-local binding files.

## Follow required reads

Rabi Manager routes Codex hooks and normal RabiRoute Agent packets through the same `RabiContextManager`, which is the sole caller of `roleKnowledgeSnapshot()`. It may inject a `[处理前上下文确认]` section containing plan, recent-memory, consolidated-memory, or role-skill GET paths.

Before replying, updating knowledge, publishing a task, or performing an external action:

1. Prefix each relative GET path with the injected Rabi Manager API base URL.
2. Read every required item through the Manager API.
3. Use the existing plan and memory APIs for changes; preserve their focus, keyword, edit-window, archival, and consolidation validation.
4. State uncertainty if a required read fails. Never read JSON files directly and pretend the Manager lifecycle succeeded.

## Hook behavior

- `SessionStart` forwards startup, resume, clear, and compaction events to Manager.
- `UserPromptSubmit` forwards the raw prompt and real session ID to Manager.
- `PreToolUse` and `PostToolUse` are reasoning checkpoints. Manager scores bounded tool input/output against the same role indexes and injects only newly relevant required reads.
- The same `turn_id` ledger suppresses repeated context and repeated `viewedAt` refreshes. An updated item has a new revision key and may be injected again.
- Normal RabiRoute message delivery uses the same central context manager with full entry context. The Codex plugin is not involved in message routing.
- Preview policy is read-only: it does not archive completed plans, refresh `viewedAt`, or create consolidation work.
- Manager returns the entire model-visible context; the Hook injects it without re-scoring or supplementing it.
- Unbound sessions receive no Rabi context.
- Manager failures fail open. Explicit Rabi controls receive a bounded diagnostic; ordinary prompts and reasoning checkpoints continue silently without invented context.
- Review and trust plugin hooks through Codex `/hooks`, then test in a new task.
