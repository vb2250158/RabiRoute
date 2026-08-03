<!-- docs-language-switch -->
<div align="center">
English | <a href="./maintainer-security-gates.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Pull Request Security Gates

> Status: current maintainer guide. The gates are defined in `.github/workflows/pull-request-security.yml`.

Pull requests targeting `main` run three independent security checks:

| Check | Blocking condition | Boundary |
| --- | --- | --- |
| Secret scan (Gitleaks) | Suspected credentials appear in commit history | Rotate a real credential first; deleting it only from the latest tree does not undo exposure |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` finds a High or Critical production vulnerability | Development-only advisories do not become release blockers, and CI never runs `npm audit fix` |
| SAST (CodeQL) | The default JavaScript / TypeScript security queries report a blocking issue | Results enter GitHub Code Scanning; authentication, paths, processes, networking, and Agent-tool boundaries still require human review |

Maintainers can also dispatch the workflow manually. The jobs are independent so one run exposes the complete failure surface instead of revealing checks sequentially.

## Workflow trust boundary

- The workflow uses `pull_request`, never the higher-privilege `pull_request_target` event for contributor code.
- The default `GITHUB_TOKEN` has only `contents: read`. Only the CodeQL job adds `security-events: write` and `actions: read`.
- Checkout does not persist credentials.
- GitHub and third-party actions are pinned to full commit SHAs so a movable tag cannot change executed code without review.
- Pull requests do not install dependencies or run repository builds, install scripts, or tests in this workflow. The dependency gate reads the lockfile and queries npm advisories.
- Gitleaks PR comments and report-artifact uploads are disabled to reduce write access and sensitive-report retention. The failed job still keeps its run summary.

## Merge protection

After this workflow is committed and has completed successfully on GitHub, require these checks in the `main` branch protection rule or ruleset:

- `Secret scan (Gitleaks)`
- `Production dependency audit`
- `SAST (CodeQL)`

A workflow file alone does not prevent merging; required-check enforcement belongs to the GitHub repository settings. Review changes to this workflow, ignore rules, or action SHAs as security-boundary changes.

## Handling failures

1. Identify the affected commit and file without copying suspected values into issues, pull-request comments, or chat.
2. For a secret finding, revoke or rotate the credential before cleaning Git history. Hiding a log cannot recover an exposed credential.
3. For a dependency finding, inspect the production dependency chain, make a controlled upgrade, and review the lockfile. Do not auto-fix in CI.
4. For a CodeQL finding, trace untrusted input to the privileged sink, add a fix and negative test, then rerun the gates.
5. For a confirmed false positive, record the narrow scope, rule ID, rationale, and reviewer. Never add a broad path exclusion.

These gates are release prefilters. They do not replace human review, normal tests, builds, configuration validation, package-content inspection, or installed-runtime acceptance.
