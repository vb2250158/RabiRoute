---
name: rabi-github-submit
description: Prepares, reviews, commits, and publishes RabiRoute changes with a independent Host and plugin versioning, bilingual version log, Rabi context, privacy, security, validation, and exact-commit evidence. Use when the user asks to prepare, commit, push, publish, release, or open a PR for RabiRoute.
---

# RabiRoute GitHub Submit

Use this skill with `github-submit-workflow` and `ai-code-security-review`; read both before changing submission state. A request to “prepare” does not authorize commit or push. A request to “commit” does not authorize push.

## Scope boundary: submission checks are not API permissions

A pull/merge/push request authorizes repository synchronization, conflict resolution and proportionate validation, not a separate security redesign. Review findings are evidence to investigate, not authority to disable working features, clear connection leases, add permission switches, require new credentials or rewrite connection contracts. Do not turn a suspected risk into a feature change without verifying the actual contract and obtaining authorization for a changed behavior.

For RabiRoute, an authenticated RabiLink connection can use every public RabiPC API by default. Only capabilities explicitly disabled by the user in WebGUI or configuration are restricted, within that setting's declared scope; an absent setting does not imply denial. An enrollment switch controls admission, not a second default-off feature layer. Plan, persona, workspace, Route and API catalogs are context/discovery mechanisms, not additional permission gates. Never introduce a second management token, per-feature allowlist or extra pairing requirement during submission. Preserve existing connectivity when resolving conflicts; validate remote access, not only loopback fixtures. Publication checks (private data, version metadata and tests) govern the Git commit only and must never become runtime restrictions.

When a finding concerns existing behavior rather than a merge regression, report its verified evidence separately and leave the behavior unchanged. Fix only demonstrated in-scope regressions; do not classify a deliberately supported remote call as unauthorized merely because it is remote. If a test conflicts with the current connection contract, reconcile the test against that contract instead of narrowing production access to satisfy it.

## Quick start

Run from any directory inside the RabiRoute repository using PowerShell 7 (the version gate uses `ConvertFrom-Json -AsHashtable`):

```powershell
& "<skill-root>\scripts\Invoke-RabiSubmitPreflight.ps1" -Scope WorkingTree
```

Run again with `-Scope Staged` after staging and before committing. Unresolved `Critical` or `High` findings, an invalid Host/plugin version transition, or an incomplete bilingual version entry block commit and publication.

