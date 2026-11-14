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

## Host, plugin and application version contract

The user's current plugin architecture decision replaces the former mandatory Host patch increment for every commit. Version the owner whose contract or implementation changed.

| Owner/change | Version and metadata |
|---|---|
| Host framework or extension point | Advance Host SemVer according to impact; patch, minor and major transitions are accepted. This architecture migration uses `0.7.0`. Synchronize root package/lock and both README versions. |
| Plugin source, web UI, resource, test or documentation | Advance that plugin’s authoritative version; a plugin-only change keeps the Host version. |
| Independently packaged application | A tracked `apps/<directory>/package.json` with a name and strict SemVer owns that application. Advance its version and synchronize an existing lock in the same scope; keep the Host version for application-only changes. Unowned application paths retain the Host rule. |
| New native plugin | Initial version `0.1.1`. |
| First legacy builtin source move | Accept exact old version → `0.1.1` only with the matching `package-migrations.json` declaration and original builtin identity. This exception is unavailable to an already canonical package or an external ecosystem. |
| Existing external plugin | Continue its published version sequence; never reset it to the native baseline. |
| Bilingual change record | Update both root change logs with concrete changes. Under an unchanged Host section, identify each changed plugin and its own new version. |

`plugins/source-catalog.json` records each canonical source folder and authoritative `versionFile`. Compare that authority against `HEAD`, including its original manifest when the current change moves the source. Synchronize other versioned root/hidden manifests and plugin lock root metadata; do not substitute a secondary package version for the authority.

The staged gate reads Git index objects for the catalog, version files, migration declarations and change records. Worktree-only version edits cannot repair an invalid staged plugin or application. A metadata mismatch, reused or lower published version, missing source owner, or Host framework change without a Host increase blocks submission. No override or skip switch is provided.

After rebase, merge, pull or upstream movement, re-read the original owner versions and re-evaluate the candidate. Source, Git commits, release tags, packages and installed runtime remain separate evidence.

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

## Exact review receipts

Use `Invoke-RabiSubmitPreflight.ps1 -Scope WorkingTree -ReviewReceipt <external-file.json> -Json` only after reviewing the actual input→sink boundary. Keep the receipt and its evidence outside the repository. Evidence paths are relative to the receipt directory, remain within that directory, and cannot traverse links. Evidence SHA256s are verified from actual files. Never place real secrets or source-line excerpts containing secrets in a receipt or public report.

The read-only helper `scripts/RabiSecurityReviewReceipt.ps1` exports `Get-RabiSecurityReviewContext`. Given the repository, exact scope/FailOn, latest raw `security` report and its `changedFiles`, it returns current binding metadata and `reported` candidate descriptors. Review those descriptors; add facts individually. The helper does not generate approval, choose dispositions or write receipts. The preflight independently recomputes the context when consuming a receipt. Keep inputs frozen during review and validation. Receipt JSON is limited to 1 MiB and each candidate to 32 evidence files; evidence content is streamed for hashing.

Receipt schema version 1:

```json
{
  "schemaVersion": 1,
  "repository": "<context.repository>",
  "repositoryId": "<context.repositoryId>",
  "baseHead": "<context.baseHead>",
  "scope": "Staged",
  "failOn": "High",
  "scopeHash": "<context.scopeHash>",
  "reviewer": "<review owner>",
  "reviewedAt": "<ISO timestamp>",
  "findings": [{
    "severity": "High",
    "rule": "<reported rule>",
    "file": "<reported canonical relative path>",
    "line": 1,
    "hunkHash": "<reported hunkHash>",
    "fileSha256": "<reported fileSha256>",
    "blobId": "<reported Git blobId>",
    "contentKind": "git-index-bytes-v1",
    "status": "closed",
    "disposition": "false_positive",
    "realVulnerability": false,
    "facts": { "input": "<actual source>", "sink": "<actual operation>", "boundary": "<verified trust boundary>", "verification": "<actual verification and limits>" },
    "evidence": [{ "path": "evidence/review.md", "sha256": "<actual evidence SHA256>" }]
  }]
}
```

Copy binding fields from the current context, not from another scope or an older scan. `repositoryId` binds the absolute Git root and Git directory; `baseHead` binds the current base. `scopeHash` binds the sorted complete changed-path/content set, including index identity in WorkingTree mode. A change outside the finding file also invalidates the operation receipt. A finding hunk is a numbered, LF-normalized source window containing the finding and two adjacent lines on either side; its hash is independent of the complete scoped file hash and Git blob ID.

`git-index-bytes-v1` reads `git show :path` as raw bytes and verifies the index blob ID. Unstaged bytes cannot repair or change a Staged decision. `worktree-bytes-v1` hashes all WorkingTree files as raw bytes and computes their corresponding Git blob IDs; it never claims to be index evidence. There is no text/binary extension guess or UTF-8-based file classification. Even a CRLF→LF change requires a new whole-file/scope binding, including legal UTF-8 binary files with or without NUL. Only the finding's display hunk decodes strict UTF-8 and normalizes CRLF for its separate context hash. Mixed staged/unstaged candidate byte snapshots require a separate Staged review rather than conflating them.

Only `closed` + `false_positive` or `verified_trusted_contract` + boolean `realVulnerability=false` can resolve exact High candidates. Missing facts/evidence, unknown dispositions, risk acceptance, malformed/duplicate/unmatched entries and path escapes block. Critical candidates remain unresolved. Every newly reported High remains blocking unless independently reviewed and included with its own exact binding. This is a local review attestation, not a cryptographic proof that the reviewer's factual claim is true; the independent review remains mandatory.

With a receipt, the additional `securityReview` object contains `reported`, `resolved`, `unresolved`, `rawPassed`, `effectivePassed`, `receiptValid`, the exact consumed `receiptSha256`, phase-only diagnostics and recomputed context. The original `security` object and FailOn are unchanged. The snapshot and receipt are rechecked after evidence validation. Invalid receipts fail closed even when the raw scan is clean; receipt processing cannot override path/workflow/version/diff gates. Never relabel a raw failed scan as passed. Refresh the receipt against the final index and rerun Staged immediately before an authorized commit. A successful effective check does not authorize Git operations or publication.

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
