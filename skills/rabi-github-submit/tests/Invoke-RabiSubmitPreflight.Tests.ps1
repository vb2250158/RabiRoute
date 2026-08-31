[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$skillRoot = Split-Path -Parent $PSScriptRoot
$preflight = Join-Path $skillRoot "scripts\Invoke-RabiSubmitPreflight.ps1"
$hostExecutable = (Get-Process -Id $PID).Path
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rabi-submit-preflight-tests-" + [Guid]::NewGuid().ToString("N"))
$passed = 0

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-Utf8File {
    param(
        [string]$Path,
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Invoke-Git {
    param(
        [string]$Repository,
        [string[]]$Arguments
    )

    $output = @(& git -C $Repository @Arguments 2>&1 | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return $output
}

function New-FixtureRepository {
    param([string]$Name)

    $repository = Join-Path $testRoot $Name
    [System.IO.Directory]::CreateDirectory((Join-Path $repository "src")) | Out-Null
    Invoke-Git -Repository $repository -Arguments @("init", "--initial-branch=main") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "user.name", "Rabi Submit Test") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "user.email", "rabi-submit-test@example.invalid") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "core.hooksPath", ".git/no-hooks") | Out-Null
    Write-Utf8File -Path (Join-Path $repository "package.json") -Content '{"name":"rabiroute","version":"0.2.0"}'
    Write-Utf8File -Path (Join-Path $repository "package-lock.json") -Content '{"name":"rabiroute","version":"0.2.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"rabiroute","version":"0.2.0"}}}'
    Write-Utf8File -Path (Join-Path $repository "README.md") -Content "![version](https://img.shields.io/badge/version-0.2.0-blue)`n`nThe repository version is ``0.2.0``.`n"
    Write-Utf8File -Path (Join-Path $repository "README_zh.md") -Content "![version](https://img.shields.io/badge/version-0.2.0-blue)`n`n仓库当前版本为 ``0.2.0``。`n"
    Write-Utf8File -Path (Join-Path $repository "版本更新日志.md") -Content "# 版本更新`n`n## 0.2.0 - 2026-08-28`n`n- 初始版本。`n"
    Write-Utf8File -Path (Join-Path $repository "版本更新日志_en.md") -Content "# Version history`n`n## 0.2.0 - 2026-08-28`n`n- Initial version.`n"
    Write-Utf8File -Path (Join-Path $repository "src\index.js") -Content "export const ready = true;`n"
    Invoke-Git -Repository $repository -Arguments @("add", ".") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("commit", "-m", "Create isolated fixture") | Out-Null
    return $repository
}

function Set-SubmissionVersion {
    param(
        [string]$Repository,
        [string]$Version = "0.2.1",
        [string]$ChineseSummary = "记录本次提交。",
        [string]$EnglishSummary = "Record this commit."
    )

    Write-Utf8File -Path (Join-Path $Repository "package.json") -Content "{`"name`":`"rabiroute`",`"version`":`"$Version`"}"
    Write-Utf8File -Path (Join-Path $Repository "package-lock.json") -Content "{`"name`":`"rabiroute`",`"version`":`"$Version`",`"lockfileVersion`":3,`"requires`":true,`"packages`":{`"`":{`"name`":`"rabiroute`",`"version`":`"$Version`"}}}"
    Write-Utf8File -Path (Join-Path $Repository "README.md") -Content "![version](https://img.shields.io/badge/version-$Version-blue)`n`nThe repository version is ``$Version``.`n"
    Write-Utf8File -Path (Join-Path $Repository "README_zh.md") -Content "![version](https://img.shields.io/badge/version-$Version-blue)`n`n仓库当前版本为 ``$Version``。`n"
    Write-Utf8File -Path (Join-Path $Repository "版本更新日志.md") -Content "# 版本更新`n`n## $Version - 2026-08-29`n`n- $ChineseSummary`n`n## 0.2.0 - 2026-08-28`n`n- 初始版本。`n"
    Write-Utf8File -Path (Join-Path $Repository "版本更新日志_en.md") -Content "# Version history`n`n## $Version - 2026-08-29`n`n- $EnglishSummary`n`n## 0.2.0 - 2026-08-28`n`n- Initial version.`n"
}

function Invoke-Preflight {
    param(
        [string]$Repository,
        [ValidateSet("WorkingTree", "Staged")]
        [string]$Scope = "WorkingTree",
        [ValidateSet("Info", "Low", "Medium", "High", "Critical")]
        [string]$FailOn = "High"
    )

    Push-Location $Repository
    try {
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $preflight,
            "-Scope", $Scope,
            "-FailOn", $FailOn,
            "-Json"
        )
        $output = @(& $hostExecutable @arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    $text = $output -join [Environment]::NewLine
    $report = $null
    try {
        $report = $text | ConvertFrom-Json
    } catch {
        throw "Preflight did not return JSON. Exit=$exitCode Output=$text"
    }

    return [pscustomobject]@{
        exitCode = $exitCode
        text = $text
        report = $report
    }
}

function Invoke-Test {
    param(
        [string]$Name,
        [scriptblock]$Body
    )

    & $Body
    $script:passed += 1
    Write-Output "[pass] $Name"
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null

    Invoke-Test "clean working tree passes and remote credentials are redacted" {
        $repo = New-FixtureRepository "clean"
        $remotePassword = "fixture-" + "remote-password"
        $querySecret = "fixture-" + "query-secret"
        Invoke-Git -Repository $repo -Arguments @(
            "remote", "add", "origin",
            "https://fixture-user:$remotePassword@example.invalid/repo.git?token=$querySecret"
        ) | Out-Null
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "Clean preflight should pass."
        Assert-True ($result.report.security.passed -eq $true) "Security report should pass."
        Assert-True ($result.text -notmatch [regex]::Escape($remotePassword)) "Remote password leaked into the report."
        Assert-True ($result.text -notmatch [regex]::Escape($querySecret)) "Remote query secret leaked into the report."
        Assert-True ($result.report.remotes[0].url -match "<redacted>") "Remote URL was not redacted."
    }

    Invoke-Test "every changed commit requires the complete patch-version surface" {
        $repo = New-FixtureRepository "missing-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        $result = Invoke-Preflight -Repository $repo
        $rules = @($result.report.versionGate.findings | ForEach-Object rule)
        Assert-True ($result.exitCode -eq 2) "A changed tree without a patch bump must block."
        Assert-True ($result.report.versionGate.passed -eq $false) "Version gate should record failure."
        Assert-True ($rules -contains "commit-patch-version-required") "Expected exact patch-version finding."
        Assert-True ($rules -contains "commit-version-file-missing") "Expected missing version-surface finding."
    }

    Invoke-Test "a complete exact patch bump and bilingual changelog passes" {
        $repo = New-FixtureRepository "valid-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "A fully versioned commit candidate should pass. Report: $($result.text)"
        Assert-True ($result.report.versionGate.passed -eq $true) "Version gate should pass."
        Assert-True ($result.report.versionGate.headVersion -eq "0.2.0") "Expected HEAD version evidence."
        Assert-True ($result.report.versionGate.expectedVersion -eq "0.2.1") "Expected next patch evidence."
        Assert-True ($result.report.versionGate.candidateVersion -eq "0.2.1") "Expected candidate version evidence."
    }

    Invoke-Test "staged version gate reads the index instead of unstaged files" {
        $repo = New-FixtureRepository "staged-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo
        Invoke-Git -Repository $repo -Arguments @("add", ".") | Out-Null
        Write-Utf8File -Path (Join-Path $repo "package.json") -Content '{"name":"rabiroute","version":"9.9.9"}'
        $result = Invoke-Preflight -Repository $repo -Scope Staged
        Assert-True ($result.exitCode -eq 0) "A valid staged candidate must not read an unstaged package version."
        Assert-True ($result.report.versionGate.candidateVersion -eq "0.2.1") "Staged scope should report the indexed version."
    }

    Invoke-Test "skipping a patch version blocks" {
        $repo = New-FixtureRepository "skipped-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo -Version "0.2.2"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "Skipping from 0.2.0 to 0.2.2 must block."
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "commit-patch-version-required").Count -eq 1) "Expected exact patch increment finding."
    }

    Invoke-Test "a version section without a descriptive bullet blocks" {
        $repo = New-FixtureRepository "empty-changelog"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo
        Write-Utf8File -Path (Join-Path $repo "版本更新日志_en.md") -Content "# Version history`n`n## 0.2.1 - 2026-08-29`n`n## 0.2.0 - 2026-08-28`n`n- Initial version.`n"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "An empty per-commit changelog section must block."
        Assert-True (@($result.report.versionGate.findings | Where-Object { $_.rule -eq "commit-changelog-entry-required" -and $_.file -eq "版本更新日志_en.md" }).Count -eq 1) "Expected English changelog finding."
    }

    Invoke-Test "security finding blocks while preserving structured evidence" {
        $repo = New-FixtureRepository "secret"
        $providerFixture = "sk-" + ("A" * 24)
        Write-Utf8File -Path (Join-Path $repo "src\credentials.js") -Content "export const credential = `"$providerFixture`";`n"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "A provider-token finding should block."
        Assert-True ($result.report.security.passed -eq $false) "Security report should record failure."
        Assert-True ($result.report.security.findings[0].rule -eq "secret-provider-token") "Expected provider-token evidence."
        Assert-True ($result.text -notmatch [regex]::Escape($providerFixture)) "Suspected secret value leaked into the report."
    }

    Invoke-Test "provider-token prefix is not matched inside an ordinary identifier" {
        $repo = New-FixtureRepository "provider-prefix-boundary"
        Write-Utf8File -Path (Join-Path $repo "src\task.js") -Content 'export const path = "task-completion-announcements";'
        Set-SubmissionVersion -Repository $repo
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "An embedded sk- substring should not block."
        Assert-True ($result.report.security.counts.Critical -eq 0) "An ordinary task identifier produced a Critical finding."
    }

    Invoke-Test "staged private path blocks even when ignored" {
        $repo = New-FixtureRepository "private-path"
        $privateFixture = "fixture-" + "private-value"
        Write-Utf8File -Path (Join-Path $repo ".env") -Content "PASSWORD=$privateFixture`n"
        Invoke-Git -Repository $repo -Arguments @("add", "-f", ".env") | Out-Null
        $result = Invoke-Preflight -Repository $repo -Scope Staged
        Assert-True ($result.exitCode -eq 2) "A staged .env file should block."
        Assert-True (@($result.report.pathFindings | Where-Object rule -eq "environment-file").Count -eq 1) "Expected environment-file finding."
        Assert-True ($result.text -notmatch [regex]::Escape($privateFixture)) "Private .env value leaked into the report."
    }

    Invoke-Test "working-tree and staged scopes remain isolated" {
        $repo = New-FixtureRepository "scope"
        Write-Utf8File -Path (Join-Path $repo "src\dynamic.js") -Content "export const run = (input) => eval(input);`n"
        $working = Invoke-Preflight -Repository $repo -Scope WorkingTree -FailOn Medium
        $staged = Invoke-Preflight -Repository $repo -Scope Staged -FailOn Medium
        Assert-True ($working.exitCode -eq 2) "Working-tree scope should see the untracked dynamic execution."
        Assert-True ($staged.exitCode -eq 0) "Staged scope should ignore the untracked file."
        Assert-True ($staged.report.changedFiles.Count -eq 0) "Staged report should have no changed files."
    }

    Invoke-Test "diff diagnostics never echo the offending source line" {
        $repo = New-FixtureRepository "diff-check"
        $lineFixture = "fixture-" + "line-secret"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const value = `"$lineFixture`";   `n"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "Trailing whitespace should block."
        Assert-True ($result.report.diffCheck.passed -eq $false) "Diff check should record failure."
        Assert-True ($result.text -notmatch [regex]::Escape($lineFixture)) "Diff diagnostic leaked the offending line."
    }

    Invoke-Test "explicit placeholders are not treated as literal secrets" {
        $repo = New-FixtureRepository "placeholder"
        Write-Utf8File -Path (Join-Path $repo "src\example.js") -Content 'export const api_key = "<your-api-key-here>";'
        Set-SubmissionVersion -Repository $repo
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "A documented placeholder should not block."
        Assert-True ($result.report.security.counts.High -eq 0) "Placeholder produced a High finding."
    }

    Invoke-Test "mutable actions and privileged pull-request triggers are blocked" {
        $repo = New-FixtureRepository "workflow-boundary"
        $workflow = @"
name: Unsafe fixture
on:
  pull_request_target:
jobs:
  inspect:
    permissions: write-all
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: true
"@
        Write-Utf8File -Path (Join-Path $repo ".github\workflows\unsafe.yml") -Content $workflow
        $result = Invoke-Preflight -Repository $repo
        $rules = @($result.report.workflowFindings | ForEach-Object rule)
        Assert-True ($result.exitCode -eq 2) "Unsafe workflow boundaries should block."
        Assert-True ($rules -contains "workflow-privileged-pr-trigger") "Expected pull_request_target finding."
        Assert-True ($rules -contains "workflow-write-all") "Expected write-all finding."
        Assert-True ($rules -contains "workflow-unpinned-action") "Expected unpinned-action finding."
        Assert-True ($rules -contains "workflow-persistent-checkout-credentials") "Expected checkout-credential finding."
    }

    Write-Output "All $passed RabiRoute submit preflight tests passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $leaf = Split-Path -Leaf $resolvedTestRoot
        if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not $leaf.StartsWith("rabi-submit-preflight-tests-", [System.StringComparison]::Ordinal)) {
            throw "Refusing to remove unexpected test path: $resolvedTestRoot"
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

exit 0
