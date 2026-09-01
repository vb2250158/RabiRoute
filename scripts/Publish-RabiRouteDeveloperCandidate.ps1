param(
    [string]$SourceRoot = (Get-Location).Path,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Programs\RabiRoute"),
    [switch]$SkipBuild,
    [switch]$RebuildDesktopRuntime = $true,
    [switch]$RebuildHostCore = $true,
    [int]$ReadyTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-LocalDirectory([string]$PathValue, [string]$Label) {
    $full = [IO.Path]::GetFullPath($PathValue)
    if ($full.StartsWith("\\")) { throw "$Label must be on a local disk: $full" }
    $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd("\")
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveRoot'" -ErrorAction SilentlyContinue
    if (-not $disk -or $disk.DriveType -eq 4) { throw "$Label must be on a local disk: $full" }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "$Label is missing: $full" }
    return $full
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$Failure) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Failure (ExitCode=$LASTEXITCODE)" }
}

$SourceRoot = Assert-LocalDirectory $SourceRoot "Developer source root"
$InstallRoot = Assert-LocalDirectory $InstallRoot "RabiRoute install root"
$currentPath = Join-Path $InstallRoot "current.json"
$current = Get-Content -Raw -LiteralPath $currentPath | ConvertFrom-Json
$baseRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot ([string]$current.versionPath -replace "/", "\")))
$versionsRoot = Join-Path $InstallRoot "versions"

$sourceLock = Join-Path $SourceRoot "package-lock.json"
$baseLock = Join-Path $baseRoot "package-lock.json"
if ((Get-FileHash -LiteralPath $sourceLock -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $baseLock -Algorithm SHA256).Hash) {
    throw "package-lock.json changed. Dependency changes require an immutable full release."
}

Set-Location $SourceRoot
if (-not $SkipBuild) {
    Invoke-Checked "npm.cmd" @("run", "build") "Developer build failed"
}

$desktopRoot = Join-Path $baseRoot "desktop-runtime"
if ($RebuildDesktopRuntime) {
    $desktopRoot = Join-Path $env:LOCALAPPDATA ("RabiRoute\build\developer-desktop-" + [guid]::NewGuid().ToString("N"))
    Invoke-Checked "powershell.exe" @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $SourceRoot "scripts\build-desktop-runtime.ps1"),
        "-OutputRoot", $desktopRoot
    ) "Developer Desktop runtime build failed"
}

$hostCoreRoot = $baseRoot
if ($RebuildHostCore) {
    $hostOutputRoot = Join-Path $env:LOCALAPPDATA ("RabiRoute\build\developer-host-" + [guid]::NewGuid().ToString("N"))
    Invoke-Checked "powershell.exe" @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $SourceRoot "scripts\build-windows-host.ps1"),
        "-OutputRoot", $hostOutputRoot
    ) "Developer Host Core build failed"
    $hostCoreRoot = Join-Path $hostOutputRoot "version"
}

$packageVersion = [string](Get-Content -Raw -LiteralPath (Join-Path $SourceRoot "package.json") | ConvertFrom-Json).version
$candidateJson = & node.exe (Join-Path $SourceRoot "scripts\new-rabiroute-developer-candidate.mjs") `
    --base $baseRoot `
    --build $SourceRoot `
    --tray $desktopRoot `
    --host-core $hostCoreRoot `
    --versions $versionsRoot `
    --version $packageVersion
if ($LASTEXITCODE -ne 0) { throw "Developer candidate construction failed. (ExitCode=$LASTEXITCODE)" }
$candidate = ($candidateJson -join [Environment]::NewLine) | ConvertFrom-Json

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceRoot "scripts\Invoke-RabiRouteDeveloperApply.ps1") `
    -CandidateRoot ([string]$candidate.packageRoot) `
    -InstallRoot $InstallRoot `
    -ReadyTimeoutSeconds $ReadyTimeoutSeconds
if ($LASTEXITCODE -ne 0) { throw "Developer candidate activation failed. (ExitCode=$LASTEXITCODE)" }
