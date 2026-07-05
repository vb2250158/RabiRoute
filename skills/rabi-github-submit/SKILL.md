---
name: rabi-github-submit
description: Prepare RabiRoute changes for GitHub submission with commit-specific project-context maintenance. Use when the user asks to submit, commit, push, publish, or prepare RabiRoute GitHub changes, especially when update logs, local Rabi persona data, or the public example Rabi persona must be updated according to the current commit's actual project progress.
---

# Rabi Github Submit

## Overview

Use this skill as the RabiRoute-specific submission checklist before staging, committing, pushing, or opening a PR. It adds one project rule on top of the normal GitHub workflow: the current commit's concrete progress must be reflected not only in the update log, but also in Rabi's local runtime persona and the sanitized public example persona when relevant.

## Required Context

Work from the RabiRoute repo root. On this machine the repo is usually `C:\Data\CottonProject\RabiRoute`; in WSL use the equivalent `/mnt/c/Data/CottonProject/RabiRoute`.

Important paths:

- `版本更新日志.md`: public project update log.
- `data/roles/Rabi/`: local runtime Rabi persona, private by default and not normally committed.
- `examples/data/roles/Rabi/`: public example Rabi persona, safe to commit after sanitization.
- `examples/data/roles/Rabi/plans/` and `data/roles/Rabi/plans/`: Rabi's project plans.
- `examples/data/roles/Rabi/memory/` and `data/roles/Rabi/memory/`: recent and consolidated project memories.
- `examples/data/roles/Rabi/README.md` and nested README files: human-facing explanation of the example persona.

## Workflow

1. Inspect the current change set before writing submission text or editing Rabi context.
   - Run `git status --short` and review changed files.
   - Read the relevant diffs, docs, or code paths enough to understand the actual project progress.
   - Treat the diff being submitted as the source of truth. Do not infer progress from file names alone, old plans alone, or general project direction.

2. Update the project update log when the change is user-facing, architectural, release-worthy, or operationally important.
   - Prefer concise entries in `版本更新日志.md`.
   - Mention behavior, migration notes, and validation that future maintainers would care about.

3. Check whether local Rabi exists, then update it only for this submission's progress.
   - If `data/roles/Rabi/` exists, treat it as the runtime source of Rabi's current private project context.
   - Update its `plans/`, `memory/`, and README-like docs when the current commit changes RabiRoute's direction, boundaries, adapter model, route kinds, WebGUI behavior, persona lifecycle, troubleshooting knowledge, or example-data policy.
   - Review active/in-progress plans as part of that check: this commit may complete a slice, change the next step, add evidence, or make a plan stale even when the plan is not finished.
   - If active/in-progress plans and memories already describe the post-commit state accurately, leave them unchanged and note that they were checked.
   - Record what this commit completed, changed, or newly revealed; avoid unrelated backlog grooming.
   - Keep local runtime secrets, real IDs, private messages, logs, and tokens out of committed files.

4. Update the public example Rabi persona according to this commit.
   - Always inspect `examples/data/roles/Rabi/` before submission.
   - Mirror durable, public-safe project knowledge from local Rabi into the example persona when it helps new users understand what this commit changed or made current.
   - Update example `plans/` to reflect completed, active, in-progress, or newly discovered RabiRoute work affected by this commit.
   - Update example `memory/recent/` or `memory/consolidated/` with sanitized project lessons that should ship with the open-source example.
   - Update `examples/data/roles/Rabi/README.md`, `plans/README.md`, or `memory/README.md` when directory meaning, workflow, or story has changed.
   - If the example persona is already current for this commit, do not churn files just to show activity.

5. Sanitize public example data before staging.
   - Public example files may use localhost, placeholders, template variables, fictional sample content, and project-generic details.
   - Do not commit real QQ IDs, group IDs, private chats, tokens, cookies, machine-specific usernames, private paths, or runtime-only `data/` contents.
   - If the local Rabi data contains a useful lesson, rewrite it into a public-safe example instead of copying it directly.

6. Validate the full submission.
   - Run the repo's normal tests, type checks, build, or targeted validation appropriate to the changed files.
   - Re-run `git diff --check`.
   - Review `git diff -- examples/data/roles/Rabi` when example persona files changed.
   - Review `git status --short` and stage only intentional public files.

7. Submit using the normal GitHub flow.
   - Compose the commit/PR summary from actual changes and validation.
   - Mention Rabi persona/example updates when they are part of the submission.
   - If local `data/roles/Rabi/` was updated but not committed, say so explicitly in the final handoff.
   - On this machine, if `git push` over CLI repeatedly fails due to GitHub network, proxy, TLS, or credential timeouts after the local commit is created, it is OK to try GitHub Desktop as a push fallback for the existing local commit. Do not use GitHub Desktop to change the commit contents; use it only to publish the already-reviewed branch/commit, then re-check `git status -sb`.

## What To Update In Rabi

Use judgment; do not mechanically edit every file. Update Rabi context when the current commit teaches Rabi something durable.

- Plans: inspect active and in-progress work, move work between active/archive states, adjust statuses, add newly discovered follow-up plans, or revise plan descriptions after implementation.
- Memory: add small recent memories for new lessons; consolidate only when the lesson is stable and broadly useful.
- README files: update when the example structure, project story, setup expectations, or public-facing explanation would otherwise be stale.
- Persona prompts or skills: update only when Rabi's behavior, boundaries, or capabilities changed.

## Decision Rules

- If a change only fixes an internal typo or mechanical formatting, the update log and Rabi persona may not need edits.
- If a change affects how users understand, configure, debug, extend, or safely publish RabiRoute, update the log and at least inspect both Rabi persona locations.
- If a plan remains in progress, still check whether this commit changes its status, evidence, risks, next step, or wording; if it is already accurate, keep it as-is.
- If local Rabi and public example Rabi diverge, preserve private/local specificity in `data/roles/Rabi/` and convert only safe durable lessons into `examples/data/roles/Rabi/`.
- If `data/roles/Rabi/` is absent, continue with the public example persona and mention that the local runtime Rabi directory was not present.
- Never stage runtime `data/`, logs, `.env`, `dist`, or `node_modules` unless the user explicitly asks and the file is safe.

## Useful Commands

```bash
git status --short
git diff --stat
git diff --check
rg -n "Rabi|persona|memory|plans|route kind|adapter|WebGUI|update log" README.md docs src examples/data/roles/Rabi
```

On Windows PowerShell, prefer explicit UTF-8 when reading or writing Chinese Markdown:

```powershell
Get-Content -LiteralPath '.\版本更新日志.md' -Encoding UTF8
Get-Content -LiteralPath '.\examples\data\roles\Rabi\README.md' -Encoding UTF8
```
