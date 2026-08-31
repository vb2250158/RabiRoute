[CmdletBinding()]
param(
    [ValidateSet("WorkingTree", "Staged")]
    [string]$Scope = "WorkingTree",

    [ValidateSet("Info", "Low", "Medium", "High", "Critical")]
    [string]$FailOn = "High",

    [switch]$Json
)

$ErrorActionPreference = "Stop"

function Invoke-GitText {
    param([string[]]$Arguments)

    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return @($output | ForEach-Object { [string]$_ })
}

function Add-UniqueLines {
    param(
        [System.Collections.Generic.HashSet[string]]$Target,
        [string[]]$Lines
    )

    foreach ($line in $Lines) {
        if ($line -and -not $line.StartsWith("warning:", [System.StringComparison]::OrdinalIgnoreCase)) {
            [void]$Target.Add($line.Trim())
        }
    }
}

function Protect-RemoteUrl {
    param([string]$Url)

    $safeUrl = $Url -replace '(?<=://)[^/@\s]+@', '<redacted>@'
    $safeUrl = $safeUrl -replace '(?i)([?&](?:token|access_token|auth|key|secret)=)[^&\s]+', '${1}<redacted>'
    return $safeUrl
}

function Get-GitObjectText {
    param([string]$ObjectPath)

    $output = @(& git show $ObjectPath 2>$null | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return $output -join "`n"
}

function Get-ScopedFileText {
    param([string]$RelativePath)

    if ($Scope -eq "Staged") {
        return Get-GitObjectText -ObjectPath ":$RelativePath"
    }

    $absolutePath = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        return $null
    }
    return [System.IO.File]::ReadAllText($absolutePath)
}

function Test-VersionSectionHasEntry {
    param(
        [string]$Content,
        [string]$Version
    )

    if (-not $Content) {
        return $false
    }

    $escapedVersion = [regex]::Escape($Version)
    $match = [regex]::Match(
        $Content,
        "(?ms)^##\s+$escapedVersion\s+-\s+\d{4}-\d{2}-\d{2}\s*\r?\n(?<body>.*?)(?=^##\s+|\z)"
    )
    return $match.Success -and $match.Groups["body"].Value -match '(?m)^\s*-\s+\S'
}

$repoRootLines = @(Invoke-GitText -Arguments @("rev-parse", "--show-toplevel"))
$repoRoot = $repoRootLines[0].Trim()
if (-not $repoRoot) {
    throw "No Git repository root was found."
}

$packagePath = Join-Path $repoRoot "package.json"
if (-not (Test-Path -LiteralPath $packagePath)) {
    throw "The repository has no package.json and is not recognized as RabiRoute."
}

$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne "rabiroute") {
    throw "Expected package name 'rabiroute', found '$($package.name)'."
}

$changedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
if ($Scope -eq "WorkingTree") {
    Add-UniqueLines -Target $changedFiles -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--name-only"))
    Add-UniqueLines -Target $changedFiles -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-only"))
    Add-UniqueLines -Target $changedFiles -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"))
} else {
    Add-UniqueLines -Target $changedFiles -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-only"))
}

$blockedPathRules = @(
    @{ id = "private-runtime-data"; pattern = '(?i)^data/'; message = "Local runtime data must not be submitted." },
    @{ id = "runtime-output"; pattern = '(?i)^(?:logs|runs|recordings|transcripts|cache|output|node_modules|dist)/'; message = "Runtime, dependency, cache, or build output must not be submitted." },
    @{ id = "environment-file"; pattern = '(?i)(?:^|/)\.env(?:$|\.)'; allow = '(?i)\.env\.(?:example|template|sample)$'; message = "Environment files are private unless they are explicit sanitized templates." },
    @{ id = "local-config"; pattern = '(?i)(?:^|/)config\.json$'; message = "Runtime config.json must not be submitted; use a sanitized example." },
    @{ id = "private-message-data"; pattern = '(?i)(?:private-messages|group-messages|voice-transcripts|conversation-ledger).*\.jsonl?$'; message = "Private message or transcript data must not be submitted." },
    @{ id = "credential-container"; pattern = '(?i)(?:token|cookie|credential|secret).*\.(?:json|txt|log|pem|key)$'; message = "A credential-like file requires removal or explicit sanitized-template proof." }
)

$pathFindings = [System.Collections.Generic.List[object]]::new()
foreach ($file in $changedFiles) {
    foreach ($rule in $blockedPathRules) {
        if ($file -notmatch $rule.pattern) {
            continue
        }
        if ($rule.allow -and $file -match $rule.allow) {
            continue
        }
        $pathFindings.Add([pscustomobject]@{
            severity = "High"
            rule = $rule.id
            file = $file
            message = $rule.message
        })
    }
}

