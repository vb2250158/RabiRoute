[CmdletBinding()]
param([switch]$ReceiptOnly, [string]$TestNamePattern)

$ErrorActionPreference = "Stop"

$skillRoot = Split-Path -Parent $PSScriptRoot
$preflight = Join-Path $skillRoot "scripts\Invoke-RabiSubmitPreflight.ps1"
. (Join-Path $skillRoot "scripts\RabiSecurityReviewReceipt.ps1")
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
    param([string]$Name, [switch]$LegacyPlugins)

    $repository = Join-Path $testRoot $Name
    [System.IO.Directory]::CreateDirectory((Join-Path $repository "src")) | Out-Null
    Invoke-Git -Repository $repository -Arguments @("init", "--initial-branch=main") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "user.name", "Rabi Submit Test") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "user.email", "rabi-submit-test@example.invalid") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "core.hooksPath", ".git/no-hooks") | Out-Null
    Invoke-Git -Repository $repository -Arguments @("config", "core.autocrlf", "false") | Out-Null
    Write-Utf8File -Path (Join-Path $repository "package.json") -Content '{"name":"rabiroute","version":"0.2.0"}'
    Write-Utf8File -Path (Join-Path $repository "package-lock.json") -Content '{"name":"rabiroute","version":"0.2.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"rabiroute","version":"0.2.0"}}}'
    Write-Utf8File -Path (Join-Path $repository "README.md") -Content "![version](https://img.shields.io/badge/version-0.2.0-blue)`n`nThe repository version is ``0.2.0``.`n"
    Write-Utf8File -Path (Join-Path $repository "README_zh.md") -Content "![version](https://img.shields.io/badge/version-0.2.0-blue)`n`n仓库当前版本为 ``0.2.0``。`n"
    Write-Utf8File -Path (Join-Path $repository "版本更新日志.md") -Content "# 版本更新`n`n## 0.2.0 - 2026-08-28`n`n- 初始版本。`n"
    Write-Utf8File -Path (Join-Path $repository "版本更新日志_en.md") -Content "# Version history`n`n## 0.2.0 - 2026-08-28`n`n- Initial version.`n"
    Write-Utf8File -Path (Join-Path $repository "src\index.js") -Content "export const ready = true;`n"
    if ($LegacyPlugins) {
        Write-Utf8File -Path (Join-Path $repository "plugins/builtin/io.rabiroute.endpoint.fixture/1.0.0/rabi.plugin.json") -Content '{"id":"io.rabiroute.endpoint.fixture","version":"1.0.0"}'
        Write-Utf8File -Path (Join-Path $repository "plugins/external-fixture/package.json") -Content '{"name":"external-fixture","version":"0.4.0"}'
    } else {
        Write-Utf8File -Path (Join-Path $repository "plugins/source-catalog.json") -Content '{"schemaVersion":1,"plugins":[{"sourceId":"io.rabiroute.endpoint.fixture","directory":"src/plugins/io.rabiroute.endpoint.fixture","ecosystem":"rabiroute","publicationName":"io.rabiroute.endpoint.fixture","versionFile":"rabi.plugin.json"},{"sourceId":"external-fixture","directory":"src/plugins/external-fixture","ecosystem":"integration","publicationName":"external-fixture","versionFile":"package.json"}]}'
        Write-Utf8File -Path (Join-Path $repository "src/plugins/io.rabiroute.endpoint.fixture/rabi.plugin.json") -Content '{"id":"io.rabiroute.endpoint.fixture","version":"0.1.1"}'
        Write-Utf8File -Path (Join-Path $repository "src/plugins/io.rabiroute.endpoint.fixture/package.json") -Content '{"name":"io.rabiroute.endpoint.fixture","version":"0.1.1"}'
        Write-Utf8File -Path (Join-Path $repository "src/plugins/io.rabiroute.endpoint.fixture/feature.js") -Content "export const value = 1;`n"
        Write-Utf8File -Path (Join-Path $repository "src/plugins/external-fixture/package.json") -Content '{"name":"external-fixture","version":"0.4.0"}'
    }
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

function Set-PluginSubmission {
    param([string]$Repository, [string]$Version = "0.1.2")
    Write-Utf8File -Path (Join-Path $Repository "src/plugins/io.rabiroute.endpoint.fixture/rabi.plugin.json") -Content "{`"id`":`"io.rabiroute.endpoint.fixture`",`"version`":`"$Version`"}"
    Write-Utf8File -Path (Join-Path $Repository "src/plugins/io.rabiroute.endpoint.fixture/package.json") -Content "{`"name`":`"io.rabiroute.endpoint.fixture`",`"version`":`"$Version`"}"
    Write-Utf8File -Path (Join-Path $Repository "src/plugins/io.rabiroute.endpoint.fixture/feature.js") -Content "export const value = 2;`n"
    Write-Utf8File -Path (Join-Path $Repository "版本更新日志.md") -Content "# 版本更新`n`n## 0.2.0 - 2026-11-05`n`n- 更新 io.rabiroute.endpoint.fixture $Version 的消息处理。`n"
    Write-Utf8File -Path (Join-Path $Repository "版本更新日志_en.md") -Content "# Version history`n`n## 0.2.0 - 2026-11-05`n`n- Update message processing in io.rabiroute.endpoint.fixture $Version.`n"
}

