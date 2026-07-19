---
name: use-rabi-codex-context
description: Bind, inspect, refresh, switch, or remove a Rabi persona context for one Codex session. Use when a user asks the current conversation to use a named persona, asks about the Rabi Codex hook, wants Codex-only context management without Rabi PC, connects a Rabi PC roles directory, or troubleshoots missing persona, plan, memory, or skill injection.
---

# Use Rabi Codex Context

Use the plugin's strict control markers. They are intentionally explicit so ordinary conversation never changes persona state by accident.

## Bind or switch this session

Ask the user to submit this marker as part of a prompt:

```text
[rabi:use <RoleId>]
```

Example:

```text
[rabi:use YeYu]
从这一轮开始用夜雨人格和对应上下文。
```

The `UserPromptSubmit` hook receives the real Codex `session_id`, resolves the role from configured Rabi role roots, persists the binding, and injects the role context in the same turn. Never guess a role ID. If resolution fails, report the available role IDs from the hook result.

## Inspect, refresh, or disable

Use exactly one of these markers:

```text
[rabi:status]
[rabi:refresh]
[rabi:off]
```

- `status` reports the current session binding without changing it.
- `refresh` reloads the bound role and reinjects its base context.
- `off` removes only the current session binding. It does not delete persona, plan, or memory files.

## Connect a Rabi PC or local roles directory

Resolve the plugin root from this skill directory: go up from `skills/use-rabi-codex-context/` to the plugin root. Run its CLI with Node.js 20 or newer:

```text
node <plugin-root>/scripts/rabi-context.mjs source add --id rabipc --path <RabiRoute-data-roles-directory>
node <plugin-root>/scripts/rabi-context.mjs roles
node <plugin-root>/scripts/rabi-context.mjs doctor
```

Treat the supplied path as private local configuration. Do not echo it into an external message or commit it to a public repository. The plugin stores only the source registration and per-session binding; Rabi's role directory remains the context truth source.

For Codex-only use, register any directory with this shape:

```text
roles/
  <RoleId>/
    persona.md
    growth.md          # optional
    skills.md          # optional
    plans/             # optional Rabi plan JSON
    memory/recent/     # optional Rabi memory JSON
    skills/            # optional role skills
```

## Direct CLI binding

Use this only when an integration such as Rabi PC already knows the exact Codex session ID:

```text
node <plugin-root>/scripts/rabi-context.mjs bind --session <session-id> --role <RoleId>
node <plugin-root>/scripts/rabi-context.mjs status --session <session-id>
node <plugin-root>/scripts/rabi-context.mjs unbind --session <session-id>
```

Do not infer a session ID from a title, current directory, or recent timestamp. Prefer the control markers when operating inside the session itself.

## Hook behavior and failures

- `SessionStart` reinjects a bound persona on startup, resume, clear, and compaction.
- `UserPromptSubmit` handles explicit markers, reloads changed persona data, and injects a small number of prompt-relevant plan or memory items.
- An unbound session returns no Rabi context.
- Missing or malformed context fails open: Codex continues and the hook returns a bounded diagnostic rather than inventing context.
- Hook output is size-limited. Keep full truth in Rabi files; injection is a compact working set.
- Plugin hooks must be reviewed and trusted in Codex. If nothing fires, inspect `/hooks`, confirm hooks are enabled, run `doctor`, then open a new session.
