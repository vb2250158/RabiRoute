<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-codex-context-plugin.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context plugin

> Status: first testable version. Source lives in `plugins/rabi-codex-context/`.

## Product boundary

Rabi Codex Context is an independently installable Codex plugin. It lets a user bind one Codex session explicitly to a Rabi persona, then injects compact persona, plan, memory, and role-skill context through Codex lifecycle hooks.

It does not require Rabi PC to remain running:

- Codex-only users may register any local `roles/` directory that follows the Rabi role layout.
- Rabi PC / RabiRoute users register their `data/roles/` directory and continue to let Rabi PC manage persona, plan, and memory files.
- The plugin owns only the `Codex session ID -> RoleId + role root` binding. It does not copy role knowledge or become a second memory source of truth.

## Installation and first acceptance check

The repository contains a non-default project marketplace. Register it from the repository root, then install the plugin:

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

Start a new Codex task after installation so the task loads the plugin and hooks. An unbound task should receive no Rabi context for ordinary prompts. After sending `[rabi:use <RoleId>]` in the target task, the same turn should report a successful binding and inject the persona working set. Codex must still approve the hook command through its trust review.

## Session activation model

Codex loads plugin hooks with the plugin. Hooks cannot be added or removed dynamically before they know the current session, so the plugin uses logical activation:

```text
Codex SessionStart / UserPromptSubmit
  -> hook reads the real session_id
  -> no explicit binding: no context output
  -> explicit binding exists: read the selected Rabi role directory
  -> inject persona working set + plan/memory indexes + relevant items
```

Ordinary natural language never changes a binding. The user invokes strict control markers inside a session:

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

`UserPromptSubmit` carries the real Codex `session_id`, so the plugin never guesses session identity from a title, workspace, or recent timestamp. A future Rabi PC UI must also call the CLI with the complete session ID rather than treating a task title as identity.

## Injection strategy

- `SessionStart` reinjects a bound persona on `startup`, `resume`, `clear`, and `compact`.
- `UserPromptSubmit` handles control markers, refreshes base context when persona files change, and lightly matches plan/recent-memory IDs, titles, and `keywords` against the current prompt.
- Base context is not repeated on every turn, and a turn with no relevant match emits no extra context.
- Model-visible output from one hook is limited to about 9,000 characters. Complete material remains in the role directory.
- Loading failures let the Codex task continue while explicitly prohibiting invented persona details.

## Local data

The default state directory is `.rabi/codex/` under the user profile and can be overridden with `RABI_CODEX_HOME`. It stores only:

```text
config.json             # registered role roots
session-bindings.json   # explicit session bindings
hook-state.json         # injection fingerprints and lightweight state
roles/                  # optional Codex-only local role root
```

Do not commit this local state. It may contain personal paths, session IDs, and private persona bindings.

## Rabi PC integration contract

Rabi PC integrations reuse the plugin CLI:

```text
source add --id rabipc --path <data/roles>
bind --session <complete Codex session ID> --role <RoleId>
status --session <complete Codex session ID>
unbind --session <complete Codex session ID>
```

The UI may display persona and task names, but persistence and CLI calls must use the complete session ID. Binding, switching, and unbinding are explicit actions; selecting a Route persona must not silently contaminate manual conversation in the same Codex task.

## Acceptance

1. An unbound session emits no Rabi context at startup or for an ordinary prompt.
2. `[rabi:use <RoleId>]` binds and injects the persona in the same user turn.
3. A new, resumed, cleared, or compacted session reinjects by the original session ID.
4. `[rabi:off]` unbinds only the current session and does not delete role knowledge.
5. Two sessions may bind different personas without context leakage.
6. Persona, plan, or memory changes refresh by fingerprint or keyword on a later turn.
7. Hooks run only after Codex trust review; without approval, the plugin must not claim that context was injected.