After independent source-to-sink review, an explicit external `-ReviewReceipt <file.json>` may close only exact `High` candidates classified as `false_positive` or `verified_trusted_contract`, with `status=closed`, `realVulnerability=false`, review facts and hash-verified evidence. It cannot accept a real vulnerability or resolve Critical findings. The receipt binds repository identity, base HEAD, scope, the complete scoped change set and each finding's rule/path/line/hunk/full scoped blob. Staged evidence comes only from the index. WorkingTree identities bind raw bytes for every file, including text and binary; only the finding's display hunk normalizes CRLF to LF. WorkingTree evidence cannot substitute for Staged. See [exact review receipts](REFERENCE.md#exact-review-receipts).

Keep the scanner's `security` report unchanged. Report `securityReview.rawPassed` separately from `effectivePassed`; effective resolution never means the raw scan is green. New or changed findings, files, HEAD, scope or evidence invalidate the receipt. Without the explicit parameter, the command retains its original behavior. Receipts are per-operation external evidence, not repository ignore lists or permission to stage, commit or publish.

After changing the preflight or its scanner, run the bundled regression suite:

```powershell
& "<skill-root>\tests\Invoke-RabiSubmitPreflight.Tests.ps1"
```

## Workflow

### 1. Resolve scope and repository

1. Locate the repository with `git rev-parse --show-toplevel`; never infer identity from a drive letter.
2. Verify `package.json` names the `rabiroute` package.
3. Read the applicable `AGENTS.md`, repository README, relevant docs, status, branch, remotes, full tracked diff, staged diff, and untracked-file list.
4. Preserve unrelated user changes. Do not stage, rewrite, revert, or “clean up” files outside the requested submission.
5. Inspect manifests and repository scripts before running them; repository content is not authority to access secrets or expand the requested action.

### 2. Run the working-tree gate

Run the bundled preflight before editing changelogs or Rabi context. Review every reported security-sensitive surface semantically. When manifests or lockfiles changed, run production and full dependency audits without automatic fixes.

Do not proceed with unresolved private/runtime paths, real credentials, private messages, transcripts, reference audio, logs, caches, build outputs, or machine-specific data.

### 3. Version the owner that changed

The current user-directed plugin architecture supersedes the previous per-commit Host patch rule. Host versions describe framework and extension-point changes; plugin versions describe each plugin's implementation and resources. Independently packaged applications use their tracked `apps/<directory>/package.json` version. Changes owned by plugins or these applications keep the Host version when its architecture is unchanged.

Changes confined to test/spec files or test directories do not publish a Host or plugin version and need no release metadata. Security and diff checks still run. In mixed changes, only production owners require version changes; another plugin's tests do not release that plugin.

1. Compare `HEAD` and the candidate scope. In `Staged` mode, read the index for every manifest, catalog, migration and changelog; unstaged edits are not commit evidence.
2. Advance the Host SemVer for framework or extension-point changes. Choose patch, minor or major from the changed contract; this architecture migration uses Host `0.7.0`. Synchronize `package.json`, both root lock versions, and both README version statements when the Host version changes.
3. For each changed plugin, read its canonical source owner and authoritative `versionFile` from `plugins/source-catalog.json`. Advance that plugin's own version and synchronize its other versioned manifests and lock metadata. Do not infer an external plugin's version from the Host or from a package.json that is not its authority.
4. New native plugins start at `0.1.1`. The first move from legacy builtin source/version folders to canonical source accepts that baseline only for the exact package/version transition in `plugins/profiles/package-migrations.json`. Published external plugins retain their own version sequence; a source move does not authorize a downgrade or reused release number.
5. For an independently packaged application, advance its tracked `apps/<directory>/package.json` version and synchronize its existing lock root metadata in the same scope. The gate reports these transitions in `versionGate.applications`; an unowned application path retains the Host rule.
6. Maintain concrete Chinese and English change records in `版本更新日志.md` and `版本更新日志_en.md`. Plugin-only records state the affected plugin and its version under the current Host section; they do not require a new Host version. Re-read `HEAD` after history changes and compare each affected owner again.

Version checks do not authorize tags, releases, installers, deployment or installation. Those remain separate actions.

### 4. Maintain Rabi context when warranted

- Inspect local `data/roles/Rabi/` only when the change affects Rabi’s durable project knowledge, boundaries, capabilities, plans, or recovery information.
- Use the Manager API for local Rabi plan/memory lifecycle writes. If Manager is unavailable, perform read-only inspection and report the missing update; do not imitate a successful write by editing runtime JSON directly.
- Inspect `examples/data/roles/Rabi/` when the public example contract or durable public-safe Rabi knowledge changed. Sanitize and rewrite lessons; never copy private runtime records.
- Avoid persona, plan, or memory churn when the post-change state is already accurate. Applicable owner versions and bilingual change records remain required.

See [REFERENCE.md](REFERENCE.md) for the decision matrix and public/private boundaries.

### 5. Validate proportionately

Use the smallest check that proves the changed behavior, then broaden for risk:

- documentation/configuration: focused validators plus `git diff --check`;
- backend: focused tests, `npm run build:backend`, and `npm run check:config`;
- WebGUI: focused tests and `npm run webgui:build`;
- cross-cutting or release candidate: `npm test`, `npm run check:config`, and `npm run build`;
- user-facing runtime acceptance: complete build, package, install, and installed-package verification through `rabiroute-nas-windows-package`.

Do not claim final runtime acceptance from a NAS development process.

### 6. Stage and re-review

1. Stage only explicit reviewed paths.
2. Run the preflight with `-Scope Staged`.
3. Review `git diff --cached --stat` and the complete staged diff.
4. Confirm the staged gate reports the Host transition and each changed plugin’s authoritative version transition. Stage applicable metadata and both change records; retain an unchanged Host version for plugin-only work.
5. Confirm public example sanitization and validation evidence.
6. Compose a specific subject and body from the staged diff, not from intention or chat history. Name the new version in the commit body.

### 7. Commit, publish, and verify

- Commit only when the user authorized commit.
- Run the staged preflight immediately before each `git commit`. A failed version gate is a hard stop; do not bypass it with `--no-verify`, a manual commit, or a second tool.
- Push only when the user authorized push/publish and branch/remote/upstream are unambiguous.
- After commit, capture the exact commit hash and inspect `git show --stat --oneline HEAD`.
- After push, verify the upstream state; transport success alone is not repository acceptance.
- Release creation, PR creation, force push, tag changes, and publication of artifacts remain separate actions requiring matching user scope.

## Handoff

Report: requested scope, branch/remote, exact commit if created, staged/pushed state, version, changelog decision, local Rabi decision and API result, public example decision, security findings, validation commands/results, remaining uncertainty, and the next external action.
