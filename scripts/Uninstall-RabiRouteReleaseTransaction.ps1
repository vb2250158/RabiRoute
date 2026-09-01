param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$StopHostScript,
    [Parameter(Mandatory = $true)][string]$LegacyTaskMigrationScript,
    [Parameter(Mandatory = $true)][string]$AutostartScript,
    [switch]$PreflightOnly,
    [string]$TestLegacyTaskStorePath,
    [int]$TestFailDeleteAt = 0,
    [ValidateSet("", "manifest", "pointer", "bootstrap", "cleanup", "cleanup-after-root")][string]$TestFailStage = ""
)

$ErrorActionPreference = "Stop"
$AppId = "io.rabiroute.windows"
function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Is-Under([string]$Child,[string]$Parent) { ((Full $Child)+'\').StartsWith(((Full $Parent)+'\'),[StringComparison]::OrdinalIgnoreCase) }
function Get-Sha256File([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Get-Sha256Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Write-Durable([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Replace-File([string]$TemporaryPath, [string]$DestinationPath) {
    if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
        $backup = "$DestinationPath.$PID.$([guid]::NewGuid().ToString('N')).replace-backup"
        try { [IO.File]::Replace($TemporaryPath, $DestinationPath, $backup, $true) }
        finally { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    } else { [IO.File]::Move($TemporaryPath, $DestinationPath) }
}
function Write-JsonDurably([string]$Path, [object]$Value) {
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    Write-Durable $temporary ([Text.UTF8Encoding]::new($false).GetBytes((($Value | ConvertTo-Json -Depth 30) + "`n")))
    Replace-File $temporary $Path
}
function Assert-NoReparse([string]$Root) {
    $items = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    $bad = @($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
    if ($bad.Count) { throw "Active release contains a reparse point: $($bad[0].FullName)" }
}
function Invoke-LegacyTaskMigration([string]$Mode, [string]$BackupRoot = "") {
    $arguments = @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$LegacyTaskMigrationScript,"-Mode",$Mode)
    if ($BackupRoot) { $arguments += @("-BackupRoot",$BackupRoot) }
    if ($TestLegacyTaskStorePath) { $arguments += @("-TaskStorePath",$TestLegacyTaskStorePath) }
    & powershell.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Legacy wearable task $Mode failed with ExitCode=$LASTEXITCODE." }
}
function Invoke-Autostart([string]$Mode) {
    $arguments = @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$AutostartScript,"-InstallRoot",$install,"-Enabled","false")
    if ($Mode -eq "Preflight") { $arguments += "-PreflightOnly" }
    elseif ($Mode -eq "Remove") { $arguments += "-RemoveOwnedStartup" }
    else { throw "Unknown autostart transaction mode: $Mode" }
    & powershell.exe @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Autostart $Mode failed with ExitCode=$LASTEXITCODE." }
}
function Remove-LegacyTaskDurably([string]$BackupRoot) {
    $metadataPath = Join-Path $BackupRoot "task-backup.json"
    if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        Invoke-LegacyTaskMigration "Restore" $BackupRoot
        Remove-Item -LiteralPath $BackupRoot -Recurse -Force
    }
    Invoke-LegacyTaskMigration "Remove" $BackupRoot
}
function Read-ValidatedOwnedRelease([string]$Install) {
    $pointerPath = Join-Path $Install "current.json"
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $releaseId = [string]$pointer.releaseId
    if ($pointer.schemaVersion -ne 1 -or [string]$pointer.appId -ne $AppId `
        -or [string]$pointer.versionPath -ne "versions/$releaseId" `
        -or [IO.Path]::IsPathRooted([string]$pointer.versionPath) `
        -or $releaseId -ne [IO.Path]::GetFileName($releaseId) `
        -or ([string]$pointer.payloadSha256) -notmatch '^[a-fA-F0-9]{64}$') {
        throw "current.json is foreign or malformed; refusing broad uninstall."
    }
    $version = Full (Join-Path $Install ([string]$pointer.versionPath))
    if (-not (Is-Under $version (Join-Path $Install "versions")) -or -not (Test-Path -LiteralPath $version -PathType Container)) {
        throw "current.json escapes or lacks versions/."
    }
    Assert-NoReparse $version
    $manifestPath = Join-Path $version "release-manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]$manifest.appId -ne $AppId `
        -or [string]$manifest.releaseId -ne $releaseId `
        -or [string]$manifest.payloadSha256 -ne [string]$pointer.payloadSha256 `
        -or [string]::IsNullOrWhiteSpace([string]$manifest.packageVersion)) {
        throw "Active release manifest does not match current.json."
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $owned = [Collections.Generic.List[string]]::new()
    $ownedRelative = [Collections.Generic.List[string]]::new()
    $canonical = [Text.StringBuilder]::new()
    foreach ($entry in @($manifest.files)) {
        $relative = [string]$entry.path
        if (-not $relative -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..' -or -not $seen.Add($relative)) {
            throw "Unsafe or duplicate manifest path: $relative"
        }
        $file = Full (Join-Path $version ($relative -replace '/','\'))
        if (-not (Is-Under $file $version) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Manifest file is missing or escaped: $relative" }
        $item = Get-Item -LiteralPath $file -Force
        if ($item.Length -ne [long]$entry.size -or (Get-Sha256File $file) -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Manifest content mismatch: $relative"
        }
        [void]$owned.Add($file)
        [void]$ownedRelative.Add($relative)
        [void]$canonical.Append($relative + "`0" + ([long]$entry.size) + "`0" + ([string]$entry.sha256).ToLowerInvariant() + "`n")
    }
    foreach ($required in @("RabiRouteHost.Core.dll", "node.exe", "dist/manager.js", "ribiwebgui/dist/index.html", "desktop-runtime/main.py", "desktop-runtime/python/python.exe")) {
        if (-not $seen.Contains($required)) { throw "Required release file is absent from manifest: $required" }
    }
    $actual = @(Get-ChildItem -LiteralPath $version -Recurse -File -Force | ForEach-Object {
        $_.FullName.Substring($version.Length + 1).Replace('\','/')
    } | Where-Object { $_ -ne "release-manifest.json" })
    if ($actual.Count -ne $seen.Count) { throw "Active release file set does not match its manifest." }
    foreach ($relative in $actual) { if (-not $seen.Contains($relative)) { throw "Active release contains an unmanifested file: $relative" } }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $payloadSha = ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($canonical.ToString())))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $computedRelease = "$([string]$manifest.packageVersion)-$($payloadSha.Substring(0,12))"
    if ($payloadSha -ne ([string]$manifest.payloadSha256).ToLowerInvariant() -or $computedRelease -ne $releaseId) {
        throw "Active release canonical identity is invalid."
    }
    return [pscustomobject]@{ pointer=$pointer; version=$version; manifestPath=$manifestPath; owned=@($owned); ownedRelative=@($ownedRelative) }
}

$install = Full $InstallRoot
$driveRoot = [IO.Path]::GetPathRoot($install).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($install) -or $install -eq $driveRoot) { throw "InstallRoot must be an absolute application directory, not a drive root." }
if (-not (Test-Path -LiteralPath $LegacyTaskMigrationScript -PathType Leaf)) { throw "Legacy wearable task migration helper is missing." }
if (-not (Test-Path -LiteralPath $AutostartScript -PathType Leaf)) { throw "Autostart ownership helper is missing." }
if (($TestLegacyTaskStorePath -or $TestFailDeleteAt -gt 0 -or $TestFailStage) -and $env:RABIROUTE_INSTALL_TRANSACTION_TEST_MODE -ne "1") {
    throw "Uninstall transaction test controls are forbidden outside explicit transaction test mode."
}
if ($TestFailDeleteAt -lt 0) { throw "TestFailDeleteAt cannot be negative." }

$pointerPath = Join-Path $install "current.json"
$bootstrapPath = Join-Path $install "RabiRouteHost.exe"
$journalPath = Join-Path $install ".rabiroute-uninstall-transaction.json"
$stagingRoot = Join-Path $install ".install-staging"

function Save-Journal($Journal) { Write-JsonDurably $journalPath $Journal }
function Assert-SafeRelative([string]$Relative) {
    if (-not $Relative -or $Relative.Contains('\') -or $Relative.StartsWith('/') -or $Relative.Split('/') -contains '..') {
        throw "Unsafe uninstall journal manifest path: $Relative"
    }
}
function Read-ValidatedJournal {
    $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($journal.schemaVersion -ne 1 -or [string]$journal.appId -ne $AppId -or (Full ([string]$journal.installRoot)) -ne $install) {
        throw "Uninstall journal has a foreign identity."
    }
    $expectedVersion = Full (Join-Path $install "versions\$([string]$journal.releaseId)")
    $expectedTransactionRoot = Full (Join-Path $stagingRoot "uninstall-$([string]$journal.transactionId)")
    if ([string]$journal.releaseId -ne [IO.Path]::GetFileName([string]$journal.releaseId) `
        -or (Full ([string]$journal.version)) -ne $expectedVersion `
        -or (Full ([string]$journal.manifestPath)) -ne (Full (Join-Path $expectedVersion "release-manifest.json")) `
        -or (Full ([string]$journal.transactionRoot)) -ne $expectedTransactionRoot `
        -or (Full ([string]$journal.taskBackupRoot)) -ne (Full (Join-Path $expectedTransactionRoot "legacy-task"))) {
        throw "Uninstall journal paths are not canonical for this installation."
    }
    $journalOwned = @($journal.ownedRelative | ForEach-Object { [string]$_ })
    foreach ($relative in $journalOwned) { Assert-SafeRelative $relative }
    if ([string]$journal.state -eq "committed") {
        if ([string]$journal.taskState -ne "removed" -or [string]$journal.startupState -ne "removed" `
            -or [int]$journal.fileIndex -ne $journalOwned.Count -or -not [bool]$journal.manifestRemoved `
            -or -not [bool]$journal.pointerRemoved -or -not [bool]$journal.bootstrapRemoved `
            -or [string]$journal.cleanupState -notin @("pending", "transaction-root-removed")) {
            throw "Committed uninstall journal is incomplete or malformed."
        }
        return $journal
    }
    if ([string]$journal.state -ne "prepared" -or [string]$journal.cleanupState -ne "pending") {
        throw "Uninstall journal state is unsupported."
    }
    $pointerBackup = Join-Path $expectedTransactionRoot "current.json.backup"
    $manifestBackup = Join-Path $expectedTransactionRoot "release-manifest.json.backup"
    foreach ($backup in @($pointerBackup, $manifestBackup)) {
        if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Uninstall journal recovery evidence is missing." }
    }
    $pointerBytes = [IO.File]::ReadAllBytes($pointerBackup)
    $manifestBytes = [IO.File]::ReadAllBytes($manifestBackup)
    if ((Get-Sha256Bytes $pointerBytes) -ne [string]$journal.pointerBackupSha256 `
        -or (Get-Sha256Bytes $manifestBytes) -ne [string]$journal.manifestBackupSha256) {
        throw "Uninstall journal recovery evidence hash mismatch."
    }
    $pointerBackupJson = [Text.UTF8Encoding]::new($false).GetString($pointerBytes) | ConvertFrom-Json
    $manifestBackupJson = [Text.UTF8Encoding]::new($false).GetString($manifestBytes) | ConvertFrom-Json
    if ([string]$pointerBackupJson.releaseId -ne [string]$journal.releaseId `
        -or [string]$pointerBackupJson.versionPath -ne "versions/$([string]$journal.releaseId)" `
        -or [string]$manifestBackupJson.releaseId -ne [string]$journal.releaseId `
        -or [string]$manifestBackupJson.payloadSha256 -ne [string]$pointerBackupJson.payloadSha256) {
        throw "Uninstall journal recovery evidence does not match its release identity."
    }
    $expectedOwned = @($manifestBackupJson.files | ForEach-Object { [string]$_.path })
    if ($expectedOwned.Count -ne $journalOwned.Count) { throw "Uninstall journal owned-file count mismatch." }
    for ($index = 0; $index -lt $journalOwned.Count; $index++) {
        Assert-SafeRelative $journalOwned[$index]
        if ($journalOwned[$index] -cne $expectedOwned[$index]) { throw "Uninstall journal owned-file order mismatch." }
    }
    if ([int]$journal.fileIndex -lt 0 -or [int]$journal.fileIndex -gt $journalOwned.Count) { throw "Uninstall journal file cursor is invalid." }
    return $journal
}
function New-UninstallJournal($Release) {
    $transactionId = [guid]::NewGuid().ToString("N")
    $transactionRoot = Join-Path $stagingRoot "uninstall-$transactionId"
    [IO.Directory]::CreateDirectory($transactionRoot) | Out-Null
    $pointerBytes = [IO.File]::ReadAllBytes($pointerPath)
    $manifestBytes = [IO.File]::ReadAllBytes([string]$Release.manifestPath)
    Write-Durable (Join-Path $transactionRoot "current.json.backup") $pointerBytes
    Write-Durable (Join-Path $transactionRoot "release-manifest.json.backup") $manifestBytes
    $journal = [ordered]@{
        schemaVersion=1; appId=$AppId; installRoot=$install; transactionId=$transactionId
        transactionRoot=$transactionRoot; taskBackupRoot=(Join-Path $transactionRoot "legacy-task")
        releaseId=[string]$Release.pointer.releaseId; version=[string]$Release.version; manifestPath=[string]$Release.manifestPath
        pointerBackupSha256=(Get-Sha256Bytes $pointerBytes); manifestBackupSha256=(Get-Sha256Bytes $manifestBytes)
        ownedRelative=@($Release.ownedRelative); taskState="not-started"; startupState="not-started"
        fileIndex=0; manifestRemoved=$false; pointerRemoved=$false; bootstrapRemoved=$false; state="prepared"; cleanupState="pending"
    }
    Save-Journal $journal
    return $journal
}
function Invoke-TestFailure([string]$Stage, [int]$DeleteIndex = 0) {
    if ($DeleteIndex -gt 0 -and $TestFailDeleteAt -eq $DeleteIndex) { throw "Injected uninstall failure after owned-file deletion $DeleteIndex." }
    if ($Stage -and $TestFailStage -eq $Stage) { throw "Injected uninstall failure after $Stage removal." }
}
function Remove-FileVerified([string]$Path, [string]$Label) {
    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is no longer a regular file; refusing uninstall mutation." }
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $Path) { throw "$Label remained after deletion." }
}

Invoke-LegacyTaskMigration "Inspect"
Invoke-Autostart "Preflight"

$journal = $null
$release = $null
if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
    $journal = Read-ValidatedJournal
} elseif (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
    $release = Read-ValidatedOwnedRelease $install
} else {
    if (-not $PreflightOnly) {
        $taskBackupRoot = Join-Path $stagingRoot ("uninstall-legacy-task-" + [guid]::NewGuid().ToString("N"))
        Invoke-Autostart "Remove"
        Remove-LegacyTaskDurably $taskBackupRoot
        Remove-Item -LiteralPath $taskBackupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    [pscustomobject]@{ ok=$true; state="no-versioned-install"; preflight=[bool]$PreflightOnly } | ConvertTo-Json -Compress
    exit 0
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopHostScript -InstallRoot $install -WorkingRoot (Join-Path $stagingRoot "uninstall")
if ($LASTEXITCODE -ne 0) { throw "Fenced Host stop failed; uninstall is blocked." }
if ($PreflightOnly) {
    [pscustomobject]@{ ok=$true; state=$(if ($journal) { "resumable" } else { "validated" }); releaseId=$(if ($journal) { $journal.releaseId } else { $release.pointer.releaseId }) } | ConvertTo-Json -Compress
    exit 0
}
if ($null -eq $journal) { $journal = New-UninstallJournal $release }

if ([string]$journal.startupState -ne "removed") {
    $journal.startupState = "removing"
    Save-Journal $journal
    Invoke-Autostart "Remove"
    $journal.startupState = "removed"
    Save-Journal $journal
}
if ([string]$journal.taskState -ne "removed") {
    $journal.taskState = "removing"
    Save-Journal $journal
    Remove-LegacyTaskDurably ([string]$journal.taskBackupRoot)
    $journal.taskState = "removed"
    Save-Journal $journal
}

$ownedRelative = @($journal.ownedRelative | ForEach-Object { [string]$_ })
for ($index = [int]$journal.fileIndex; $index -lt $ownedRelative.Count; $index++) {
    $file = Full (Join-Path ([string]$journal.version) ($ownedRelative[$index] -replace '/','\'))
    if (-not (Is-Under $file ([string]$journal.version))) { throw "Uninstall journal file escaped its immutable version." }
    Remove-FileVerified $file "Manifest-owned release file"
    Invoke-TestFailure "" ($index + 1)
    $journal.fileIndex = $index + 1
    Save-Journal $journal
}
if (-not [bool]$journal.manifestRemoved) {
    Remove-FileVerified ([string]$journal.manifestPath) "Release manifest"
    Invoke-TestFailure "manifest"
    $journal.manifestRemoved = $true
    Save-Journal $journal
}
if (Test-Path -LiteralPath ([string]$journal.version) -PathType Container) {
    Get-ChildItem -LiteralPath ([string]$journal.version) -Recurse -Directory -Force | Sort-Object FullName -Descending | ForEach-Object {
        if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
    }
    if (-not (Get-ChildItem -LiteralPath ([string]$journal.version) -Force)) { Remove-Item -LiteralPath ([string]$journal.version) -Force }
}
if (-not [bool]$journal.pointerRemoved) {
    Remove-FileVerified $pointerPath "current.json"
    Invoke-TestFailure "pointer"
    $journal.pointerRemoved = $true
    Save-Journal $journal
}
if (-not [bool]$journal.bootstrapRemoved) {
    Remove-FileVerified $bootstrapPath "RabiRouteHost bootstrap"
    Invoke-TestFailure "bootstrap"
    $journal.bootstrapRemoved = $true
    Save-Journal $journal
}
if ([string]$journal.state -ne "committed") {
    $journal.state = "committed"
    Save-Journal $journal
    Invoke-TestFailure "cleanup"
}
if ([string]$journal.cleanupState -ne "transaction-root-removed") {
    if (Test-Path -LiteralPath ([string]$journal.transactionRoot)) {
        Remove-Item -LiteralPath ([string]$journal.transactionRoot) -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath ([string]$journal.transactionRoot)) { throw "Committed uninstall transaction evidence remained after cleanup." }
    Invoke-TestFailure "cleanup-after-root"
    $journal.cleanupState = "transaction-root-removed"
    Save-Journal $journal
}
Remove-Item -LiteralPath $journalPath -Force -ErrorAction Stop
if (Test-Path -LiteralPath $journalPath) { throw "Committed uninstall journal remained after cleanup." }
[pscustomobject]@{ ok=$true; state="removed-owned-code"; preservedData=$true; preservedForeign=$true } | ConvertTo-Json -Compress
