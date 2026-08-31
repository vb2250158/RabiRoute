# RabiRoute submission reference

This reference supplies the RabiRoute-specific decisions that should not make the main Skill longer or noisier.

## Submission authority

| User wording | Allowed terminal state |
|---|---|
| inspect / review | read-only findings |
| prepare / ready for commit | edits and reviewed staging plan; no commit or push |
| stage | reviewed index; no commit or push |
| commit | local commit; no push |
| push / publish branch | local commit plus push to the confirmed branch |
| open PR | branch push plus PR creation |
| release / tag | only the explicitly requested tag/release action |

Do not silently promote one state to the next.

## Change-risk routing

| Change surface | Required review focus |
|---|---|
| route, adapter, AgentPacket, Desktop IPC | identity, target task, trust boundary, fail-closed behavior |
| Outbox / Action Gate | authorization provenance, draft/approval/audit separation, external side effects |
| Manager API / WebGUI | authentication, authorization, local-path exposure, DTO ownership |
| plan/memory/persona | Manager lifecycle contract, privacy, deduplication, atomicity |
| filesystem, upload, package | canonical path containment, symlink/junction behavior, payload privacy |
| shell/process, installer, hot reload | argument boundaries, inherited environment, elevation, rollback |
| network, Relay, webhook, MCP | bind address, authentication, SSRF, credential forwarding, rate limits |
| CI/release | untrusted trigger data, token permissions, exact commit, package contents |

The bundled preflight blocks `pull_request_target`, `permissions: write-all`,
persistent checkout credentials, and external actions that are not pinned to a
full commit SHA in every changed GitHub Actions workflow. A local action is
allowed by path; a Docker action must use a `sha256` digest.

## Mandatory commit version and changelog contract

RabiRoute uses one repository patch version per commit created by this workflow. This is an explicit project traceability rule, not a release-worthiness decision.

For a `HEAD` version `X.Y.Z`, the candidate commit must use `X.Y.(Z+1)` exactly. The gate rejects:

- an unchanged version;
- a skipped patch;
- a major or minor change in the ordinary submit workflow;
- a version present only in the worktree but absent from the staged index;
- two locally created commits sharing one version.

Every commit must update these six files together:

| File | Required state |
|---|---|
| `package.json` | exact next patch version |
| `package-lock.json` | top-level and root-package versions match `package.json` |
| `README.md` | version badge and current repository version match |
| `README_zh.md` | version badge and current repository version match |
| `版本更新日志.md` | dated section for the exact version with a concrete bullet derived from the staged diff |
| `版本更新日志_en.md` | matching English version section and content |

The rule applies to code, documentation, tests, formatting, refactors, merge resolutions, and skill changes. `未发布` / `Unreleased` may retain work that is not entering the commit, but it cannot be the only record for the commit being created.

The previous policy allowed ordinary commits to reuse a version and treated changelog updates as conditional. That produced three conflicting identities: source commits advanced while `package.json` stayed fixed, installed Manager builds kept an older version, and GitHub Releases moved only when tags were created. The mandatory per-commit contract prevents source commits from sharing a version; packaging, installation, tags, and GitHub Releases still require their own explicitly authorized workflows.

After any rebase, merge, pull, or upstream movement, re-read `HEAD:package.json` and regenerate the candidate patch version. Never resolve a version conflict by keeping the same candidate number from before the history changed.

## Local Rabi context

Local `data/roles/Rabi/` is private runtime state, not a mirror of Git history.

Update it only when the submission changes durable knowledge that Rabi must recover later, such as:

- RabiRoute’s responsibility or boundary;
- a stable adapter, route, approval, plan, or memory contract;
- a completed or materially redirected Rabi-owned plan;
- a recovery procedure or operational constraint that will matter in later work.

Use the Manager API for plans and memories so validation, timestamps, focus limits, deduplication, and lifecycle rules remain authoritative. If the Manager is offline, read files only and report the deferred write. Never stage local runtime data.

## Public example Rabi

`examples/data/roles/Rabi/` teaches public users how the persona model works. Update it when the example contract, directory semantics, or a durable public-safe lesson changed.

Allowed:

- localhost endpoints;
- placeholders and fictional IDs;
- generic project lessons;
- sanitized plans and memories written as examples;
- public repository paths expressed relatively.

Forbidden:

- real QQ or device IDs;
- private chats, memories, plans, transcripts, or reference audio;
- cookies, tokens, secrets, private endpoints, or internal hosts;
- personal usernames, drive letters, UNC paths, or workstation layout;
- logs, receipts, and operational data copied from local runtime state.

Re-author safe examples; never mechanically copy private records.

## Validation matrix

| Scope | Suggested minimum |
|---|---|
| Markdown/docs only | focused link/text/config checks; `git diff --check` |
| TypeScript backend | focused tests; `npm run build:backend`; `npm run check:config` |
| Vue/WebGUI | focused tests; `npm run webgui:build` |
| Android/RabiLink | focused Gradle tests for the touched module plus applicable relay/backend checks |
| packaging/install | normal build plus `rabiroute-nas-windows-package` workflow |
| dependency change | production audit, full audit, lockfile review, install-script review |
| security boundary | `ai-code-security-review`, targeted negative tests, and semantic source-to-sink review |
| cross-cutting/release | `npm test`; `npm run check:config`; `npm run build`; package/install verification when claiming runtime acceptance |

Record commands actually run and distinguish failures, skipped checks, and unavailable environments.

## Commit and handoff evidence

Before commit:

```text
git status --short --branch
git diff --check
git diff --cached --stat
git diff --cached
```

After commit:

```text
git rev-parse HEAD
git show --stat --oneline HEAD
git status --short --branch
```

After push:

```text
git status --short --branch
git branch -vv
```

The final report must name the exact state reached. “Prepared,” “committed,” “pushed,” “packaged,” “installed,” and “released” are different claims.
