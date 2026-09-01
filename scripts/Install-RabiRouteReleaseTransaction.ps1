param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$PortableZip,
    [Parameter(Mandatory = $true)][string]$ExpectedReleaseId,
    [Parameter(Mandatory = $true)][string]$StopHostScript,
    [Parameter(Mandatory = $true)][string]$LegacyMigrationScript,
    [Parameter(Mandatory = $true)][string]$LegacyTaskMigrationScript,
    [Parameter(Mandatory = $true)][string]$AutostartScript,
    [ValidateSet("true", "false")][string]$AutostartEnabled = "false",
    [ValidateSet("", "after-recovery", "after-stage", "after-legacy-task-remove", "after-legacy-task-remove-before-journal", "after-version-move-before-journal", "before-pointer", "after-bootstrap", "after-pointer", "after-autostart-before-journal", "after-autostart")][string]$FaultPoint = "",
    [string]$TestSelfTestScript,
    [string]$TestLegacyTaskStorePath
)

$ErrorActionPreference = "Stop"
$AppId = "io.rabiroute.windows"

function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Get-InstallMutexName([string]$NormalizedInstallRoot) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($NormalizedInstallRoot.ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return "Local\RabiRoute.Install.$($digest.Substring(0, 32))"
}
function Enter-InstallMutex([string]$NormalizedInstallRoot) {
    $mutex = [Threading.Mutex]::new($false, (Get-InstallMutexName $NormalizedInstallRoot))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Another RabiRoute install or Developer activation is already mutating this installation." }
        return $mutex
    } catch {
        if (-not $acquired) { $mutex.Dispose() }
        throw
    }
}
function Is-Under([string]$Child, [string]$Parent) {
    $c = (Full $Child) + '\'; $p = (Full $Parent) + '\'
    $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}