function Invoke-Preflight {
    param(
        [string]$Repository,
        [ValidateSet("WorkingTree", "Staged")]
        [string]$Scope = "WorkingTree",
        [ValidateSet("Info", "Low", "Medium", "High", "Critical")]
        [string]$FailOn = "High",
        [string]$ReviewReceipt
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
        if ($ReviewReceipt) { $arguments += @("-ReviewReceipt", $ReviewReceipt) }
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

    if ($TestNamePattern -and $Name -notmatch $TestNamePattern) { return }
    & $Body
    $script:passed += 1
    Write-Output "[pass] $Name"
}

function Save-ReviewReceipt {
    param($Fixture)
    Write-Utf8File $Fixture.receiptPath ($Fixture.receipt | ConvertTo-Json -Depth 12)
}

function New-ReviewReceiptFixture {
    param([string]$Name, [string]$Scope = "WorkingTree", [switch]$CrLf, [switch]$WithBinary)
    $repo = New-FixtureRepository $Name
    Invoke-Git $repo @("config", "core.autocrlf", "false") | Out-Null
    Invoke-Git $repo @("config", "core.whitespace", "cr-at-eol") | Out-Null
    Set-SubmissionVersion $repo
    $source = "// UTF-8 scoped fixture`nconst child = spawn(command, [], { shell: true });`n"
    if ($CrLf) { $source = $source.Replace("`n", "`r`n") }
    Write-Utf8File (Join-Path $repo "src/review.test.js") $source
    if ($WithBinary) {
        [IO.Directory]::CreateDirectory((Join-Path $repo 'assets')) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $repo 'assets/icon.bin'), [byte[]]@(137, 80, 78, 71, 255, 0))
        Write-Utf8File (Join-Path $repo 'git.exe') "This repository file must never shadow the installed Git executable."
    }
    if ($Scope -eq "Staged") { Invoke-Git $repo @("add", ".") | Out-Null }
    $raw = Invoke-Preflight $repo -Scope $Scope
    Assert-True ($raw.exitCode -eq 2 -and $raw.report.security.counts.High -eq 1) "Fixture must produce one actual raw High: $($raw.text)"
    $context = Get-RabiSecurityReviewContext $repo $Scope "High" $raw.report.security $raw.report.changedFiles
    $directory = Join-Path $testRoot ($Name + "-evidence")
    $proof = Join-Path $directory "review.md"
    Write-Utf8File $proof "Controlled regression: repository-owned synthetic command; no message chooses executable code."
    $entry = $context.reported[0] | ConvertTo-Json | ConvertFrom-Json
    $entry | Add-Member status "closed"
    $entry | Add-Member disposition "false_positive"
    $entry | Add-Member realVulnerability $false
    $entry | Add-Member facts ([pscustomobject]@{ input = "Repository-owned test command"; sink = "Synthetic shell launch fixture"; boundary = "No untrusted message selects the command"; verification = "This isolated repository is scanned through the actual preflight" })
    $entry | Add-Member evidence @([pscustomobject]@{ path = "review.md"; sha256 = (Get-FileHash $proof -Algorithm SHA256).Hash.ToLowerInvariant() })
    $receipt = [pscustomobject]@{ schemaVersion = 1; repository = $context.repository; repositoryId = $context.repositoryId; baseHead = $context.baseHead
        scope = $Scope; failOn = "High"; scopeHash = $context.scopeHash; reviewer = "isolated-regression"; reviewedAt = "2026-11-05T09:00:00Z"; findings = @($entry) }
    $fixture = [pscustomobject]@{ repo = $repo; raw = $raw; context = $context; receipt = $receipt; receiptPath = (Join-Path $directory "receipt.json"); proof = $proof }
    Save-ReviewReceipt $fixture
    return $fixture
}

