[CmdletBinding()]
param(
    [ValidateSet("WorkingTree", "Staged")]
    [string]$Scope = "WorkingTree",

    [ValidateSet("Info", "Low", "Medium", "High", "Critical")]
    [string]$FailOn = "High",

    [switch]$Json,

    [string]$ReviewReceipt
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
if ($Scope -eq "WorkingTree" -and -not (Test-Path -LiteralPath $packagePath)) {
    throw "The repository has no package.json and is not recognized as RabiRoute."
}

$package = (Get-ScopedFileText -RelativePath "package.json") | ConvertFrom-Json
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
$securityReview = $null
if ($ReviewReceipt) {
    . (Join-Path $PSScriptRoot "RabiSecurityReviewReceipt.ps1")
    $securityReview = Resolve-RabiSecurityReviewReceipt -Repository $repoRoot -Scope $Scope -FailOn $FailOn `
        -SecurityReport $securityReport -ChangedFiles @($changedFiles) -ReceiptPath $ReviewReceipt
    $securityBlocked = -not $securityReview.effectivePassed
}

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
$status = if ($Scope -eq "Staged") {
    # Staged decisions use index blobs; reporting must not scan unrelated working files.
    @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-status"))
} else {
    @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "status", "--short", "--branch"))
}
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
function Test-ValidationOnlyPath {
    param([string]$File)
    return $File -match '(?:^|/)(?:tests?|__tests__)/|[.](?:test|spec)[.][cm]?[jt]sx?$'
}
# Git's name-only rename view omits the removed source. Keep it for version
# ownership without changing the exact security-review receipt scope.
$versionChanges = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Add-UniqueLines -Target $versionChanges -Lines $changed
if ($Scope -eq "WorkingTree") {
    Add-UniqueLines -Target $versionChanges -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--no-renames", "--diff-filter=D", "--name-only"))
}
Add-UniqueLines -Target $versionChanges -Lines @(Invoke-GitText -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--no-renames", "--diff-filter=D", "--name-only"))
$versionGateApplicable = @($versionChanges | Where-Object { -not (Test-ValidationOnlyPath $_) }).Count -gt 0

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

function Read-VersionJson {
    param([string]$File, [switch]$Head, [switch]$OptionalHistorical)
    $text = if ($Head) { Get-GitObjectText -ObjectPath "HEAD:$File" } else { Get-ScopedFileText -RelativePath $File }
    if (-not $text) { return $null }
    try { return $text | ConvertFrom-Json -AsHashtable } catch { if (-not $OptionalHistorical) { Add-VersionFinding -Rule "version-metadata-invalid" -File $File -Message "Version metadata must be valid JSON." }; return $null }
}
function Test-StrictVersion {
    param([string]$Version)
    return $Version -match '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'
}
$pluginVersions = [System.Collections.Generic.List[object]]::new()
$applicationVersions = [System.Collections.Generic.List[object]]::new()
$hostVersionRequired = $false
if ($versionGateApplicable) {
    $headPackage = Read-VersionJson -File "package.json" -Head
    $candidatePackage = Read-VersionJson -File "package.json"
    $headVersion = [string]$headPackage.version
    $candidateVersion = [string]$candidatePackage.version
    if (-not (Test-StrictVersion $headVersion)) { Add-VersionFinding "commit-head-version-semver" "package.json" "HEAD must have a strict major.minor.patch Host version." }
    if (-not (Test-StrictVersion $candidateVersion)) { Add-VersionFinding "commit-version-semver" "package.json" "Candidate must have a strict major.minor.patch Host version." }

    $catalog = Read-VersionJson -File "plugins/source-catalog.json"
    $headCatalog = Read-VersionJson -File "plugins/source-catalog.json" -Head
    $pluginDirectories = [System.Collections.Generic.List[string]]::new()
    $legacyManifests = $null
    foreach ($source in @($catalog.plugins)) {
        if (-not $source) { continue }
        $id = [string]$source.sourceId; $directory = [string]$source.directory; $authority = [string]$source.versionFile
        if ($directory -ne "src/plugins/$id" -or $id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $authority -notin @("rabi.plugin.json", "rabi-plugin.json", "package.json", ".codex-plugin/plugin.json", ".codebuddy-plugin/plugin.json", "plugin.json")) {
            Add-VersionFinding "plugin-version-authority-invalid" "plugins/source-catalog.json" "Each source needs its canonical folder and explicit authoritative versionFile."
            continue
        }
        $pluginDirectories.Add($directory)
        if (@($versionChanges | Where-Object { ($_ -eq $directory -or $_.StartsWith("$directory/", [StringComparison]::Ordinal)) -and -not (Test-ValidationOnlyPath $_) }).Count -eq 0) { continue }
        $versionPath = "$directory/$authority"
        $metadata = Read-VersionJson -File $versionPath
        $current = [string]$metadata.version
        if (-not (Test-StrictVersion $current)) { Add-VersionFinding "plugin-version-invalid" $versionPath "Changed plugin $id needs a strict authoritative version."; continue }
        if ($source.ecosystem -eq "rabiroute" -and [string]$metadata.id -ne $id) { Add-VersionFinding "plugin-identity-mismatch" $versionPath "Native manifest id must match its source-catalog identity." }
        foreach ($name in @("rabi.plugin.json", "rabi-plugin.json", "package.json", ".codex-plugin/plugin.json", ".codebuddy-plugin/plugin.json", "plugin.json", "package-lock.json")) {
            $file = "$directory/$name"; $copy = Read-VersionJson -File $file
            if (-not $copy) { continue }
            if ($copy.ContainsKey("version") -and [string]$copy.version -ne $current) { Add-VersionFinding "plugin-version-metadata-mismatch" $file "Plugin version metadata must match authoritative $authority ($current)." }
            if ($name -eq "package-lock.json" -and $copy.packages -and $copy.packages.ContainsKey("") -and [string]$copy.packages[""].version -ne $current) {
                Add-VersionFinding "plugin-version-metadata-mismatch" $file "The plugin lockfile root must match its authoritative version."
            }
        }
        $previousSource = @($headCatalog.plugins | Where-Object sourceId -eq $id | Select-Object -First 1)
        $previous = $null; $previousFile = $null; $nativeBaseline = $false
        if ($previousSource.Count -gt 0) {
            $old = $previousSource[0]; $previousFile = "$($old.directory)/$($old.versionFile)"
            $oldMetadata = Read-VersionJson -File $previousFile -Head; $previous = [string]$oldMetadata.version
            if (-not (Test-StrictVersion $previous)) { Add-VersionFinding "plugin-head-version-invalid" $previousFile "The previous catalog authority must contain a valid plugin version." }
        } else {
            # A source-only move compares the original published package, not the newly added pathname.
            if ($null -eq $legacyManifests) {
                $legacyManifests = [System.Collections.Generic.List[object]]::new()
                foreach ($file in @(Invoke-GitText -Arguments @("ls-tree", "-r", "--name-only", "HEAD", "--", "plugins", "plugin-adapters", "src/plugins"))) {
                    if ($file -notmatch '(?:^|/)(?:rabi[.]plugin[.]json|rabi-plugin[.]json|package[.]json|plugin[.]json)$' -or $file -match '/(?:node_modules|dist|tests?|fixtures?)/') { continue }
                    $oldMetadata = Read-VersionJson -File $file -Head -OptionalHistorical
                    if ($oldMetadata -and (Test-StrictVersion ([string]$oldMetadata.version))) { $legacyManifests.Add(@{ file = $file; data = $oldMetadata }) }
                }
            }
            $matching = @($legacyManifests | Where-Object { [string]$_.data.id -eq $id -or [string]$_.data.name -eq [string]$source.publicationName } | Sort-Object { [version]$_.data.version } -Descending)
            if ($matching.Count -gt 0) { $previous = [string]$matching[0].data.version; $previousFile = [string]$matching[0].file; $nativeBaseline = $previousFile.StartsWith("plugins/builtin/", [StringComparison]::Ordinal) -and $source.ecosystem -eq "rabiroute" }
        }
        $migrationAccepted = $false
        if ($previous -and (Test-StrictVersion $previous)) {
            if ($nativeBaseline -and $current -eq "0.1.1") {
                $migrations = Read-VersionJson -File "plugins/profiles/package-migrations.json"
                $migrationAccepted = @($migrations.packages | Where-Object { $_.packageId -eq $id -and $_.toVersion -eq "0.1.1" -and $_.fromVersions -contains $previous }).Count -eq 1
            }
            if (-not $migrationAccepted -and [version]$current -le [version]$previous) { Add-VersionFinding "plugin-version-increase-required" $versionPath "Changed plugin $id must advance its own version from $previous; published versions cannot be reused or downgraded." }
        } elseif ($previous) { Add-VersionFinding "plugin-head-version-invalid" $previousFile "The previous authoritative plugin version must be valid." }
        elseif ($source.ecosystem -eq "rabiroute" -and $current -ne "0.1.1") { Add-VersionFinding "plugin-initial-version-required" $versionPath "A new native plugin starts at 0.1.1." }
        $pluginVersions.Add([pscustomobject]@{ sourceId = $id; versionFile = $versionPath; headVersion = $previous; candidateVersion = $current; initialSourceMigration = $migrationAccepted })
    }
    # An existing package-managed root application owns its implementation version.
    # HEAD establishes ownership; a new nested package cannot exempt an apps path.
    $applicationDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $changedApplicationRoots = @($versionChanges | Where-Object { -not (Test-ValidationOnlyPath $_) -and $_ -match '^apps/[^/]+/' } |
        ForEach-Object { ($_ -split '/')[0..1] -join '/' } | Sort-Object -Unique)
    foreach ($directory in $changedApplicationRoots) {
        $versionPath = "$directory/package.json"
        $previousMetadata = Read-VersionJson -File $versionPath -Head -OptionalHistorical
        if ($previousMetadata -isnot [System.Collections.IDictionary] -or [string]::IsNullOrWhiteSpace([string]$previousMetadata.name) -or
            -not (Test-StrictVersion ([string]$previousMetadata.version))) { continue }
        [void]$applicationDirectories.Add($directory)
        $metadata = Read-VersionJson -File $versionPath
        $previous = [string]$previousMetadata.version
        $current = [string]$metadata.version
        if ($metadata -isnot [System.Collections.IDictionary] -or -not (Test-StrictVersion $current) -or [string]::IsNullOrWhiteSpace([string]$metadata.name)) {
            Add-VersionFinding 'application-version-invalid' $versionPath 'The changed application needs its readable name and strict authoritative version.'
        } elseif ([version]$current -le [version]$previous) {
            Add-VersionFinding 'application-version-increase-required' $versionPath "Changed application $directory must advance its own version from $previous."
        }
        if ($changed -notcontains $versionPath) {
            Add-VersionFinding 'application-version-file-missing' $versionPath 'Include the application version authority in the submitted scope.'
        }
        $lockPath = "$directory/package-lock.json"
        $previousLock = Get-GitObjectText -ObjectPath "HEAD:$lockPath"
        $candidateLock = Get-ScopedFileText -RelativePath $lockPath
        if ($previousLock -or $candidateLock) {
            $lock = Read-VersionJson -File $lockPath
            if ($lock -isnot [System.Collections.IDictionary] -or [string]$lock.version -ne $current -or
                ($lock.ContainsKey('packages') -and (-not $lock.packages -or -not $lock.packages.ContainsKey('') -or [string]$lock.packages[''].version -ne $current))) {
                Add-VersionFinding 'application-lock-version-mismatch' $lockPath 'The application lock metadata must match its authoritative application version.'
            }
        }
        $applicationVersions.Add([pscustomobject]@{ name = [string]$metadata.name; directory = $directory; versionFile = $versionPath; headVersion = $previous; candidateVersion = $current })
    }

    foreach ($file in $versionChanges) {
        $owned = @($pluginDirectories | Where-Object { $file.StartsWith("$_/", [StringComparison]::Ordinal) }).Count -gt 0
        if ($file.StartsWith("src/plugins/", [StringComparison]::Ordinal) -and -not $owned) { Add-VersionFinding "plugin-source-unindexed" $file "Changed plugin source must have a source-catalog owner and authoritative versionFile." }
        # Validation files follow the production owner's version; their location alone is not a Host extension change.
        $testOnly = Test-ValidationOnlyPath $file
        $applicationOwned = @($applicationDirectories | Where-Object { $file.StartsWith("$_/", [StringComparison]::Ordinal) }).Count -gt 0
        if (-not $owned -and -not $applicationOwned -and -not $testOnly -and $file -match '^(?:src/|scripts/|apps/|packages/|ribiwebgui/|plugins/contracts/)') { $hostVersionRequired = $true }
    }
    $hostAdvanced = $false
    if ((Test-StrictVersion $headVersion) -and (Test-StrictVersion $candidateVersion)) {
        $hostAdvanced = [version]$candidateVersion -gt [version]$headVersion
        if ([version]$candidateVersion -lt [version]$headVersion) { Add-VersionFinding "commit-host-version-downgrade" "package.json" "The Host version cannot move backwards." }
        if ($hostVersionRequired -and -not $hostAdvanced) { Add-VersionFinding "commit-host-version-required" "package.json" "Host architecture or extension-point changes require a newer Host version; SemVer minor and major upgrades are allowed." }
    }
    $requiredVersionFiles = @("版本更新日志.md", "版本更新日志_en.md")
    if ($hostAdvanced) { $requiredVersionFiles += @("package.json", "package-lock.json", "README.md", "README_zh.md") }
    foreach ($requiredFile in $requiredVersionFiles) {
        if ($changed -notcontains $requiredFile) { Add-VersionFinding "commit-version-file-missing" $requiredFile "Stage the applicable version metadata and bilingual change record together." }
    }
    $lock = Read-VersionJson -File "package-lock.json"
    if (-not $lock -or -not $lock.packages -or -not $lock.packages.ContainsKey("")) { Add-VersionFinding "commit-lock-version-invalid" "package-lock.json" "Root lock metadata must be readable." }
    elseif ([string]$lock.version -ne $candidateVersion -or [string]$lock.packages[""].version -ne $candidateVersion) { Add-VersionFinding "commit-lock-version-mismatch" "package-lock.json" "Both root lock versions must match the Host version." }
    if ($candidateVersion) {
        $escapedCandidate = [regex]::Escape($candidateVersion)
        foreach ($item in @(@{file="README.md"; statement="(?i)repository version is\s+.*$escapedCandidate"}, @{file="README_zh.md"; statement="仓库当前版本为\s+.*$escapedCandidate"})) {
            $content = Get-ScopedFileText $item.file
            if (-not $content -or $content -notmatch "version-$escapedCandidate" -or $content -notmatch $item.statement) { Add-VersionFinding "commit-readme-version-mismatch" $item.file "README badge and current Host version must remain synchronized." }
        }
        foreach ($file in @("版本更新日志.md", "版本更新日志_en.md")) {
            $content = Get-ScopedFileText $file
            if (-not (Test-VersionSectionHasEntry -Content $content -Version $candidateVersion)) { Add-VersionFinding "commit-changelog-entry-required" $file "Maintain a dated Host-version section with a concrete entry for the Host or independently versioned plugin changes." }
            if (-not $hostAdvanced) {
                $section = [regex]::Match([string]$content, "(?ms)^##\s+$escapedCandidate\s+-\s+\d{4}-\d{2}-\d{2}\s*\r?\n(?<body>.*?)(?=^##\s+|\z)").Groups["body"].Value
                foreach ($plugin in $pluginVersions) {
                    if (-not $section.Contains($plugin.sourceId) -or $section -notmatch [regex]::Escape($plugin.candidateVersion)) { Add-VersionFinding "plugin-changelog-entry-required" $file "The plugin-only record must identify $($plugin.sourceId) and its new version $($plugin.candidateVersion)." }
                }
            }
        }
    }
}

$versionGate = [pscustomobject]@{
    applicable = $versionGateApplicable
    passed = $versionFindings.Count -eq 0
    headVersion = $headVersion
    policy = "independent-host-and-plugin-semver"
    candidateVersion = $candidateVersion
    hostVersionRequired = $hostVersionRequired
    plugins = @($pluginVersions)
    applications = @($applicationVersions)
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

if ($null -ne $securityReview) { $report | Add-Member -NotePropertyName securityReview -NotePropertyValue $securityReview }

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
    if ($null -ne $securityReview) {
        Write-Output "Security adjudication: rawPassed=$($securityReview.rawPassed); resolved=$($securityReview.resolved.Count); unresolved=$($securityReview.unresolved.Count); effectivePassed=$($securityReview.effectivePassed); receiptValid=$($securityReview.receiptValid)"
    }
    Write-Output "Diff check: $(if ($diffCheckExitCode -eq 0) { 'passed' } else { 'failed' })"
    Write-Output "Version gate: $(if ($versionGate.passed) { 'passed' } else { 'failed' })"
    if ($versionGate.applicable) {
        Write-Output "Version transition: $($versionGate.headVersion) -> $($versionGate.candidateVersion) (Host architecture change: $($versionGate.hostVersionRequired))"
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