function Move-DirectoryWithRetry([string]$Source, [string]$Destination, [string]$Label) {
    $lastFailure = $null
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        try {
            [IO.Directory]::Move($Source, $Destination)
            return
        } catch { $lastFailure = $_.Exception }
        if (-not (Test-Path -LiteralPath $Source) -and (Test-Path -LiteralPath $Destination -PathType Container)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw [IO.IOException]::new("$Label remained blocked after 30 seconds: $Source", $lastFailure)
}
function Write-Durable([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Write-JsonDurable([string]$Path, [object]$Value) {
    $tmp = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    Write-Durable $tmp ([Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20) + "`n"))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        [IO.File]::Replace($tmp, $Path, [System.Management.Automation.Language.NullString]::Value, $true)
    } else { [IO.File]::Move($tmp, $Path) }
}
function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Label) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "$Label failed with ExitCode=$($process.ExitCode)." }
}
function Invoke-BootstrapSelfTest([string]$Bootstrap, [string]$Label) {
    if ($TestSelfTestScript) {
        Invoke-Checked "powershell.exe" @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$TestSelfTestScript,"-Bootstrap",$Bootstrap) $Label
    } else { Invoke-Checked $Bootstrap @("--self-test") $Label }
}
function Invoke-LegacyTaskMigration([string]$Mode, [string]$BackupRoot = "") {
    $arguments = @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$LegacyTaskMigrationScript,"-Mode",$Mode)
    if ($BackupRoot) { $arguments += @("-BackupRoot",$BackupRoot) }
    if ($TestLegacyTaskStorePath) { $arguments += @("-TaskStorePath",$TestLegacyTaskStorePath) }
    & powershell.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Legacy wearable task $Mode failed with ExitCode=$LASTEXITCODE." }
}
function Invoke-Autostart([switch]$Preflight, [switch]$Restore, [string]$SnapshotRoot = "") {
    $arguments = @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$AutostartScript,"-InstallRoot",$install,"-Enabled",$AutostartEnabled)
    if ($Preflight) { $arguments += "-PreflightOnly" }
    if ($Restore) { $arguments += "-RestoreSnapshot" }
    if ($SnapshotRoot) { $arguments += @("-SnapshotRoot",$SnapshotRoot) }
    & powershell.exe @arguments | Out-Null
    $label = if ($Restore) { "Autostart rollback" } elseif ($Preflight) { "Autostart preflight" } else { "Autostart commit" }
    if ($LASTEXITCODE -ne 0) { throw "$label failed with ExitCode=$LASTEXITCODE." }
}
function Assert-NoReparse([string]$Root) {
    $rootItem = Get-Item -LiteralPath $Root -Force
    $items = @($rootItem) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    $bad = @($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($bad.Count) { throw "Candidate contains a reparse point: $($bad[0].FullName)" }
}
function Get-Sha256File([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Read-Candidate([string]$Candidate, [string]$Expected) {
    Assert-NoReparse $Candidate
    $allowedRoot = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @("RabiRouteHost.exe","current.json","versions")) { [void]$allowedRoot.Add($name) }
    foreach ($entry in Get-ChildItem -LiteralPath $Candidate -Force) {
        if (-not $allowedRoot.Contains($entry.Name)) { throw "Candidate distribution contains an unowned root entry: $($entry.Name)" }
    }
    $candidateVersions = @(Get-ChildItem -LiteralPath (Join-Path $Candidate "versions") -Directory -Force)
    if ($candidateVersions.Count -ne 1 -or $candidateVersions[0].Name -ne $Expected) { throw "Candidate versions/ must contain exactly the fenced release." }
    foreach ($private in @("data", "logs", "recordings", "transcripts")) {
        if (Test-Path -LiteralPath (Join-Path $Candidate $private)) { throw "Candidate contains private/runtime root: $private" }
    }
    $pointerPath = Join-Path $Candidate "current.json"
    $bootstrap = Join-Path $Candidate "RabiRouteHost.exe"
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw "Candidate lacks bootstrap or current.json." }
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pointer.schemaVersion -ne 1 -or [string]$pointer.appId -ne $AppId -or [string]$pointer.releaseId -ne $Expected) { throw "Candidate pointer identity mismatch." }
    $expectedVersionPath = "versions/$Expected"
    if ([string]$pointer.versionPath -ne $expectedVersionPath -or [IO.Path]::IsPathRooted([string]$pointer.versionPath)) { throw "Candidate versionPath is not canonical." }
    $version = Full (Join-Path $Candidate ([string]$pointer.versionPath))
    if (-not (Is-Under $version (Join-Path $Candidate "versions"))) { throw "Candidate versionPath escapes versions/." }
    $manifestPath = Join-Path $version "release-manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]$manifest.appId -ne $AppId -or [string]$manifest.releaseId -ne $Expected -or [string]$manifest.payloadSha256 -ne [string]$pointer.payloadSha256) { throw "Pointer and release manifest do not fence the same payload." }
    $required = @("RabiRouteHost.Core.dll", "node.exe", "dist/manager.js", "ribiwebgui/dist/index.html", "desktop-runtime/main.py", "desktop-runtime/python/python.exe")
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($manifest.files)) {
        $relative = [string]$entry.path
        if (-not $relative -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..' -or -not $seen.Add($relative)) { throw "Manifest contains an unsafe or duplicate path: $relative" }
        $file = Full (Join-Path $version ($relative -replace '/', '\'))
        if (-not (Is-Under $file $version) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Manifest file is missing or escaped: $relative" }
        $item = Get-Item -LiteralPath $file
        if ($item.Length -ne [long]$entry.size) { throw "Manifest size mismatch: $relative" }
        if ((Get-Sha256File $file) -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Manifest hash mismatch: $relative" }
    }
    foreach ($relative in $required) { if (-not $seen.Contains($relative)) { throw "Required version payload file is missing from manifest: $relative" } }
    $actual = @(Get-ChildItem -LiteralPath $version -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($version.Length + 1).Replace('\','/') } | Where-Object { $_ -ne 'release-manifest.json' })
    foreach ($relative in $actual) { if (-not $seen.Contains($relative)) { throw "Version payload contains an unmanifested file: $relative" } }
    $canonical = [Text.StringBuilder]::new()
    foreach ($entry in @($manifest.files)) {
        [void]$canonical.Append(([string]$entry.path) + "`0" + ([long]$entry.size) + "`0" + ([string]$entry.sha256).ToLowerInvariant() + "`n")
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($canonical.ToString())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $computedPayload = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    $computedRelease = "$([string]$manifest.packageVersion)-$($computedPayload.Substring(0,12))"
    if ($computedPayload -ne ([string]$manifest.payloadSha256).ToLowerInvariant() -or $computedRelease -ne $Expected) { throw "Canonical payload identity does not match manifest/releaseId." }
    return [pscustomobject]@{ pointer = $pointer; version = $version; bootstrap = $bootstrap }
}
function Restore-Previous([string]$Install, [string]$PointerBackup, [string]$BootstrapBackup, [bool]$HadPointer, [bool]$HadBootstrap) {
    $pointer = Join-Path $Install "current.json"; $bootstrap = Join-Path $Install "RabiRouteHost.exe"
    foreach ($item in @(
        [pscustomobject]@{ Had=$HadPointer; Backup=$PointerBackup; Destination=$pointer; Name="pointer" },
        [pscustomobject]@{ Had=$HadBootstrap; Backup=$BootstrapBackup; Destination=$bootstrap; Name="bootstrap" }
    )) {
        if (-not $item.Had) { Remove-Item -LiteralPath $item.Destination -Force -ErrorAction SilentlyContinue; continue }
        if (-not (Test-Path -LiteralPath $item.Backup -PathType Leaf)) { throw "Rollback $($item.Name) backup is missing." }
        $temporary = "$($item.Destination).restore.$PID.tmp"
        Write-Durable $temporary ([IO.File]::ReadAllBytes($item.Backup))
        if (Test-Path -LiteralPath $item.Destination -PathType Leaf) {
            [IO.File]::Replace($temporary, $item.Destination, [System.Management.Automation.Language.NullString]::Value, $true)
        } else { [IO.File]::Move($temporary, $item.Destination) }
    }
}
function Assert-RestoredPointerReleaseId([string]$Install, [string]$PointerBackup, [bool]$HadPointer) {
    $pointerPath = Join-Path $Install "current.json"
    if (-not $HadPointer) {
        if (Test-Path -LiteralPath $pointerPath) { throw "Rollback left a current pointer where none existed before installation." }
        return
    }
    if (-not (Test-Path -LiteralPath $PointerBackup -PathType Leaf) -or -not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        throw "Rollback current pointer or its backup is missing."
    }
    $expected = [Text.UTF8Encoding]::new($false).GetString([IO.File]::ReadAllBytes($PointerBackup)) | ConvertFrom-Json
    $actual = [Text.UTF8Encoding]::new($false).GetString([IO.File]::ReadAllBytes($pointerPath)) | ConvertFrom-Json
    $expectedReleaseId = [string]$expected.releaseId
    if ($expected.schemaVersion -ne 1 -or [string]$expected.appId -ne $AppId -or [string]::IsNullOrWhiteSpace($expectedReleaseId)) {
        throw "Rollback pointer backup has an invalid application or release identity."
    }
    if ($actual.schemaVersion -ne 1 -or [string]$actual.appId -ne $AppId -or [string]$actual.releaseId -cne $expectedReleaseId) {
        throw "Rollback current pointer releaseId verification failed; expected '$expectedReleaseId'."
    }
}
function Get-RetiredLifecyclePaths {
    return @(
        "RabiRoute-Desktop.exe", "RabiRoute-Tray.exe", "RabiRoute-Tray.new.exe",
        "Start-RabiRoute-Tray.bat", "Start-RabiRoute-Health-Watchdog.bat", "Start-RabiRoute-MessageAdapter-Watchdog.bat",
        "scripts\Install-RabiRoute-HealthWatchdogTask.ps1", "scripts\watch-message-adapters.ps1",
        "scripts\watch-rabiroute-desktop-lifecycle.ps1", "scripts\watch-rabiroute-health-hidden.vbs", "scripts\watch-rabiroute-health.ps1"
    )
}
function Assert-QuarantineJournal([object[]]$Moves, [string]$Install, [string]$QuarantineRoot, [string]$TransactionRoot) {
    $transactionId = Split-Path -Leaf (Full $TransactionRoot)
    $expectedRoot = Full (Join-Path $Install (".rabiroute-quarantine\" + $transactionId + "\legacy-runtime"))
    if ((Full $QuarantineRoot) -ne $expectedRoot) { throw "Transaction journal references an unsafe quarantine root." }
    $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in @((Get-RetiredLifecyclePaths) + @("node.exe"))) { [void]$allowed.Add($relative.Replace('\','/')) }
    foreach ($move in @($Moves)) {
        $relative = ([string]$move.relative).Replace('\','/')
        if (-not $allowed.Contains($relative)) { throw "Transaction journal references a non-retired quarantine entry: $relative" }
        $expectedSource = Full (Join-Path $Install ($relative -replace '/','\'))
        $expectedDestination = Full (Join-Path $expectedRoot (($relative -replace '/','\') + ".retired"))
        if ((Full ([string]$move.source)) -ne $expectedSource -or (Full ([string]$move.destination)) -ne $expectedDestination) {
            throw "Transaction journal quarantine mapping is not canonical: $relative"
        }
    }
    return $expectedRoot
}
function Restore-Quarantined([object[]]$Moves, [string]$Install, [string]$QuarantineRoot, [string]$TransactionRoot) {
    $QuarantineRoot = Assert-QuarantineJournal $Moves $Install $QuarantineRoot $TransactionRoot
    $items = @($Moves)
    [array]::Reverse($items)
    foreach ($move in $items) {
        $source = Full ([string]$move.source); $destination = Full ([string]$move.destination)
        if (-not (Is-Under $source $Install) -or -not (Is-Under $destination $QuarantineRoot)) { throw "Quarantine journal contains an unsafe path." }
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            if (Test-Path -LiteralPath $source) { throw "Cannot restore quarantined entry because its source is occupied: $source" }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($source)) | Out-Null
            [IO.File]::Move($destination, $source)
        } elseif (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Quarantined entry is missing at both source and destination: $source" }
    }
    if ($QuarantineRoot -and (Test-Path -LiteralPath $QuarantineRoot -PathType Container) -and -not (Get-ChildItem -LiteralPath $QuarantineRoot -Recurse -Force -File)) {
        Remove-Item -LiteralPath $QuarantineRoot -Recurse -Force
    }
}
function Get-LegacyQuarantinePlan([string]$Install, [string]$Version, [string]$QuarantineRoot) {
    $retired = @(Get-RetiredLifecyclePaths)
    $plan = [Collections.Generic.List[object]]::new()
    foreach ($relative in $retired) {
        $source = Join-Path $Install $relative
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $plan.Add([pscustomobject]@{ relative=$relative.Replace('\','/'); source=(Full $source); destination=(Full (Join-Path $QuarantineRoot ($relative + ".retired"))); status="planned" })
        }
    }
    $rootNode = Join-Path $Install "node.exe"
    if (Test-Path -LiteralPath $rootNode -PathType Leaf) {
        $packagePath = Join-Path $Install "package.json"
        $oldManager = Join-Path $Install "dist\manager.js"
        $newNode = Join-Path $Version "node.exe"
        $ownedPackage = $false
        if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
            try { $ownedPackage = ((Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq "rabiroute") } catch { $ownedPackage = $false }
        }
        if (-not $ownedPackage -or -not (Test-Path -LiteralPath $oldManager -PathType Leaf) -or -not (Test-Path -LiteralPath $newNode -PathType Leaf)) {
            throw "Root node.exe is not provably the old RabiRoute Manager runtime; refusing to quarantine it."
        }
        $plan.Add([pscustomobject]@{ relative="node.exe"; source=(Full $rootNode); destination=(Full (Join-Path $QuarantineRoot "node.exe.retired")); status="planned" })
    }
    foreach ($move in $plan) {
        if (Test-Path -LiteralPath $move.destination) { throw "Quarantine destination already exists: $($move.destination)" }
    }
    return @($plan)
}
function Remove-JournalVersionIfOwned([object]$Journal, [string]$Install) {
    $moveState = [string]$Journal.versionMoveState
    if (-not [bool]$Journal.versionCommitted -and $moveState -notin @("planned", "committed")) { return }
    $releaseId = [string]$Journal.releaseId
    if ([string]::IsNullOrWhiteSpace($releaseId) -or $releaseId -ne [IO.Path]::GetFileName($releaseId) -or $releaseId -in @(".", "..")) {
        throw "Transaction journal contains an unsafe releaseId."
    }
    $expected = Full (Join-Path (Join-Path $Install "versions") $releaseId)
    $destination = Full ([string]$Journal.destinationVersion)
    if ($destination -ne $expected) { throw "Transaction journal references a non-canonical version destination." }
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) { return }
    $manifestPath = Join-Path $destination "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Journal-owned version lacks a release manifest; refusing recovery deletion." }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]$manifest.appId -ne $AppId -or [string]$manifest.releaseId -ne $releaseId) {
        throw "Journal-owned version identity does not match the pending transaction."
    }
    Remove-Item -LiteralPath $destination -Recurse -Force
}

$install = Full $InstallRoot
if (-not [IO.Path]::IsPathRooted($install) -or $install -eq (Full ([IO.Path]::GetPathRoot($install)))) { throw "InstallRoot must be an absolute application directory, not a drive root." }
foreach ($script in @($StopHostScript,$LegacyMigrationScript,$LegacyTaskMigrationScript,$AutostartScript)) { if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Required transaction helper is missing: $script" } }
if (($FaultPoint -or $TestSelfTestScript -or $TestLegacyTaskStorePath) -and $env:RABIROUTE_INSTALL_TRANSACTION_TEST_MODE -ne "1") { throw "Test hooks are forbidden outside explicit transaction test mode." }
if (-not (Test-Path -LiteralPath $PortableZip -PathType Leaf)) { throw "Portable ZIP is missing." }
$installMutex = Enter-InstallMutex $install
try {
# Fail closed before creating staging or stopping any process when a foreign
# same-name task occupies the retired product identity.
Invoke-LegacyTaskMigration "Inspect"
[IO.Directory]::CreateDirectory($install) | Out-Null
$journal = Join-Path $install ".rabiroute-install-transaction.json"
if (Test-Path -LiteralPath $journal) {
    $previous = Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$previous.appId -ne $AppId) { throw "Foreign transaction journal blocks installation: $journal" }
    $previousRoot = Full ([string]$previous.transactionRoot)
    $stagingRoot = Join-Path $install ".install-staging"
    if (-not (Is-Under $previousRoot $stagingRoot)) { throw "Transaction journal references an unsafe staging root." }
    $priorPointer = Join-Path $previousRoot "backup\current.json"; $priorBootstrap = Join-Path $previousRoot "backup\RabiRouteHost.exe"
    $needsPointerRestore = [string]$previous.state -in @("switching","switched","autostart-applying","autostart-applied","rolled-back")
    $initialPointerRecoveryFailure = $null
    if ($needsPointerRestore) {
        try {
            Restore-Previous $install $priorPointer $priorBootstrap ([bool]$previous.hadPointer) ([bool]$previous.hadBootstrap)
        } catch {
            $initialPointerRecoveryFailure = $_
        }
    }
    $autostartRecoveryFailure = $null
    if ([string]$previous.autostartState -in @("applying", "applied")) {
        try {
            $expectedAutostartSnapshot = Full (Join-Path $previousRoot "backup\autostart")
            if ((Full ([string]$previous.autostartSnapshotRoot)) -ne $expectedAutostartSnapshot) {
                throw "Transaction journal references an unsafe autostart snapshot root."
            }
            Invoke-Autostart -Restore -SnapshotRoot $expectedAutostartSnapshot
        } catch {
            $autostartRecoveryFailure = $_
        }
    }
    $pointerRecoveryFailure = $null
    try {
        if ($needsPointerRestore) {
            # Repeat after the autostart helper so even a failing helper cannot
            # leave current.json or the bootstrap on the candidate release.
            Restore-Previous $install $priorPointer $priorBootstrap ([bool]$previous.hadPointer) ([bool]$previous.hadBootstrap)
        }
        Assert-RestoredPointerReleaseId $install $priorPointer ([bool]$previous.hadPointer)
    } catch {
        $pointerRecoveryFailure = $_
    }
    if ([string]$previous.legacyTaskMigrationState -in @("planned", "removed")) {
        $expectedTaskBackup = Full (Join-Path $previousRoot "backup\legacy-wearable-task")
        if ((Full ([string]$previous.legacyTaskBackupRoot)) -ne $expectedTaskBackup) {
            throw "Transaction journal references an unsafe legacy task backup root."
        }
        Invoke-LegacyTaskMigration "Restore" $expectedTaskBackup
    }
    if ($previous.quarantineMoves) { Restore-Quarantined @($previous.quarantineMoves) $install ([string]$previous.quarantineRoot) $previousRoot }
    if (-not $pointerRecoveryFailure) { Remove-JournalVersionIfOwned $previous $install }
    if ($autostartRecoveryFailure -or $pointerRecoveryFailure) {
        $autostartMessage = if ($autostartRecoveryFailure) { $autostartRecoveryFailure.Exception.Message } else { "none" }
        $pointerMessage = if ($pointerRecoveryFailure) {
            $pointerRecoveryFailure.Exception.Message
        } elseif ($initialPointerRecoveryFailure) {
            "initial restore failed but the verified post-autostart restore recovered"
        } else {
            "none"
        }
        throw "Previous install recovery was incomplete. autostart=$autostartMessage pointer=$pointerMessage"
    }
    Remove-Item -LiteralPath $previousRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $journal -Force
}
if ($FaultPoint -eq "after-recovery") { exit 95 }
$transactionRoot = Join-Path $install (".install-staging\" + [guid]::NewGuid().ToString("N"))
$transactionId = Split-Path -Leaf $transactionRoot
$quarantineRoot = Join-Path $install (".rabiroute-quarantine\" + $transactionId + "\legacy-runtime")
$candidate = Join-Path $transactionRoot "candidate"
$backup = Join-Path $transactionRoot "backup"
[IO.Directory]::CreateDirectory($candidate) | Out-Null; [IO.Directory]::CreateDirectory($backup) | Out-Null
$pointerPath = Join-Path $install "current.json"; $bootstrapPath = Join-Path $install "RabiRouteHost.exe"
$hadPointer = Test-Path -LiteralPath $pointerPath -PathType Leaf; $hadBootstrap = Test-Path -LiteralPath $bootstrapPath -PathType Leaf
$pointerBackup = Join-Path $backup "current.json"; $bootstrapBackup = Join-Path $backup "RabiRouteHost.exe"
if ($hadPointer) { Write-Durable $pointerBackup ([IO.File]::ReadAllBytes($pointerPath)) }
if ($hadBootstrap) { Write-Durable $bootstrapBackup ([IO.File]::ReadAllBytes($bootstrapPath)) }
$switched = $false
$versionCommitted = $false
$quarantineMoves = @()
$legacyTaskMigrationState = "not-started"
$legacyTaskBackupRoot = Join-Path $backup "legacy-wearable-task"
$autostartState = "not-started"
$autostartSnapshotRoot = Join-Path $backup "autostart"
$destinationVersion = Join-Path (Join-Path $install "versions") $ExpectedReleaseId
function Save-Journal([string]$State, [string]$VersionMoveState, [bool]$VersionIsCommitted, [string]$ErrorMessage = "") {
    $entry = [ordered]@{
        schemaVersion=1; appId=$AppId; state=$State; releaseId=$ExpectedReleaseId
        transactionRoot=$transactionRoot; destinationVersion=$destinationVersion
        versionMoveState=$VersionMoveState; versionCommitted=$VersionIsCommitted
        hadPointer=$hadPointer; hadBootstrap=$hadBootstrap
        quarantineRoot=$quarantineRoot; quarantineMoves=$quarantineMoves
        legacyTaskMigrationState=$legacyTaskMigrationState
        legacyTaskBackupRoot=$legacyTaskBackupRoot
        autostartState=$autostartState
        autostartSnapshotRoot=$autostartSnapshotRoot
    }
    if ($ErrorMessage) { $entry.error = $ErrorMessage }
    Write-JsonDurable $journal $entry
}
try {
    Save-Journal "staging" "not-started" $false
    Expand-Archive -LiteralPath $PortableZip -DestinationPath $candidate -Force
    $release = Read-Candidate $candidate $ExpectedReleaseId
    if ($FaultPoint -eq "after-stage") { throw "Injected fault after-stage" }
    Invoke-BootstrapSelfTest $release.bootstrap "Candidate bootstrap self-test"
    Invoke-Autostart -Preflight -SnapshotRoot $autostartSnapshotRoot
    $autostartState = "captured"
    Save-Journal "autostart-snapshot-captured" "not-started" $false
    $legacyTaskMigrationState = "planned"
    Save-Journal "legacy-task-removal-planned" "not-started" $false
    Invoke-LegacyTaskMigration "Remove" $legacyTaskBackupRoot
    if ($FaultPoint -eq "after-legacy-task-remove-before-journal") { exit 96 }
    $legacyTaskMigrationState = "removed"
    Save-Journal "legacy-task-removed" "not-started" $false
    if ($FaultPoint -eq "after-legacy-task-remove") { throw "Injected fault after-legacy-task-remove" }
    Invoke-Checked "powershell.exe" @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$StopHostScript,"-InstallRoot",$install,"-WorkingRoot",$transactionRoot) "Fenced Host stop"
    Invoke-Checked "powershell.exe" @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$LegacyMigrationScript,"-InstallRoot",$install) "Legacy lifecycle migration"
    $quarantineMoves = @(Get-LegacyQuarantinePlan $install $release.version $quarantineRoot)
    if ($quarantineMoves.Count) {
        Save-Journal "quarantining" "not-started" $false
        foreach ($move in $quarantineMoves) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([string]$move.destination)) | Out-Null
            [IO.File]::Move([string]$move.source, [string]$move.destination)
            $move.status = "moved"
            Save-Journal "quarantining" "not-started" $false
        }
    }
    $versionsRoot = Join-Path $install "versions"; [IO.Directory]::CreateDirectory($versionsRoot) | Out-Null
    if (Test-Path -LiteralPath $destinationVersion) { throw "Immutable release already exists; refusing to overwrite: $ExpectedReleaseId" }
    Save-Journal "version-move-planned" "planned" $false
    Move-DirectoryWithRetry $release.version $destinationVersion "Version directory commit"
    if ($FaultPoint -eq "after-version-move-before-journal") { exit 97 }
    $versionCommitted = $true
    Save-Journal "version-committed" "committed" $true
    if ($FaultPoint -eq "before-pointer") { throw "Injected fault before-pointer" }
    Save-Journal "switching" "committed" $true
    Write-Durable "$bootstrapPath.new" ([IO.File]::ReadAllBytes($release.bootstrap))
    Write-Durable "$pointerPath.new" ([IO.File]::ReadAllBytes((Join-Path $candidate "current.json")))
    $switched = $true
    if ($hadBootstrap) {
        [IO.File]::Replace("$bootstrapPath.new", $bootstrapPath, [System.Management.Automation.Language.NullString]::Value, $true)
    } else { [IO.File]::Move("$bootstrapPath.new", $bootstrapPath) }
    if ($FaultPoint -eq "after-bootstrap") { throw "Injected fault after-bootstrap" }
    if ($hadPointer) {
        [IO.File]::Replace("$pointerPath.new", $pointerPath, [System.Management.Automation.Language.NullString]::Value, $true)
    } else { [IO.File]::Move("$pointerPath.new", $pointerPath) }
    Save-Journal "switched" "committed" $true
    if ($FaultPoint -eq "after-pointer") { throw "Injected fault after-pointer" }
    Invoke-BootstrapSelfTest $bootstrapPath "Installed bootstrap self-test"
    $autostartState = "applying"
    Save-Journal "autostart-applying" "committed" $true
    Invoke-Autostart -SnapshotRoot $autostartSnapshotRoot
    if ($FaultPoint -eq "after-autostart-before-journal") { exit 98 }
    $autostartState = "applied"
    Save-Journal "autostart-applied" "committed" $true
    if ($FaultPoint -eq "after-autostart") { throw "Injected fault after-autostart" }
    Remove-Item -LiteralPath $journal -Force
    Remove-Item -LiteralPath $transactionRoot -Recurse -Force
    [pscustomobject]@{ ok=$true; releaseId=$ExpectedReleaseId; state="committed" } | ConvertTo-Json -Compress
} catch {
    $failure = $_
    $initialPointerRollbackFailure = $null
    if ($switched) {
        try {
            Restore-Previous $install $pointerBackup $bootstrapBackup $hadPointer $hadBootstrap
        } catch {
            $initialPointerRollbackFailure = $_
        }
    }
    $autostartRollbackFailure = $null
    if ($autostartState -in @("applying", "applied")) {
        try {
            Invoke-Autostart -Restore -SnapshotRoot $autostartSnapshotRoot
            $autostartState = "restored"
        } catch {
            $autostartRollbackFailure = $_
        }
    }
    $pointerRollbackFailure = $null
    try {
        if ($switched) {
            # Re-apply the exact backup after autostart rollback, then verify
            # the logical release identity read from current.json.
            Restore-Previous $install $pointerBackup $bootstrapBackup $hadPointer $hadBootstrap
        }
        Assert-RestoredPointerReleaseId $install $pointerBackup $hadPointer
    } catch {
        $pointerRollbackFailure = $_
    }
    if ($versionCommitted -and -not $pointerRollbackFailure) { Remove-Item -LiteralPath $destinationVersion -Recurse -Force -ErrorAction SilentlyContinue }
    if ($quarantineMoves.Count) { Restore-Quarantined $quarantineMoves $install $quarantineRoot $transactionRoot }
    if ($legacyTaskMigrationState -in @("planned", "removed")) {
        Invoke-LegacyTaskMigration "Restore" $legacyTaskBackupRoot
        $legacyTaskMigrationState = "restored"
    }
    Remove-Item -LiteralPath "$pointerPath.new","$bootstrapPath.new" -Force -ErrorAction SilentlyContinue
    $failureMessage = $failure.Exception.Message
    if ($autostartRollbackFailure) {
        $failureMessage += " | autostart rollback: $($autostartRollbackFailure.Exception.Message)"
    }
    if ($pointerRollbackFailure) {
        $failureMessage += " | pointer rollback: $($pointerRollbackFailure.Exception.Message)"
    } elseif ($initialPointerRollbackFailure) {
        $failureMessage += " | initial pointer rollback retried and verified after autostart"
    }
    Save-Journal "rolled-back" ($(if ($versionCommitted) { "committed" } else { "not-started" })) $versionCommitted $failureMessage
    if ($autostartRollbackFailure -or $pointerRollbackFailure) {
        $autostartMessage = if ($autostartRollbackFailure) { $autostartRollbackFailure.Exception.Message } else { "none" }
        $pointerMessage = if ($pointerRollbackFailure) { $pointerRollbackFailure.Exception.Message } else { "none" }
        throw "Install transaction failed and rollback was incomplete. original=$($failure.Exception.Message) autostart=$autostartMessage pointer=$pointerMessage"
    }
    throw $failure
}
}
finally {
    $installMutex.ReleaseMutex()
    $installMutex.Dispose()
}
