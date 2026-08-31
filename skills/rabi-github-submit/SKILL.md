---
name: rabi-github-submit
description: Prepares, reviews, commits, and publishes RabiRoute changes with a mandatory per-commit patch-version bump, bilingual version log, Rabi context, privacy, security, validation, and exact-commit evidence. Use when the user asks to prepare, commit, push, publish, release, or open a PR for RabiRoute.
---

# RabiRoute GitHub Submit

Use this skill with `github-submit-workflow` and `ai-code-security-review`; read both before changing submission state. A request to “prepare” does not authorize commit or push. A request to “commit” does not authorize push.

## Quick start

Run from any directory inside the RabiRoute repository:

```powershell
& "<skill-root>\scripts\Invoke-RabiSubmitPreflight.ps1" -Scope WorkingTree
```

Run again with `-Scope Staged` after staging and before committing. `Critical` or `High` findings, a missing exact patch bump, or an incomplete bilingual version entry block commit and publication.

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

### 3. Apply the mandatory per-commit version gate

Every commit created for RabiRoute must own a new repository patch version. There are no documentation-only, test-only, formatting-only, merge-resolution, internal-refactor, or skill-only exceptions.

1. Immediately before preparing a commit, read the strict `major.minor.patch` version from `HEAD:package.json`.
2. Set the candidate version to the same major and minor with patch incremented by exactly one. Do not skip a patch, reuse an earlier version, or choose a major/minor bump in this workflow.
3. Update all six required surfaces in the same commit:
   - `package.json`;
   - the root version and root-package version in `package-lock.json`;
   - the version badge and current-version statement in `README.md`;
   - the version badge and current-version statement in `README_zh.md`;
   - a new `## <version> - YYYY-MM-DD` section with at least one concrete bullet in `版本更新日志.md`;
   - the matching English section in `版本更新日志_en.md`.
4. Describe the actual staged diff in that version section. Do not leave the current commit only under `未发布` / `Unreleased`, and do not use a generic placeholder such as “update files.”
5. If one operation creates multiple commits, repeat the patch bump and bilingual version entry for every commit. One version cannot cover two commits.
6. Re-read `HEAD` after a rebase, merge, pull, or concurrent branch update and recompute the next patch before committing.

This rule identifies commits; it does not authorize or automatically create a Git tag, GitHub Release, installer, deployment, or local installation. Those remain separate actions.

### 4. Maintain Rabi context when warranted

- Inspect local `data/roles/Rabi/` only when the change affects Rabi’s durable project knowledge, boundaries, capabilities, plans, or recovery information.
- Use the Manager API for local Rabi plan/memory lifecycle writes. If Manager is unavailable, perform read-only inspection and report the missing update; do not imitate a successful write by editing runtime JSON directly.
- Inspect `examples/data/roles/Rabi/` when the public example contract or durable public-safe Rabi knowledge changed. Sanitize and rewrite lessons; never copy private runtime records.
- Avoid persona, plan, or memory churn when the post-change state is already accurate. Version and bilingual version-log updates are mandatory and are not optional churn.

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
4. Confirm that the staged version gate reports `HEAD -> exact patch + 1`, both changelogs contain the new version section, and all six version surfaces are staged.
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
