---
name: rabi-github-pull
description: Pull RabiRoute updates safely and migrate local runtime configuration from project update logs and examples. Use when the user asks to pull, update, sync, upgrade, or refresh a RabiRoute checkout, especially when local data, gateway config, route config, persona files, or adapter configuration may need migration after upstream changes.
---

# Rabi Github Pull

## Overview

Use this skill before and after pulling RabiRoute updates. RabiRoute configuration changes often land in `版本更新日志.md`, `examples/data/`, and adapter docs before a local runtime `data/` directory has been upgraded, so a safe pull includes both Git synchronization and local configuration migration.

## Important Paths

- `版本更新日志.md`: source of migration notes and behavior changes.
- `examples/data/`: public current configuration templates.
- `data/`: local runtime configuration and persona data, private by default.
- `.env`: local secrets and machine-specific settings, never overwrite from examples.
- `src/adapters/`, `src/forwarding.ts`, `src/manager.ts`: likely sources of route, adapter, and config model changes.
- `docs/`: deeper migration notes when the update log links to them.

## Pull Workflow

1. Inspect local state before touching Git history.
   - Run `git status -sb`.
   - If tracked files have local edits, inspect enough diff to know whether they are user work or generated churn.
   - Do not overwrite local `data/`, `.env`, logs, build output, or user edits.

2. Fetch and review upstream before pulling.
   - Run `git fetch origin`.
   - Review incoming commits with `git log --oneline --decorate --left-right HEAD...@{u}` when an upstream exists.
   - Read the incoming `版本更新日志.md` diff before applying migrations:

```bash
git diff HEAD..@{u} -- "\347\211\210\346\234\254\346\233\264\346\226\260\346\227\245\345\277\227.md" examples/data docs README.md
```

3. Back up local runtime configuration when `data/` exists.
   - Create a timestamped copy outside tracked files, such as `.codex-logs/config-backups/<timestamp>/`.
   - Prioritize `data/gateways.json`, `data/route/`, `data/roles/`, and any adapter-specific config directory.
   - Never print secrets, tokens, cookies, real QQ IDs, private chat contents, or full private runtime data in the final answer.

4. Pull conservatively.
   - Prefer `git pull --ff-only`.
   - If fast-forward is not possible, stop and inspect. Do not create a merge commit just to continue.
   - If local tracked work blocks the pull, ask before stashing or committing unless the user already requested that strategy.

5. Upgrade local configuration from update logs and examples.
   - Compare relevant files under `examples/data/` with local `data/` structure.
   - Add missing public-safe defaults to local config when the update log or code clearly requires them.
   - Preserve local IDs, secrets, endpoints, enable flags, persona content, message history, and private paths.
   - For renamed fields, keep a note of the old value and migrate only when the target schema is clear.
   - When unsure whether a local value is intentional, report it as a follow-up instead of guessing.

6. Validate after migration.
   - Run `npm run check:config` when config or examples changed.
   - Run targeted tests or `npm test` when route, adapter, forwarding, manager, or WebGUI behavior changed.
   - Run `npm run build:backend` for TypeScript/API changes when practical.
   - Run `git diff --check` if any tracked files were edited during migration.

7. Report the result.
   - Summarize pulled commits or the fact that the checkout was already current.
   - List local config files upgraded, skipped, or needing user confirmation.
   - Mention validation commands and failures.
   - Keep private runtime details summarized and redacted.

## Migration Checklist

Check these areas whenever the update log mentions config, route kinds, adapters, personas, RibiWebGUI, or manager changes:

- Gateway entries: adapter type, display name, enabled state, process command, environment variables.
- Route config: route kind, match rules, template variables, target handler, output policy.
- Adapter config: NapCat, WeCom, webhook, voice, or plugin-adapter fields.
- Persona config: `personaConfig.json`, message template rules, growth, skills, plans, memory.
- WebGUI/manager config: new API fields, default ports, process supervision, log paths.
- Example data policy: new public examples that should not be copied verbatim into private runtime files.

## Decision Rules

- If there is no `data/` directory, pull and validate examples only; mention that no local runtime migration was needed.
- If incoming changes are documentation-only and do not affect config behavior, do not churn local runtime files.
- If examples add new optional fields, prefer leaving local config unchanged unless the update log says the field is required.
- If code now requires a field and examples show a safe default, add that default locally while preserving private values.
- If a migration could send messages, start processes, or expose private data, stop and ask before executing it.
- Never commit local runtime `data/`, `.env`, logs, `dist`, or `node_modules` as part of pull cleanup.