function Get-ChangedTextLines {
    param([string]$RelativePath)

    if ($Scope -eq "Staged") {
        $content = @(& git show ":$RelativePath" 2>$null | ForEach-Object { [string]$_ })
        if ($LASTEXITCODE -ne 0) {
            return @()
        }
        return $content
    }

    $absolutePath = Join-Path $repoRoot $RelativePath
    $item = Get-Item -LiteralPath $absolutePath -ErrorAction SilentlyContinue
    if (-not $item -or $item.PSIsContainer -or $item.Length -gt 1MB) {
        return @()
    }
    return @([System.IO.File]::ReadAllLines($absolutePath))
}

$workflowFindings = [System.Collections.Generic.List[object]]::new()
foreach ($workflowPath in @($changedFiles | Where-Object { $_ -match '(?i)^\.github/workflows/[^/]+\.ya?ml$' })) {
    $workflowLines = @(Get-ChangedTextLines -RelativePath $workflowPath)
    for ($index = 0; $index -lt $workflowLines.Count; $index += 1) {
        $line = $workflowLines[$index]
        $lineNumber = $index + 1

        if ($line -match '^\s*pull_request_target\s*:') {
            $workflowFindings.Add([pscustomobject]@{
                severity = "High"
                rule = "workflow-privileged-pr-trigger"
                file = $workflowPath
                line = $lineNumber
                message = "pull_request_target requires explicit human approval and a proof that untrusted pull-request code is never executed."
            })
        }

        if ($line -match '^\s*permissions\s*:\s*write-all\s*(?:#.*)?$') {
            $workflowFindings.Add([pscustomobject]@{
                severity = "Critical"
                rule = "workflow-write-all"
                file = $workflowPath
                line = $lineNumber
                message = "GitHub Actions permissions must be declared with least privilege; write-all is forbidden."
            })
        }

        if ($line -match '^\s*persist-credentials\s*:\s*true\s*(?:#.*)?$') {
            $workflowFindings.Add([pscustomobject]@{
                severity = "High"
                rule = "workflow-persistent-checkout-credentials"
                file = $workflowPath
                line = $lineNumber
                message = "Checkout credentials must not persist in a submission or security workflow without explicit justification."
            })
        }

        if ($line -match '^\s*(?:-\s*)?uses\s*:\s*([^\s#]+)') {
            $actionReference = $Matches[1]
            if ($actionReference.StartsWith("./", [System.StringComparison]::Ordinal)) {
                continue
            }
            if ($actionReference -match '^docker://.+@sha256:[0-9a-fA-F]{64}$') {
                continue
            }
            if ($actionReference -notmatch '@[0-9a-fA-F]{40}$') {
                $workflowFindings.Add([pscustomobject]@{
                    severity = "High"
                    rule = "workflow-unpinned-action"
                    file = $workflowPath
                    line = $lineNumber
                    message = "External actions must be pinned to a full 40-character commit SHA."
                })
            }
        }
    }
}

$skillsRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$securityCandidates = [System.Collections.Generic.List[string]]::new()
$securityCandidates.Add((Join-Path $skillsRoot "ai-code-security-review\scripts\Invoke-AICodeSecurityReview.ps1"))
if ($env:CODEX_HOME) {
    $securityCandidates.Add((Join-Path $env:CODEX_HOME "skills\ai-code-security-review\scripts\Invoke-AICodeSecurityReview.ps1"))
}
if ($env:USERPROFILE) {
    $securityCandidates.Add((Join-Path $env:USERPROFILE ".codex\skills\ai-code-security-review\scripts\Invoke-AICodeSecurityReview.ps1"))
}
$securityScript = @($securityCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Unique)[0]
if (-not $securityScript) {
    throw "Required ai-code-security-review scanner is missing. Checked: $($securityCandidates -join ', ')"
}

$securityOutput = @(& $securityScript -Scope $Scope -FailOn $FailOn -Json -NoFail)
$securityText = $securityOutput -join [Environment]::NewLine
try {
    $securityReport = $securityText | ConvertFrom-Json
} catch {
    throw "The AI code security scanner did not return valid JSON."
}
$securityBlocked = -not [bool]$securityReport.passed

$diffCheckArguments = if ($Scope -eq "Staged") {
    @("diff", "--cached", "--check")
} else {
    @("diff", "HEAD", "--check")
}
$diffCheckOutput = @(& git @diffCheckArguments 2>&1 | ForEach-Object { [string]$_ })
$diffCheckExitCode = $LASTEXITCODE
$diffCheckDiagnostics = @(
    $diffCheckOutput |
        Where-Object { $_ -match '^[^+].*:\d+:' } |
        ForEach-Object { $_ -replace '\s+$', '' }
)