function Update-ReviewReceiptBinding {
    param($Fixture, [string]$Scope = "WorkingTree", [string]$FailOn = "High")
    $raw = Invoke-Preflight $Fixture.repo -Scope $Scope -FailOn $FailOn
    $context = Get-RabiSecurityReviewContext $Fixture.repo $Scope $FailOn $raw.report.security $raw.report.changedFiles
    foreach ($field in @('repository', 'repositoryId', 'baseHead', 'scope', 'failOn', 'scopeHash')) { $Fixture.receipt.$field = $context.$field }
    foreach ($field in @('severity', 'rule', 'file', 'line', 'hunkHash', 'fileSha256', 'blobId', 'contentKind')) { $Fixture.receipt.findings[0].$field = $context.reported[0].$field }
    Save-ReviewReceipt $Fixture
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null

    if (-not $ReceiptOnly) {
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

    Invoke-Test "Host source changes require an advanced Host version and complete metadata" {
        $repo = New-FixtureRepository "missing-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        $result = Invoke-Preflight -Repository $repo
        $rules = @($result.report.versionGate.findings | ForEach-Object rule)
        Assert-True ($result.exitCode -eq 2) "A Host source change without a Host version increase must block."
        Assert-True ($result.report.versionGate.passed -eq $false) "Version gate should record failure."
        Assert-True ($rules -contains "commit-host-version-required") "Expected Host-version transition finding."
        Assert-True ($rules -contains "commit-version-file-missing") "Expected missing version-surface finding."
    }

    Invoke-Test "a Host patch upgrade and bilingual changelog pass" {
        $repo = New-FixtureRepository "valid-version"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "A fully versioned commit candidate should pass. Report: $($result.text)"
        Assert-True ($result.report.versionGate.passed -eq $true) "Version gate should pass."
        Assert-True ($result.report.versionGate.headVersion -eq "0.2.0") "Expected HEAD version evidence."
        Assert-True ($result.report.versionGate.hostVersionRequired -eq $true) "Expected Host architecture scope evidence."
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

    Invoke-Test "a Host architecture minor upgrade is accepted with synchronized metadata" {
        $repo = New-FixtureRepository "host-minor"
        Write-Utf8File -Path (Join-Path $repo "src/index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo -Version "0.7.0"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 0) "A semantic Host minor upgrade should pass: $($result.text)"
        Assert-True ($result.report.versionGate.candidateVersion -eq "0.7.0") "Expected the actual candidate Host version."
    }

    Invoke-Test "a Host downgrade is rejected" {
        $repo = New-FixtureRepository "host-downgrade"
        Set-SubmissionVersion -Repository $repo -Version "0.1.9"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "Host downgrade must block."
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "commit-host-version-downgrade").Count -eq 1) "Expected Host downgrade evidence."
    }

    Invoke-Test "a version section without a descriptive bullet blocks" {
        $repo = New-FixtureRepository "empty-changelog"
        Write-Utf8File -Path (Join-Path $repo "src\index.js") -Content "export const ready = false;`n"
        Set-SubmissionVersion -Repository $repo
        Write-Utf8File -Path (Join-Path $repo "版本更新日志_en.md") -Content "# Version history`n`n## 0.2.1 - 2026-08-29`n`n## 0.2.0 - 2026-08-28`n`n- Initial version.`n"
        $result = Invoke-Preflight -Repository $repo
        Assert-True ($result.exitCode -eq 2) "An empty change record must block."
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

    Invoke-Test "plugin-only changes advance their authority while the Host remains unchanged" {
        $repo = New-FixtureRepository "plugin-only"
        Set-PluginSubmission $repo
        Invoke-Git $repo @("add", ".") | Out-Null
        $result = Invoke-Preflight $repo -Scope Staged
        Assert-True ($result.exitCode -eq 0) "Plugin-only staged change should pass: $($result.text)"
        Assert-True (-not $result.report.versionGate.hostVersionRequired) "Plugin implementation must not force a Host patch."
        Assert-True ($result.report.versionGate.headVersion -eq $result.report.versionGate.candidateVersion) "Host version should remain unchanged."
        Assert-True ($result.report.versionGate.plugins[0].candidateVersion -eq "0.1.2") "Expected the authoritative plugin version."
    }

    Invoke-Test "test-only paths do not force a Host version for plugin changes in either scope" {
        foreach ($scope in @('WorkingTree', 'Staged')) {
            $repo = New-FixtureRepository ("plugin-test-only-" + $scope)
            Set-PluginSubmission $repo
            Write-Utf8File (Join-Path $repo 'ribiwebgui/tests/plugin-forward.test.ts') 'export const assertion = true;'
            Write-Utf8File (Join-Path $repo 'src/query.spec.ts') 'export const assertion = true;'
            if ($scope -eq 'Staged') { Invoke-Git $repo @('add', '.') | Out-Null }
            $result = Invoke-Preflight $repo -Scope $scope
            Assert-True ($result.exitCode -eq 0) "Test coverage must not force an unrelated Host release: $($result.text)"
            Assert-True (-not $result.report.versionGate.hostVersionRequired) "Only the changed production plugin advances."
            Assert-True ($result.report.packageVersion -eq '0.2.0') "Host version stays unchanged."
        }
    }

    Invoke-Test "pure validation changes require no Host or plugin release in either scope" {
        foreach ($scope in @('WorkingTree', 'Staged')) {
            $repo = New-FixtureRepository ("validation-only-" + $scope)
            Write-Utf8File (Join-Path $repo 'src/plugins/io.rabiroute.endpoint.fixture/src/image.test.ts') 'export const assertion = true;'
            Write-Utf8File (Join-Path $repo 'src/query.spec.ts') 'export const assertion = true;'
            Write-Utf8File (Join-Path $repo 'src/plugins/external-fixture/tests/fixtures/provider.mjs') 'export const fixture = true;'
            if ($scope -eq 'Staged') { Invoke-Git $repo @('add', '.') | Out-Null }
            $result = Invoke-Preflight $repo -Scope $scope
            Assert-True ($result.exitCode -eq 0) "Validation-only changes must not require unrelated release metadata: $($result.text)"
            Assert-True (-not $result.report.versionGate.applicable) "A validation-only scope does not release product code."
            Assert-True ($result.report.security.passed) "Security screening still runs for validation-only files."
        }
    }

    Invoke-Test "validation files never hide adjacent plugin production changes" {
        foreach ($scope in @('WorkingTree', 'Staged')) {
            $repo = New-FixtureRepository ("validation-and-plugin-" + $scope)
            Write-Utf8File (Join-Path $repo 'src/plugins/io.rabiroute.endpoint.fixture/src/image.test.ts') 'export const assertion = true;'
            Write-Utf8File (Join-Path $repo 'src/plugins/io.rabiroute.endpoint.fixture/feature.js') 'export const value = 2;'
            if ($scope -eq 'Staged') { Invoke-Git $repo @('add', '.') | Out-Null }
            $result = Invoke-Preflight $repo -Scope $scope
            Assert-True ($result.exitCode -eq 2) "Production implementation still needs its own version."
            Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq 'plugin-version-increase-required').Count -eq 1) "Keep the exact product-version diagnostic."
        }
    }

    Invoke-Test "renaming production code to a test keeps its production version owner" {
        foreach ($scope in @('WorkingTree', 'Staged')) {
            $repo = New-FixtureRepository ("production-test-rename-" + $scope)
            Invoke-Git $repo @('mv', 'src/plugins/io.rabiroute.endpoint.fixture/feature.js', 'src/plugins/io.rabiroute.endpoint.fixture/feature.test.js') | Out-Null
            $result = Invoke-Preflight $repo -Scope $scope
            Assert-True ($result.exitCode -eq 2 -and $result.report.versionGate.applicable) "The original production deletion remains a product change."
            Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq 'plugin-version-increase-required').Count -eq 1) "Both sides of a rename retain the production version requirement."
        }
    }

    Invoke-Test "another plugin's tests do not require that plugin to advance" {
        $repo = New-FixtureRepository 'validation-other-plugin'
        Set-PluginSubmission $repo
        Write-Utf8File (Join-Path $repo 'src/plugins/external-fixture/feature.test.ts') 'export const assertion = true;'
        $result = Invoke-Preflight $repo
        Assert-True ($result.exitCode -eq 0) "Only the changed production owner advances: $($result.text)"
        Assert-True (@($result.report.versionGate.plugins).Count -eq 1) "Do not release the external plugin for its test alone."
    }

    Invoke-Test "test-only helpers do not force a Host version for plugin changes" {
        $repo = New-FixtureRepository 'plugin-test-fixture'
        Set-PluginSubmission $repo
        Write-Utf8File (Join-Path $repo 'ribiwebgui/tests/fixtures/module-loader.mjs') 'export const fixture = true;'
        $result = Invoke-Preflight $repo
        Assert-True ($result.exitCode -eq 0 -and -not $result.report.versionGate.hostVersionRequired) "Test fixture helpers are validation, not Host production."
    }

    Invoke-Test "test-only exemptions never hide accompanying Host production changes" {
        $repo = New-FixtureRepository 'plugin-test-and-host'
        Set-PluginSubmission $repo
        Write-Utf8File (Join-Path $repo 'ribiwebgui/tests/forward.test.ts') 'export const assertion = true;'
        Write-Utf8File (Join-Path $repo 'src/index.js') 'export const ready = false;'
        $result = Invoke-Preflight $repo
        Assert-True ($result.exitCode -eq 2 -and $result.report.versionGate.hostVersionRequired) "Actual Host source changes still require the Host version."
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq 'commit-host-version-required').Count -eq 1) "Retain the original Host version diagnostic."
    }

    Invoke-Test "changed plugin code with no own version increase is rejected" {
        $repo = New-FixtureRepository "plugin-no-bump"
        Set-PluginSubmission $repo -Version "0.1.1"
        $result = Invoke-Preflight $repo
        Assert-True ($result.exitCode -eq 2) "Reusing a plugin version must block."
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-version-increase-required").Count -eq 1) "Expected plugin version evidence."
    }

    Invoke-Test "plugin metadata mismatch and published downgrade are rejected" {
        $repo = New-FixtureRepository "plugin-metadata"
        Set-PluginSubmission $repo
        Write-Utf8File (Join-Path $repo "src/plugins/io.rabiroute.endpoint.fixture/package.json") '{"name":"io.rabiroute.endpoint.fixture","version":"0.1.3"}'
        $result = Invoke-Preflight $repo
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-version-metadata-mismatch").Count -eq 1) "Secondary metadata must match the authority."
        Set-PluginSubmission $repo -Version "0.1.0"
        $result = Invoke-Preflight $repo
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-version-increase-required").Count -eq 1) "Published plugin downgrade must block."
    }

    Invoke-Test "staged plugin authority ignores a conflicting unstaged manifest" {
        $repo = New-FixtureRepository "plugin-index-valid"
        Set-PluginSubmission $repo
        Invoke-Git $repo @("add", ".") | Out-Null
        Write-Utf8File (Join-Path $repo "src/plugins/io.rabiroute.endpoint.fixture/rabi.plugin.json") '{"id":"io.rabiroute.endpoint.fixture","version":"9.9.9"}'
        Write-Utf8File (Join-Path $repo "plugins/source-catalog.json") '{"schemaVersion":1,"plugins":[]}'
        Write-Utf8File (Join-Path $repo "package.json") '{"name":"unstaged-other-project","version":"9.9.9"}'
        $result = Invoke-Preflight $repo -Scope Staged
        Assert-True ($result.exitCode -eq 0) "The valid index must remain authoritative: $($result.text)"
        Assert-True ($result.report.versionGate.plugins[0].candidateVersion -eq "0.1.2") "Expected staged authoritative version."
    }

    Invoke-Test "worktree-only plugin version cannot repair an unchanged staged authority" {
        $repo = New-FixtureRepository "plugin-index-invalid"
        Set-PluginSubmission $repo -Version "0.1.1"
        Invoke-Git $repo @("add", ".") | Out-Null
        Set-PluginSubmission $repo -Version "0.1.2"
        $result = Invoke-Preflight $repo -Scope Staged
        Assert-True ($result.exitCode -eq 2) "An unstaged version increase must not repair the index."
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-version-increase-required").Count -eq 1) "Expected indexed version failure."
    }

    Invoke-Test "only the exact legacy native migration accepts the initial source baseline" {
        $repo = New-FixtureRepository "plugin-initial-migration" -LegacyPlugins
        Set-PluginSubmission $repo -Version "0.1.1"
        Write-Utf8File (Join-Path $repo "plugins/source-catalog.json") '{"schemaVersion":1,"plugins":[{"sourceId":"io.rabiroute.endpoint.fixture","directory":"src/plugins/io.rabiroute.endpoint.fixture","ecosystem":"rabiroute","publicationName":"io.rabiroute.endpoint.fixture","versionFile":"rabi.plugin.json"}]}'
        $result = Invoke-Preflight $repo
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-version-increase-required").Count -eq 1) "Missing exact migration must block baseline reset."
        Invoke-Git $repo @("add", ".") | Out-Null
        Write-Utf8File (Join-Path $repo "plugins/profiles/package-migrations.json") '{"schemaVersion":1,"packages":[{"packageId":"io.rabiroute.endpoint.fixture","fromVersions":["1.0.0"],"toVersion":"0.1.1"}]}'
        $unstagedMigration = Invoke-Preflight $repo -Scope Staged
        Assert-True (@($unstagedMigration.report.versionGate.findings | Where-Object rule -eq "plugin-version-increase-required").Count -eq 1) "A worktree-only migration cannot repair an invalid staged transition."
        Invoke-Git $repo @("add", ".") | Out-Null
        $result = Invoke-Preflight $repo -Scope Staged
        Assert-True ($result.exitCode -eq 0) "Exact legacy source baseline should pass: $($result.text)"
        Assert-True ($result.report.versionGate.plugins[0].initialSourceMigration) "Expected explicit initial migration evidence."
    }

    Invoke-Test "an external source move cannot use the native baseline reset" {
        $repo = New-FixtureRepository "external-no-reset" -LegacyPlugins
        Set-PluginSubmission $repo -Version "0.1.1"
        Write-Utf8File (Join-Path $repo "plugins/source-catalog.json") '{"schemaVersion":1,"plugins":[{"sourceId":"io.rabiroute.endpoint.fixture","directory":"src/plugins/io.rabiroute.endpoint.fixture","ecosystem":"rabiroute","publicationName":"io.rabiroute.endpoint.fixture","versionFile":"rabi.plugin.json"},{"sourceId":"external-fixture","directory":"src/plugins/external-fixture","ecosystem":"integration","publicationName":"external-fixture","versionFile":"package.json"}]}'
        Write-Utf8File (Join-Path $repo "plugins/profiles/package-migrations.json") '{"schemaVersion":1,"packages":[{"packageId":"io.rabiroute.endpoint.fixture","fromVersions":["1.0.0"],"toVersion":"0.1.1"},{"packageId":"external-fixture","fromVersions":["0.4.0"],"toVersion":"0.1.1"}]}'
        Write-Utf8File (Join-Path $repo "src/plugins/external-fixture/package.json") '{"name":"external-fixture","version":"0.1.1"}'
        $result = Invoke-Preflight $repo
        Assert-True (@($result.report.versionGate.findings | Where-Object { $_.rule -eq "plugin-version-increase-required" -and $_.file -eq "src/plugins/external-fixture/package.json" }).Count -eq 1) "External version continuity must not be reset."
        Write-Utf8File (Join-Path $repo "src/plugins/external-fixture/package.json") '{"name":"external-fixture","version":"0.4.1"}'
        [System.IO.File]::AppendAllText((Join-Path $repo "版本更新日志.md"), "`n- 更新 external-fixture 0.4.1 的接入。`n", $utf8NoBom)
        [System.IO.File]::AppendAllText((Join-Path $repo "版本更新日志_en.md"), "`n- Update external-fixture 0.4.1 integration.`n", $utf8NoBom)
        $result = Invoke-Preflight $repo
        Assert-True ($result.exitCode -eq 0) "An external source move with its own next version should pass: $($result.text)"
    }

    Invoke-Test "plugin-only bilingual records identify the changed owner and its version" {
        $repo = New-FixtureRepository "plugin-change-record"
        Set-PluginSubmission $repo
        Write-Utf8File (Join-Path $repo "版本更新日志.md") "# 版本更新`n`n## 0.2.0 - 2026-11-05`n`n- 修改消息处理。`n"
        Write-Utf8File (Join-Path $repo "版本更新日志_en.md") "# Version history`n`n## 0.2.0 - 2026-11-05`n`n- Change message processing.`n"
        $result = Invoke-Preflight $repo
        Assert-True (@($result.report.versionGate.findings | Where-Object rule -eq "plugin-changelog-entry-required").Count -eq 2) "Both records must identify the plugin and version when the Host is unchanged."
    }

    }
    Invoke-Test "explicit exact false-positive receipt resolves a candidate while raw evidence stays failed" {
        $f = New-ReviewReceiptFixture "receipt-valid"
        Assert-True (-not $f.raw.report.PSObject.Properties['securityReview']) "No-receipt JSON must retain its original shape."
        $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
        Assert-True ($result.exitCode -eq 0) "Exact review should pass effectively: $($result.text)"
        Assert-True (-not $result.report.security.passed -and $result.report.security.counts.High -eq 1) "Raw scanner evidence must remain unchanged."
        Assert-True (-not $result.report.securityReview.rawPassed -and $result.report.securityReview.effectivePassed) "Raw and effective decisions must be distinct."
        Assert-True ($result.report.securityReview.reported.Count -eq 1 -and $result.report.securityReview.resolved.Count -eq 1 -and $result.report.securityReview.unresolved.Count -eq 0) "Expected exact candidate accounting."
        $f.receipt.findings[0].disposition = "verified_trusted_contract"; Save-ReviewReceipt $f
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 0) "A verified trusted contract may close the exact candidate."
        Assert-True ((Invoke-Preflight $f.repo).exitCode -eq 2) "The old no-receipt command must still block."
    }

    Invoke-Test "new High in the same file remains unresolved even after the old candidate is rebound" {
        $f = New-ReviewReceiptFixture "receipt-new-high"
        [IO.File]::AppendAllText((Join-Path $f.repo "src/review.test.js"), "const second = spawn(otherCommand, [], { shell: true });`n", $utf8NoBom)
        Update-ReviewReceiptBinding $f
        $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
        Assert-True ($result.exitCode -eq 2 -and $result.report.securityReview.receiptValid) "The still-valid old candidate cannot close a new High."
        Assert-True ($result.report.securityReview.resolved.Count -eq 1 -and $result.report.securityReview.unresolved.Count -eq 1) "One-to-one findings must remain explicit."
    }

    Invoke-Test "source or full-scope changes invalidate a receipt" {
        foreach ($kind in @('source', 'another-file', 'new-high-file', 'head')) {
            $f = New-ReviewReceiptFixture ("receipt-change-" + $kind)
            switch ($kind) {
                'source' { [IO.File]::AppendAllText((Join-Path $f.repo "src/review.test.js"), "// changed source after review`n", $utf8NoBom) }
                'another-file' { Write-Utf8File (Join-Path $f.repo "src/other.js") "export const later = true;`n" }
                'new-high-file' { Write-Utf8File (Join-Path $f.repo "src/other.js") "spawn(message, [], { shell: true });`n" }
                'head' { Invoke-Git $f.repo @("commit", "--allow-empty", "-m", "Change base identity") | Out-Null }
            }
            $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
            Assert-True ($result.exitCode -eq 2 -and -not $result.report.securityReview.receiptValid) "$kind changes must invalidate the exact review."
        }
    }

    Invoke-Test "every receipt identity and candidate fingerprint is required" {
        foreach ($field in @('repository', 'repositoryId', 'baseHead', 'scope', 'scopeHash', 'rule', 'file', 'line', 'hunkHash', 'fileSha256', 'blobId', 'contentKind')) {
            $f = New-ReviewReceiptFixture ("receipt-binding-" + $field)
            if ($field -in @('repository', 'repositoryId', 'baseHead', 'scope', 'scopeHash')) { $f.receipt.$field = "different-identity" }
            elseif ($field -eq 'line') { $f.receipt.findings[0].line = 1 }
            else { $f.receipt.findings[0].$field = "different-binding" }
            Save-ReviewReceipt $f
            Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Mismatching $field must block."
        }
    }

    Invoke-Test "only closed non-vulnerability facts and hash-verified evidence may resolve candidates" {
        foreach ($kind in @('unknown-disposition', 'risk-acceptance', 'real-vulnerability', 'string-false', 'open', 'missing-facts', 'missing-evidence', 'bad-evidence-hash', 'changed-evidence', 'missing-reviewer')) {
            $f = New-ReviewReceiptFixture ("receipt-facts-" + $kind)
            $entry = $f.receipt.findings[0]
            switch ($kind) {
                'unknown-disposition' { $entry.disposition = "ignore" }
                'risk-acceptance' { $entry.disposition = "accepted_risk" }
                'real-vulnerability' { $entry.realVulnerability = $true }
                'string-false' { $entry.realVulnerability = "false" }
                'open' { $entry.status = "open" }
                'missing-facts' { $entry.facts.boundary = "" }
                'missing-evidence' { $entry.evidence = @() }
                'bad-evidence-hash' { $entry.evidence[0].sha256 = "0" * 64 }
                'changed-evidence' { Write-Utf8File $f.proof "Changed after the review was recorded." }
                'missing-reviewer' { $f.receipt.reviewer = "" }
            }
            Save-ReviewReceipt $f
            $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
            Assert-True ($result.exitCode -eq 2 -and -not $result.report.securityReview.receiptValid -and $result.report.securityReview.resolved.Count -eq 0) "$kind cannot accept a real or unreviewed High."
        }
    }

    Invoke-Test "malicious finding and evidence paths cannot escape their roots" {
        foreach ($path in @('../outside.js', '/outside.js', 'C:/outside.js', 'src\review.test.js', 'src/../review.test.js', 'src/review.test.js:stream', 'src/*.js')) {
            $f = New-ReviewReceiptFixture ("receipt-path-" + [Guid]::NewGuid().ToString('N'))
            $f.receipt.findings[0].file = $path; Save-ReviewReceipt $f
            Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Malicious finding path must block."
            $f.receipt.findings[0].file = 'src/review.test.js'; $f.receipt.findings[0].evidence[0].path = $path; Save-ReviewReceipt $f
            Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Malicious evidence path must block."
        }
    }

    Invoke-Test "Staged uses exact index bytes and never borrows the working tree" {
        $f = New-ReviewReceiptFixture "receipt-staged" -Scope Staged -CrLf
        $expected = (Get-FileHash (Join-Path $f.repo 'src/review.test.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-True ($f.context.reported[0].fileSha256 -eq $expected -and $f.context.reported[0].contentKind -eq 'git-index-bytes-v1') "Indexed CRLF bytes must be hashed without LF/text pipeline conversion."
        $indexedBlob = @(Invoke-Git $f.repo @('rev-parse', ':src/review.test.js'))[0]
        Assert-True ($f.context.reported[0].blobId -eq $indexedBlob) "The staged blob ID must be the actual index object."
        Write-Utf8File (Join-Path $f.repo 'src/review.test.js') "spawn(unreviewedMessage, [], { shell: true });`n"
        $result = Invoke-Preflight $f.repo -Scope Staged -ReviewReceipt $f.receiptPath
        Assert-True ($result.exitCode -eq 0 -and $result.report.securityReview.rawPassed -eq $false) "A correct staged review must ignore unstaged bytes."
        $wrongScope = Invoke-Preflight $f.repo -Scope WorkingTree -ReviewReceipt $f.receiptPath
        Assert-True ($wrongScope.exitCode -eq 2 -and -not $wrongScope.report.securityReview.receiptValid) "An index receipt cannot bless the WorkingTree or mixed snapshots."
        $f = New-ReviewReceiptFixture "receipt-worktree-not-index"
        Invoke-Git $f.repo @("add", ".") | Out-Null
        Assert-True ((Invoke-Preflight $f.repo -Scope Staged -ReviewReceipt $f.receiptPath).exitCode -eq 2) "A WorkingTree receipt can never stand in for Staged."
    }

    Invoke-Test "WorkingTree raw bytes are bound while only finding hunks normalize LF" {
        $f = New-ReviewReceiptFixture "receipt-worktree-lf" -CrLf
        $text = [IO.File]::ReadAllText((Join-Path $f.repo 'src/review.test.js')).Replace("`r`n", "`n")
        $rawHash = (Get-FileHash (Join-Path $f.repo 'src/review.test.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-True ($f.context.reported[0].fileSha256 -eq $rawHash -and $f.context.reported[0].contentKind -eq 'worktree-bytes-v1') "WorkingTree must bind the complete raw byte snapshot."
        Write-Utf8File (Join-Path $f.repo 'src/review.test.js') $text
        $changed = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
        Assert-True ($changed.exitCode -eq 2 -and -not $changed.report.securityReview.receiptValid) "Even a CRLF-to-LF file change requires a new exact receipt."
        Assert-True ($changed.report.securityReview.context.reported[0].hunkHash -eq $f.context.reported[0].hunkHash) "The display hunk may normalize LF without weakening the raw file identity."
        Assert-True ($changed.report.securityReview.context.reported[0].fileSha256 -ne $f.context.reported[0].fileSha256) "Raw whole-file SHA256 must differ even when the display hunk is identical."
    }

    Invoke-Test "receipts cannot override version or private-path gates" {
        foreach ($kind in @('version', 'private-path')) {
            $f = New-ReviewReceiptFixture ("receipt-other-gate-" + $kind)
            if ($kind -eq 'version') { Write-Utf8File (Join-Path $f.repo 'package.json') '{"name":"rabiroute","version":"0.2.0"}' }
            else { Write-Utf8File (Join-Path $f.repo 'data/private.json') '{"fixture":true}' }
            Update-ReviewReceiptBinding $f
            $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
            Assert-True ($result.exitCode -eq 2 -and $result.report.securityReview.effectivePassed) "A valid security decision cannot override $kind failures."
        }
    }

    Invoke-Test "receipt must be external, parseable and non-duplicated" {
        $f = New-ReviewReceiptFixture "receipt-malformed"
        Write-Utf8File $f.receiptPath '{broken'
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Malformed JSON must block."
        Save-ReviewReceipt $f
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt (Join-Path $testRoot 'missing-receipt.json')).exitCode -eq 2) "Missing receipt must block."
        $inside = Join-Path $f.repo 'review.json'; Write-Utf8File $inside ($f.receipt | ConvertTo-Json -Depth 12)
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $inside).exitCode -eq 2) "Repository-local receipts must not be accepted."
        Remove-Item -LiteralPath $inside
        $f.receipt.findings = @($f.receipt.findings[0], $f.receipt.findings[0]); Save-ReviewReceipt $f
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Duplicate adjudications must block."
    }

    Invoke-Test "binary scope files and space-containing repositories retain exact bindings" {
        $f = New-ReviewReceiptFixture 'receipt repository with spaces' -WithBinary
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 0) "Binary scope files must be hash-bound without decoding them as UTF-8."
        [IO.File]::WriteAllBytes((Join-Path $f.repo 'assets/icon.bin'), [byte[]]@(137, 80, 78, 71, 254, 0))
        Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "A binary content change must invalidate the review."
        foreach ($withNul in @($true, $false)) {
            $f = New-ReviewReceiptFixture ("receipt-utf8-binary-" + $withNul) -WithBinary
            $before = if ($withNul) { [byte[]]@(0, 65, 13, 10, 66, 0) } else { [byte[]]@(65, 13, 10, 66) }
            $after = if ($withNul) { [byte[]]@(0, 65, 10, 66, 0) } else { [byte[]]@(65, 10, 66) }
            [IO.File]::WriteAllBytes((Join-Path $f.repo 'assets/icon.bin'), $before)
            Update-ReviewReceiptBinding $f
            Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 0) "Legal UTF-8 binary bytes must be supported without text classification."
            [IO.File]::WriteAllBytes((Join-Path $f.repo 'assets/icon.bin'), $after)
            $changed = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
            Assert-True ($changed.exitCode -eq 2 -and -not $changed.report.securityReview.receiptValid) "Legal UTF-8 binary CRLF/LF changes must invalidate scope, with or without NUL."
        }
        $f = New-ReviewReceiptFixture 'receipt-staged-binary' -Scope Staged -WithBinary
        [IO.File]::WriteAllBytes((Join-Path $f.repo 'assets/icon.bin'), [byte[]]@(137, 80, 78, 71, 254, 0))
        Assert-True ((Invoke-Preflight $f.repo -Scope Staged -ReviewReceipt $f.receiptPath).exitCode -eq 0) "An unstaged binary change cannot alter a valid index receipt."
        Invoke-Git $f.repo @('add', '--', 'assets/icon.bin') | Out-Null
        $indexed = Invoke-Preflight $f.repo -Scope Staged -ReviewReceipt $f.receiptPath
        Assert-True ($indexed.exitCode -eq 2 -and -not $indexed.report.securityReview.receiptValid) "Staging different non-finding binary bytes must invalidate the entire index scope."
    }

    Invoke-Test "adjudication preserves the caller threshold and leaves unresolved Medium blocking" {
        $f = New-ReviewReceiptFixture 'receipt-threshold'
        [IO.File]::AppendAllText((Join-Path $f.repo 'src/review.test.js'), "const listener = '0.0.0.0';`n", $utf8NoBom)
        Update-ReviewReceiptBinding $f -FailOn Medium
        $result = Invoke-Preflight $f.repo -FailOn Medium -ReviewReceipt $f.receiptPath
        Assert-True ($result.exitCode -eq 2 -and $result.report.securityReview.receiptValid) "Valid High adjudication must preserve FailOn=Medium."
        Assert-True ($result.report.security.failOn -eq 'Medium' -and $result.report.security.counts.Medium -eq 1 -and $result.report.securityReview.unresolved.Count -eq 1) "The raw threshold and unresolved Medium must be retained."
    }

    Invoke-Test "Critical and foreign-repository candidates cannot borrow a receipt" {
        $f = New-ReviewReceiptFixture 'receipt-critical'
        $synthetic = 'sk-' + ('R' * 40)
        [IO.File]::AppendAllText((Join-Path $f.repo 'src/review.test.js'), "const provider = '$synthetic';`n", $utf8NoBom)
        Update-ReviewReceiptBinding $f
        $result = Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath
        Assert-True ($result.exitCode -eq 2 -and $result.report.security.counts.Critical -eq 1) "An exact High review must leave Critical blocking."
        $critical = @($result.report.securityReview.reported | Where-Object severity -eq 'Critical')[0]
        foreach ($field in @('severity', 'rule', 'file', 'line', 'hunkHash', 'fileSha256', 'blobId', 'contentKind')) { $f.receipt.findings[0].$field = $critical.$field }
        Save-ReviewReceipt $f
        Assert-True (-not (Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).report.securityReview.receiptValid) "Receipts cannot resolve Critical, even by claiming a false positive."
        $f = New-ReviewReceiptFixture 'receipt-foreign-source'
        $other = Join-Path $testRoot 'receipt-foreign-clone'
        Invoke-Git $testRoot @('clone', '--quiet', '--', $f.repo, $other) | Out-Null
        foreach ($relative in $f.raw.report.changedFiles) { Write-Utf8File (Join-Path $other $relative) ([IO.File]::ReadAllText((Join-Path $f.repo $relative))) }
        $foreignHead = @(Invoke-Git $other @('rev-parse', 'HEAD'))[0]
        Assert-True ($foreignHead -eq $f.context.baseHead) "Foreign fixture must deliberately share the exact base HEAD."
        $foreign = Invoke-Preflight $other -ReviewReceipt $f.receiptPath
        Assert-True ($foreign.exitCode -eq 2 -and -not $foreign.report.securityReview.receiptValid) "Identical blobs and HEAD in another repository cannot reuse the receipt."
    }

    Invoke-Test "review evidence and receipt ancestry cannot traverse junctions" {
        if ([IO.Path]::DirectorySeparatorChar -ne '\') { return }
        $f = New-ReviewReceiptFixture 'receipt-link-boundary'
        $evidenceDirectory = Split-Path -Parent $f.receiptPath
        $target = Join-Path $testRoot 'receipt-link-evidence-target'
        Write-Utf8File (Join-Path $target 'review.md') ([IO.File]::ReadAllText($f.proof))
        $link = Join-Path $evidenceDirectory 'linked'
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        try {
            $f.receipt.findings[0].evidence[0].path = 'linked/review.md'; Save-ReviewReceipt $f
            Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt $f.receiptPath).exitCode -eq 2) "Evidence cannot traverse a junction even when bytes match."
        } finally { [IO.Directory]::Delete($link) }
        $f.receipt.findings[0].evidence[0].path = 'review.md'; Save-ReviewReceipt $f
        $receiptLink = Join-Path $testRoot 'receipt-file-parent-link'
        New-Item -ItemType Junction -Path $receiptLink -Target $evidenceDirectory | Out-Null
        try { Assert-True ((Invoke-Preflight $f.repo -ReviewReceipt (Join-Path $receiptLink 'receipt.json')).exitCode -eq 2) "Receipt ancestry cannot traverse a junction." }
        finally { [IO.Directory]::Delete($receiptLink) }
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
