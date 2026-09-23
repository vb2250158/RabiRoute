[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$ExpectedCurrentReleaseId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedJournalSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedCurrentPointerSha256,
    [switch]$Archive
)

# Explicit operator-only admission. No installer/Developer entrypoint calls this script.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$AppId = 'io.rabiroute.windows'
function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Hash-File([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Assert-Path([string]$Path) {
    if ($Path -cne (Full $Path) -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':')) { throw "Evidence path is not canonical local absolute: $Path" }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if (-not $part -or $part -in @('.','..') -or $part -match '[. ]$') { throw 'Evidence path has an ambiguous component.' }
    }
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse evidence path refused.' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
function Assert-Tree([string]$Root) {
    Assert-Path $Root
    # Enumerate one level at a time: never traverse an unvalidated junction.
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        Assert-Path $item.FullName
        if ($item.PSIsContainer) { Assert-Tree $item.FullName }
    }
}
function Read-Json([string]$Path) {
    Assert-Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing evidence file: $Path" }
    if ((Get-Item -LiteralPath $Path).Length -gt 32MB) { throw 'Evidence JSON exceeds bounded size.' }
    [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($Path)).TrimStart([char]0xfeff) | ConvertFrom-Json
}
function Assert-Id([string]$Id) {
    if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$' -or $Id.EndsWith('.')) { throw 'Unsafe release identity.' }
}
function Assert-Pointer($Pointer, [string]$Expected='') {
    Assert-Id ([string]$Pointer.releaseId)
    if ($Pointer.schemaVersion -ne 1 -or $Pointer.appId -cne $AppId -or
        $Pointer.versionPath -cne "versions/$($Pointer.releaseId)" -or $Pointer.payloadSha256 -notmatch '^[a-f0-9]{64}$' -or
        ($Expected -and $Pointer.releaseId -cne $Expected)) { throw 'Pointer identity mismatch.' }
}
function Assert-Release([string]$Root, [string]$Expected, [string]$Scope) {
    Write-Verbose "archive-check scope=$Scope state=starting"
    $pointer = Read-Json (Join-Path $Root 'current.json')
    Assert-Pointer $pointer $Expected
    $version = Join-Path $Root "versions\$Expected"
    Write-Verbose 'archive-check stage=release-tree state=starting'
    Assert-Tree $version
    Write-Verbose 'archive-check stage=release-tree state=complete'
    $manifest = Read-Json (Join-Path $version 'release-manifest.json')
    if ($manifest.schemaVersion -ne 1 -or $manifest.appId -cne $AppId -or $manifest.releaseId -cne $Expected -or
        $manifest.payloadSha256 -cne $pointer.payloadSha256) { throw 'Current manifest identity mismatch.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $canonical = [Text.StringBuilder]::new()
    $processed = 0
    $total = @($manifest.files).Count
    Write-Verbose "archive-check stage=manifest-hash state=starting processed=0 total=$total"
    foreach ($entry in @($manifest.files)) {
        $relative = [string]$entry.path
        if (-not $relative -or $relative -match '[\\:*?"<>|]' -or $relative.StartsWith('/') -or
            @($relative.Split('/') | Where-Object { -not $_ -or $_ -in @('.','..') -or $_ -match '[. ]$' }).Count -or
            -not $seen.Add($relative) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unsafe manifest entry.' }
        $file = Join-Path $version ($relative.Replace('/','\'))
        Assert-Path $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne [long]$entry.size -or
            (Hash-File $file) -cne $entry.sha256) { throw 'Current payload hash/size mismatch.' }
        [void]$canonical.Append("$relative`0$([long]$entry.size)`0$($entry.sha256)`n")
        $processed++
        if ($processed % 1000 -eq 0) { Write-Verbose "archive-check stage=manifest-hash state=progress processed=$processed total=$total" }
    }
    Write-Verbose "archive-check stage=manifest-hash state=complete processed=$processed total=$total"
    foreach ($required in @('RabiRouteHost.Core.dll','node.exe','dist/manager.js','ribiwebgui/dist/index.html','desktop-runtime/main.py','desktop-runtime/python/python.exe')) {
        if (-not $seen.Contains($required)) { throw 'Incomplete current release manifest.' }
    }
    Write-Verbose 'archive-check stage=extra-files state=starting'
    foreach ($file in Get-ChildItem -LiteralPath $version -Recurse -Force -File) {
        $relative = $file.FullName.Substring($version.Length+1).Replace('\','/')
        if ($relative -cne 'release-manifest.json' -and -not $seen.Contains($relative)) { throw 'Unmanifested current payload.' }
    }
    Write-Verbose 'archive-check stage=extra-files state=complete'
    $payload = Hash-Bytes ([Text.UTF8Encoding]::new($false).GetBytes($canonical.ToString()))
    if ($payload -cne $pointer.payloadSha256 -or "$($manifest.packageVersion)-$($payload.Substring(0,12))" -cne $Expected) { throw 'Canonical release payload mismatch.' }
    Write-Verbose "archive-check scope=$Scope state=complete"
}
function Assert-StagedCandidate([string]$Root, [string]$Expected) {
    Assert-Path $Root
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force) {
        if ($entry.Name -cnotin @('RabiRouteHost.exe','current.json','versions')) { throw 'Unowned staged candidate root entry.' }
    }
    $bootstrap = Join-Path $Root 'RabiRouteHost.exe'
    Assert-Path $bootstrap
    if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf) -or (Get-Item -LiteralPath $bootstrap).Length -eq 0) { throw 'Staged candidate bootstrap is missing or empty.' }
    $versions = Join-Path $Root 'versions'
    Assert-Path $versions
    $entries = @(Get-ChildItem -LiteralPath $versions -Force)
    if ($entries.Count -ne 1 -or -not $entries[0].PSIsContainer -or $entries[0].Name -cne $Expected) { throw 'Staged candidate must contain exactly the old release version.' }
    Assert-Release $Root $Expected 'staged-candidate'
}
function Assert-Cas {
    Write-Verbose 'archive-check stage=cas state=starting'
    Assert-Path $pointerPath
    if ((Hash-File $pointerPath) -ine $ExpectedCurrentPointerSha256) { throw 'Current pointer CAS mismatch.' }
    Assert-Path $journalPath
    if (Test-Path -LiteralPath $journalPath) {
        if ((Hash-File $journalPath) -ine $ExpectedJournalSha256) { throw 'Journal CAS mismatch.' }
    } elseif (-not $alreadyArchived) { throw 'Active journal disappeared.' }
    Write-Verbose 'archive-check stage=cas state=complete'
}
function Assert-Evidence($journal) {
    if ($journal.schemaVersion -ne 1 -or $journal.appId -cne $AppId -or $journal.state -cne 'rolled-back' -or
        $journal.versionMoveState -cne 'not-started' -or $journal.versionCommitted -isnot [bool] -or $journal.versionCommitted -or
        $journal.hadPointer -isnot [bool] -or -not $journal.hadPointer -or $journal.hadBootstrap -isnot [bool] -or -not $journal.hadBootstrap -or
        $journal.quarantineMoves -isnot [array] -or $journal.quarantineMoves.Count -ne 0 -or
        $journal.legacyTaskMigrationState -cne 'restored' -or $journal.autostartState -cne 'captured' -or
        $journal.error -cne 'Fenced Host stop failed with ExitCode=1.') { throw 'Unsupported or insufficient rolled-back evidence; nothing restored.' }
    Assert-Id ([string]$journal.releaseId)
    if ($journal.releaseId -ceq $ExpectedCurrentReleaseId) { throw 'Current release is the old candidate.' }
    $transactionRoot = [string]$journal.transactionRoot
    Assert-Path $transactionRoot
    $id = Split-Path -Leaf $transactionRoot
    if ($id -notmatch '^[a-f0-9]{32}$' -or $transactionRoot -cne (Join-Path $install ".install-staging\$id")) { throw 'Transaction ownership path mismatch.' }
    Write-Verbose 'archive-check stage=transaction-tree state=starting'
    Assert-Tree $transactionRoot
    Write-Verbose 'archive-check stage=transaction-tree state=complete'
    $expectedPaths = @{
        destinationVersion = Join-Path $install "versions\$($journal.releaseId)"
        legacyTaskBackupRoot = Join-Path $transactionRoot 'backup\legacy-wearable-task'
        autostartSnapshotRoot = Join-Path $transactionRoot 'backup\autostart'
        quarantineRoot = Join-Path $install ".rabiroute-quarantine\$id\legacy-runtime"
    }
    foreach ($key in $expectedPaths.Keys) {
        $value = [string]$journal.$key
        Assert-Path $value
        if ($value -cne $expectedPaths[$key]) { throw "Noncanonical journal evidence: $key" }
    }
    foreach ($absent in @($journal.destinationVersion, $journal.quarantineRoot)) {
        Assert-Path $absent
        if (Test-Path -LiteralPath $absent) { throw 'Unexpected old candidate/quarantine evidence; manual investigation required.' }
    }
    $backupPointer = Read-Json (Join-Path $transactionRoot 'backup\current.json')
    Assert-Pointer $backupPointer
    if ($backupPointer.releaseId -ceq $ExpectedCurrentReleaseId) { throw 'Current release is not a later third release.' }
    $backupHost = Join-Path $transactionRoot 'backup\RabiRouteHost.exe'
    if (-not (Test-Path -LiteralPath $backupHost -PathType Leaf) -or (Hash-File $backupHost) -cne (Hash-File $hostPath)) { throw 'Root bootstrap drift; no safe bootstrap ownership proof.' }
    # A not-started move normally leaves the entire validated candidate in staging.
    # Its continued presence is evidence to preserve, not a committed installation.
    Assert-StagedCandidate (Join-Path $transactionRoot 'candidate') ([string]$journal.releaseId)
    $task = Read-Json (Join-Path $journal.legacyTaskBackupRoot 'task-backup.json')
    if ($task.schemaVersion -ne 1 -or $task.taskName -cne 'RabiLinkWearableHealthCompanion' -or $task.taskPath -cne '\' -or
        $task.wasPresent -isnot [bool] -or $task.wasPresent -or $task.wasRunning -isnot [bool] -or $task.wasRunning -or
        (Test-Path -LiteralPath (Join-Path $journal.legacyTaskBackupRoot 'task.xml'))) { throw 'Legacy task absence evidence insufficient.' }
    $snapshot = Read-Json (Join-Path $journal.autostartSnapshotRoot 'snapshot.json')
    if ($snapshot.schemaVersion -ne 1 -or $snapshot.installRoot -cne $install) { throw 'Autostart snapshot identity mismatch.' }
    foreach ($name in @('settings','startup','legacyStartup')) {
        $entry = $snapshot.entries.$name
        if ($entry.existed -isnot [bool] -or $entry.backupName -cne "$name.bin") { throw 'Invalid snapshot entry.' }
        $file = Join-Path $journal.autostartSnapshotRoot "$name.bin"
        if ($entry.existed) {
            if ($name -ne 'settings' -or (Hash-File $file) -cne $entry.sha256) { throw 'Unsupported startup snapshot or damaged backup.' }
        } elseif ($entry.sha256 -cne '' -or (Test-Path -LiteralPath $file)) { throw 'Conflicting absent snapshot.' }
    }
    return $transactionRoot
}

Assert-Path $InstallRoot
$install = $InstallRoot
Assert-Id $ExpectedCurrentReleaseId
if (-not (Test-Path -LiteralPath $install -PathType Container)) { throw 'InstallRoot does not exist.' }
$journalPath = Join-Path $install '.rabiroute-install-transaction.json'
$pointerPath = Join-Path $install 'current.json'
$hostPath = Join-Path $install 'RabiRouteHost.exe'
Assert-Path $hostPath
$alreadyArchived = -not (Test-Path -LiteralPath $journalPath)
$hash = $ExpectedJournalSha256.ToLowerInvariant()
# A completed retry is discovered only in immediate, canonical transaction owners.
$source = $journalPath
if ($alreadyArchived) {
    $staging = Join-Path $install '.install-staging'
    Assert-Path $staging
    $matches = @(foreach ($dir in Get-ChildItem -LiteralPath $staging -Directory -Force) {
        Assert-Path $dir.FullName
        if ($dir.Name -match '^[a-f0-9]{32}$') {
            $path = Join-Path $dir.FullName "journal-$hash.removed.json"
            Assert-Path $path
            if (Test-Path -LiteralPath $path -PathType Leaf) { $path }
        }
    })
    if ($matches.Count -ne 1) { throw 'No unique completed archive; no active journal changed.' }
    $source = $matches[0]
}
Assert-Path $source
if ((Get-Item -LiteralPath $source).Length -gt 1MB) { throw 'Journal exceeds bounded size.' }
$bytes = [IO.File]::ReadAllBytes($source)
if ((Hash-Bytes $bytes) -cne $hash) { throw 'Journal CAS mismatch.' }
$journal = [Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json
Assert-Cas
$mutexHash = Hash-Bytes ([Text.UTF8Encoding]::new($false).GetBytes($install.ToLowerInvariant()))
$mutex = [Threading.Mutex]::new($false, "Local\RabiRoute.Install.$($mutexHash.Substring(0,32))")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another RabiRoute install or Developer activation holds the installation mutex.' }
    Assert-Cas
    $owner = Assert-Evidence $journal
    Assert-Release $install $ExpectedCurrentReleaseId 'current'
    $archivePath = Join-Path $owner "journal-$hash.original.json"
    $removedPath = Join-Path $owner "journal-$hash.removed.json"
    foreach ($path in @($archivePath,$removedPath)) {
        Assert-Path $path
        if ((Test-Path -LiteralPath $path) -and (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Hash-File $path) -cne $hash)) { throw 'Existing archive conflict; refusing overwrite.' }
    }
    if ($alreadyArchived -and -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Completed archive lacks durable original.' }
    if (-not $alreadyArchived -and (Test-Path -LiteralPath $removedPath)) { throw 'Active journal conflicts with completed archive.' }
    Assert-Cas
    if ($Archive -and -not $alreadyArchived) {
        if (-not (Test-Path -LiteralPath $archivePath)) {
            # Flush a unique sibling first; interrupted partial writes remain evidence,
            # while a retry can publish a new complete original without overwriting.
            $temporary = "$archivePath.$([guid]::NewGuid().ToString('N')).pending"
            $stream = [IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
            try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
            [IO.File]::Move($temporary,$archivePath)
        }
        if ((Hash-File $archivePath) -cne $hash) { throw 'Durable archive verification failed.' }
        Assert-Cas
        # Same-volume, no-overwrite rename under the shared install mutex.
        [IO.File]::Move($journalPath,$removedPath)
        if ((Hash-File $removedPath) -cne $hash) { throw 'Moved journal mismatch; all evidence retained.' }
    }
    [pscustomobject]@{ ok=$true; state=$(if ($alreadyArchived) {'already-archived'} elseif ($Archive) {'archived'} else {'eligible-read-only'}); releaseId=$ExpectedCurrentReleaseId; journalSha256=$hash; archivePath=$archivePath; removedPath=$removedPath } | ConvertTo-Json -Compress
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