$changed = @($changedFiles | Sort-Object)
$status = @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "status", "--short", "--branch"))
$branchLines = @(Invoke-GitText -Arguments @("branch", "--show-current"))
$branch = if ($branchLines.Count -gt 0) { $branchLines[0] } else { "" }
$remoteNames = @(Invoke-GitText -Arguments @("remote"))
$remotes = @(
    foreach ($remoteName in $remoteNames) {
        $remoteUrlLines = @(Invoke-GitText -Arguments @("remote", "get-url", $remoteName))
        [pscustomobject]@{
            name = $remoteName
            url = Protect-RemoteUrl -Url $remoteUrlLines[0]
        }
    }
)

$versionFindings = [System.Collections.Generic.List[object]]::new()
$headVersion = $null
$candidateVersion = $null
$expectedVersion = $null
$versionGateApplicable = $changed.Count -gt 0

function Add-VersionFinding {
    param(
        [string]$Rule,
        [string]$File,
        [string]$Message
    )

    $versionFindings.Add([pscustomobject]@{
        severity = "High"
        rule = $Rule
        file = $File
        message = $Message
    })
}

if ($versionGateApplicable) {
    $requiredVersionFiles = @(
        "package.json",
        "package-lock.json",
        "README.md",
        "README_zh.md",
        "版本更新日志.md",
        "版本更新日志_en.md"
    )
    foreach ($requiredFile in $requiredVersionFiles) {
        if ($changed -notcontains $requiredFile) {
            Add-VersionFinding -Rule "commit-version-file-missing" -File $requiredFile -Message "Every RabiRoute commit must update this version surface."
        }
    }

    $headPackageText = Get-GitObjectText -ObjectPath "HEAD:package.json"
    $candidatePackageText = Get-ScopedFileText -RelativePath "package.json"
    try {
        $headPackage = $headPackageText | ConvertFrom-Json
        $headVersion = [string]$headPackage.version
    } catch {
        Add-VersionFinding -Rule "commit-head-version-invalid" -File "package.json" -Message "HEAD package.json must contain a readable semantic version."
    }
    try {
        $candidatePackage = $candidatePackageText | ConvertFrom-Json
        $candidateVersion = [string]$candidatePackage.version
    } catch {
        Add-VersionFinding -Rule "commit-version-invalid" -File "package.json" -Message "The candidate package.json must contain a readable semantic version."
    }

    $headMatch = if ($headVersion) { [regex]::Match($headVersion, '^(\d+)\.(\d+)\.(\d+)$') } else { $null }
    $candidateMatch = if ($candidateVersion) { [regex]::Match($candidateVersion, '^(\d+)\.(\d+)\.(\d+)$') } else { $null }
    if (-not $headMatch -or -not $headMatch.Success) {
        Add-VersionFinding -Rule "commit-head-version-semver" -File "package.json" -Message "HEAD version '$headVersion' is not strict major.minor.patch SemVer."
    } else {
        $expectedVersion = "{0}.{1}.{2}" -f $headMatch.Groups[1].Value,$headMatch.Groups[2].Value,([int64]$headMatch.Groups[3].Value + 1)
    }
    if (-not $candidateMatch -or -not $candidateMatch.Success) {
        Add-VersionFinding -Rule "commit-version-semver" -File "package.json" -Message "Candidate version '$candidateVersion' is not strict major.minor.patch SemVer."
    } elseif ($expectedVersion -and $candidateVersion -ne $expectedVersion) {
        Add-VersionFinding -Rule "commit-patch-version-required" -File "package.json" -Message "Every commit must increment the HEAD patch version exactly once: expected $expectedVersion, found $candidateVersion."
    }

    $lockText = Get-ScopedFileText -RelativePath "package-lock.json"
    try {
        $lock = $lockText | ConvertFrom-Json -AsHashtable
        $lockRoot = $lock["packages"][""]
        if (-not $lockRoot) {
            throw "Root package entry is missing."
        }
        if ([string]$lock["version"] -ne $candidateVersion -or [string]$lockRoot["version"] -ne $candidateVersion) {
            Add-VersionFinding -Rule "commit-lock-version-mismatch" -File "package-lock.json" -Message "package-lock.json root versions must both equal $candidateVersion."
        }
    } catch {
        Add-VersionFinding -Rule "commit-lock-version-invalid" -File "package-lock.json" -Message "package-lock.json must be readable and contain synchronized root versions."
    }

    if ($candidateVersion) {
        $escapedCandidate = [regex]::Escape($candidateVersion)
        $readme = Get-ScopedFileText -RelativePath "README.md"
        $readmeZh = Get-ScopedFileText -RelativePath "README_zh.md"
        if (-not $readme -or $readme -notmatch "version-$escapedCandidate" -or $readme -notmatch "(?i)repository version is\s+.*$escapedCandidate") {
            Add-VersionFinding -Rule "commit-readme-version-mismatch" -File "README.md" -Message "The English README badge and repository-version statement must show $candidateVersion."
        }
        if (-not $readmeZh -or $readmeZh -notmatch "version-$escapedCandidate" -or $readmeZh -notmatch "仓库当前版本为\s+.*$escapedCandidate") {
            Add-VersionFinding -Rule "commit-readme-version-mismatch" -File "README_zh.md" -Message "The Chinese README badge and repository-version statement must show $candidateVersion."
        }

        foreach ($changelogPath in @("版本更新日志.md", "版本更新日志_en.md")) {
            $changelog = Get-ScopedFileText -RelativePath $changelogPath
            if (-not (Test-VersionSectionHasEntry -Content $changelog -Version $candidateVersion)) {
                Add-VersionFinding -Rule "commit-changelog-entry-required" -File $changelogPath -Message "Every commit must add a dated $candidateVersion section with at least one bullet describing that commit."
            }
        }
    }
}

