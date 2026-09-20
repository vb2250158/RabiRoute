<!-- docs-language-switch -->
<div align="center">
English | <a href="./project-skill-distribution.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Project skill distribution and drift detection

Status: **current maintainer guide**. This page describes how RabiRoute-owned skills reach other projects and how a copy that has fallen behind upstream is detected.

## What is distributed is the rules, not the files

`project-skills.json` lists the skills RabiRoute maintains and publishes to downstream projects. They are installed as `.agents/skills/<name>/` in the target project and loaded by that project's `AGENTS.md` on demand.

A downstream copy is a **localized derivative**, not a byte copy:

- the body is rewritten for the project's language and business context;
- relative links to RabiRoute-internal pages are replaced with project-local pages, such as that project's own plan API reference;
- project-specific rules are appended.

Overwriting the directory with the upstream source therefore removes the project's localization and its own rules. Upstream owns the correctness of the rules; the project owns the content of its own copy.

## The copy's baseline

The last completed port is recorded by `.rabiroute-sync.json` inside the copy directory:

- `sourceFiles`: SHA-256 of every upstream file at port time;
- `targetFiles`: SHA-256 of every copy file at port time;
- `portedAt`: port time.

The file is committed by the project's own version control, so every machine working on that project sees the same baseline.

## Commands an Agent runs

Run these on a machine that has the RabiRoute checkout; `-ProjectPath` points at the target project root:

```powershell
# Report drift (read-only)
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root>

# Use it as a gate: non-zero unless every skill is in sync and referenced by the target AGENTS.md
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root> -Check

# Restrict the operation to selected skills
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root> -Skill plan-task-orchestration -UpdateBaseline
```

The standard procedure:

1. Run the report and read each verdict plus the per-file lists;
2. Port the upstream changes into the localized copy, keeping project-local edits and project-specific rules, without replacing whole files;
3. After the port, run `-UpdateBaseline` to record the new baseline, then run `-Check` and confirm `in-sync`.

## Verdicts

| Verdict | Meaning | Action |
| --- | --- | --- |
| `in-sync` | Both sides still match the baseline | Nothing to do |
| `source-ahead` | Upstream moved, the copy did not | Port the upstream changes |
| `target-modified` | Upstream unchanged, the project edited its copy | Keep the project edit; upstream needs no change |
| `both-changed` | Both sides moved | Read both before porting; never take one side alone |
| `baseline-missing` | No baseline recorded yet | Review the copy once, then record the baseline |
| `target-missing` | The project has not installed the skill | Install it, or remove it from the catalog |

The report also states whether the target project's `AGENTS.md` references the copy. An installed skill with no load entry is not a valid distribution, and `-Check` fails on it.

## Boundaries

- The script never writes, edits, or deletes copy content; it only reads both sides. The single write is the baseline file under `-UpdateBaseline`.
- A symbolic link, junction, or file occupying the target path is refused outright.
- Skills outside the catalog are never written into the target project; skills the project maintains itself are untouched.
- This mechanism distributes RabiRoute-owned project skills only.

## How it differs from the other synchronization paths

| Mechanism | Synchronized object | Scope |
| --- | --- | --- |
| This page | RabiRoute-owned project skills | Upstream repository to the target project's `.agents/skills/` |
| [RabiLink cross-PC access](rabilink-peer-rpc_en.md) | Authorized reads on the target computer, without synchronized replicas | Within one trusted RabiLink application |
| LAN Agent resource catalog | Packaged `skills/*/SKILL.md` plus explicitly published documents | Authorized Agents pull them read-only on demand; see [remote Agent onboarding](lan-rabi-agent-bootstrap_en.md) |

RabiRoute does not push skills into projects or Agent endpoints: local Codex, DSH, and WorkBuddy sessions each load from their own workspace skill directories, and cross-PC persona access uses RabiLink to read the target computer rather than synchronizing persona data replicas.
