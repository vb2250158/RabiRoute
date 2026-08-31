param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$StopHostScript,
    [Parameter(Mandatory = $true)][string]$LegacyTaskMigrationScript,
    [switch]$PreflightOnly,
    [string]$TestLegacyTaskStorePath
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
function Retire-LegacyTaskForUninstall([string]$BackupRoot) {
    try {
        Invoke-LegacyTaskMigration "Remove" $BackupRoot
    } catch {
        $failure = $_
        if (Test-Path -LiteralPath (Join-Path $BackupRoot "task-backup.json") -PathType Leaf) {
            Invoke-LegacyTaskMigration "Restore" $BackupRoot
            Remove-Item -LiteralPath $BackupRoot -Recurse -Force
        }
        throw $failure
    }
    Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
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
    return [pscustomobject]@{ pointer=$pointer; version=$version; manifestPath=$manifestPath; owned=@($owned) }
}

$install = Full $InstallRoot
$driveRoot = [IO.Path]::GetPathRoot($install).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($install) -or $install -eq $driveRoot) { throw "InstallRoot must be an absolute application directory, not a drive root." }
if (-not (Test-Path -LiteralPath $LegacyTaskMigrationScript -PathType Leaf)) { throw "Legacy wearable task migration helper is missing." }
if ($TestLegacyTaskStorePath -and $env:RABIROUTE_INSTALL_TRANSACTION_TEST_MODE -ne "1") { throw "TestLegacyTaskStorePath is forbidden outside explicit transaction test mode." }
Invoke-LegacyTaskMigration "Inspect"
$pointerPath = Join-Path $install "current.json"
if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
    if (-not $PreflightOnly) {
        $taskBackupRoot = Join-Path $install (".install-staging\uninstall-legacy-task-" + [guid]::NewGuid().ToString("N"))
        Retire-LegacyTaskForUninstall $taskBackupRoot
    }
    [pscustomobject]@{ ok=$true; state="no-versioned-install"; preflight=[bool]$PreflightOnly } | ConvertTo-Json -Compress
    exit 0
}
$release = Read-ValidatedOwnedRelease $install
$pointer = $release.pointer
$version = $release.version
$manifestPath = $release.manifestPath
$owned = @($release.owned)
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopHostScript -InstallRoot $install -WorkingRoot (Join-Path $install ".install-staging\uninstall")
if ($LASTEXITCODE -ne 0) { throw "Fenced Host stop failed; uninstall is blocked." }
if ($PreflightOnly) {
    [pscustomobject]@{ ok=$true; state="validated"; releaseId=$pointer.releaseId } | ConvertTo-Json -Compress
    exit 0
}
$taskBackupRoot = Join-Path $install (".install-staging\uninstall-legacy-task-" + [guid]::NewGuid().ToString("N"))
Retire-LegacyTaskForUninstall $taskBackupRoot
foreach ($file in $owned) { if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force } }
Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $version -Recurse -Directory -Force | Sort-Object FullName -Descending | ForEach-Object {
    if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
}
if (-not (Get-ChildItem -LiteralPath $version -Force)) { Remove-Item -LiteralPath $version -Force }
Remove-Item -LiteralPath $pointerPath -Force
Remove-Item -LiteralPath (Join-Path $install "RabiRouteHost.exe") -Force -ErrorAction SilentlyContinue
[pscustomobject]@{ ok=$true; state="removed-owned-code"; preservedData=$true; preservedForeign=$true } | ConvertTo-Json -Compress