$versionGate = [pscustomobject]@{
    applicable = $versionGateApplicable
    passed = $versionFindings.Count -eq 0
    headVersion = $headVersion
    expectedVersion = $expectedVersion
    candidateVersion = $candidateVersion
    findings = @($versionFindings)
}

$markers = [pscustomobject]@{
    changelogChanged = ($changed -contains "版本更新日志.md") -and ($changed -contains "版本更新日志_en.md")
    versionManifestChanged = ($changed -contains "package.json") -and ($changed -contains "package-lock.json")
    publicRabiChanged = @($changed | Where-Object { $_ -like "examples/data/roles/Rabi/*" }).Count -gt 0
    localRabiDetectedInChangeSet = @($changed | Where-Object { $_ -like "data/roles/Rabi/*" }).Count -gt 0
    workflowChanged = @($changed | Where-Object { $_ -like ".github/workflows/*" }).Count -gt 0
}

$report = [pscustomobject]@{
    repository = $repoRoot
    packageVersion = if ($candidateVersion) { $candidateVersion } else { [string]$package.version }
    branch = $branch
    scope = $Scope
    status = $status
    remotes = $remotes
    changedFiles = $changed
    pathFindings = @($pathFindings)
    workflowFindings = @($workflowFindings)
    security = $securityReport
    diffCheck = [pscustomobject]@{
        passed = $diffCheckExitCode -eq 0
        diagnostics = $diffCheckDiagnostics
    }
    versionGate = $versionGate
    markers = $markers
    note = "Read-only preflight. Passing it does not authorize staging, commit, push, PR, tag, release, or artifact publication."
}

if ($Json) {
    $report | ConvertTo-Json -Depth 8
} else {
    Write-Output "RabiRoute submit preflight"
    Write-Output "Repository: $repoRoot"
    Write-Output "Branch: $branch"
    Write-Output "Version: $($package.version)"
    Write-Output "Scope: $Scope"
    Write-Output "Changed files: $($changed.Count)"
    Write-Output "Path findings: $($pathFindings.Count)"
    foreach ($finding in $pathFindings) {
        Write-Output "[$($finding.severity)] $($finding.rule) $($finding.file) - $($finding.message)"
    }
    Write-Output "Workflow findings: $($workflowFindings.Count)"
    foreach ($finding in $workflowFindings) {
        Write-Output "[$($finding.severity)] $($finding.rule) $($finding.file):$($finding.line) - $($finding.message)"
    }
    Write-Output "Security findings: Critical=$($securityReport.counts.Critical) High=$($securityReport.counts.High) Medium=$($securityReport.counts.Medium)"
    Write-Output "Diff check: $(if ($diffCheckExitCode -eq 0) { 'passed' } else { 'failed' })"
    Write-Output "Version gate: $(if ($versionGate.passed) { 'passed' } else { 'failed' })"
    if ($versionGate.applicable) {
        Write-Output "Version transition: $($versionGate.headVersion) -> $($versionGate.candidateVersion) (expected $($versionGate.expectedVersion))"
    }
    foreach ($finding in $versionFindings) {
        Write-Output "[$($finding.severity)] $($finding.rule) $($finding.file) - $($finding.message)"
    }
    Write-Output "Changelog changed: $($markers.changelogChanged)"
    Write-Output "Version metadata changed: $($markers.versionManifestChanged)"
    Write-Output "Public example Rabi changed: $($markers.publicRabiChanged)"
    Write-Output $report.note
}

if ($pathFindings.Count -gt 0 -or $workflowFindings.Count -gt 0 -or $securityBlocked -or $diffCheckExitCode -ne 0 -or -not $versionGate.passed) {
    exit 2
}
