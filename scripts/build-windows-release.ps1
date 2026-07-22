param(
    [string]$Version,
    [string]$NodeVersion = "22.17.1",
    [string]$OutputRoot,
    [switch]$SkipBuild,
    [switch]$SkipTrayBuild,
    [switch]$SkipInstaller,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
if (-not $OutputRoot) { $OutputRoot = Join-Path $repo "output\windows" }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$payload = Join-Path $OutputRoot "payload"
$package = Get-Content -LiteralPath (Join-Path $repo "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if ($Version -ne [string]$package.version) {
    throw "Release version $Version does not match package.json version $($package.version)."
}

function Write-Step([string]$Message) { Write-Host "[windows-release] $Message" }

function Copy-TrackedTree([string]$RelativeRoot) {
    $prefix = ($RelativeRoot.TrimEnd("\", "/") -replace "\\", "/") + "/"
    $files = & git -C $repo ls-files -- "$prefix*"
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed for $RelativeRoot" }
    foreach ($relative in $files) {
        if (-not $relative.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $source = Join-Path $repo ($relative -replace "/", "\")
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $payload ($relative -replace "/", "\")
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

function Resolve-Iscc {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

Set-Location $repo
if (-not $SkipBuild) {
    Write-Step "Installing locked dependencies and building backend + WebGUI"
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
}

if (-not $SkipTrayBuild) {
    Write-Step "Building the PyInstaller tray executable"
    & (Join-Path $repo "scripts\build-tray-exe.ps1") -SkipNodeBuild
    if ($LASTEXITCODE -ne 0) { throw "Tray build failed." }
}

if (-not $SkipBuild) {
    Write-Step "Building the RabiSpeech Windows process host"
    & (Join-Path $repo "plugin-adapters\rabi-speech\scripts\build-windows-host.ps1")
    if ($LASTEXITCODE -ne 0) { throw "RabiSpeech Windows host build failed." }
}

$required = @(
    "dist\manager.js",
    "ribiwebgui\dist\index.html",
    "RabiRoute-Tray.exe",
    "plugin-adapters\rabi-speech\runtime\RabiSpeech.exe"
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $relative))) {
        throw "Required build output is missing: $relative"
    }
}

Write-Step "Creating a privacy-safe runtime payload"
if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -LiteralPath $OutputRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

foreach ($relative in @("dist", "ribiwebgui\dist")) {
    $destination = Join-Path $payload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination -Recurse -Force
}

# PyInstaller writes its tray EXE into dist beside the TypeScript output. The
# release root receives the same EXE below, so do not ship a duplicate. Compiled
# test files are useful in CI but are not runtime assets.
Remove-Item -LiteralPath (Join-Path $payload "dist\RabiRoute-Tray.exe") -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath (Join-Path $payload "dist") -Recurse -File -Filter "*.test.js" |
    Remove-Item -Force

foreach ($relative in @(
    "package.json",
    "package-lock.json",
    "LICENSE",
    "README.md",
    "README_zh.md",
    "版本更新日志.md",
    "版本更新日志_en.md",
    "Start-RabiRoute-Tray.bat",
    "RabiRoute-Tray.exe"
)) {
    Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination (Join-Path $payload $relative) -Force
}

foreach ($tree in @("assets", "docs", "examples\data", "plugin-adapters", "scripts")) {
    Copy-TrackedTree $tree
}

$speechHostRelative = "plugin-adapters\rabi-speech\runtime\RabiSpeech.exe"
$speechHostDestination = Join-Path $payload $speechHostRelative
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $speechHostDestination) | Out-Null
Copy-Item -LiteralPath (Join-Path $repo $speechHostRelative) -Destination $speechHostDestination -Force

Write-Step "Installing production-only npm dependencies into the payload"
& npm.cmd ci --omit=dev --ignore-scripts --prefix $payload
if ($LASTEXITCODE -ne 0) { throw "Production npm install failed." }

Write-Step "Embedding Node.js $NodeVersion x64"
$nodeArchive = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
$nodeExtract = Join-Path $env:TEMP "rabiroute-node-$NodeVersion"
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $nodeArchive
}
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
Copy-Item -LiteralPath (Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe") -Destination (Join-Path $payload "node.exe") -Force

$forbiddenFiles = Get-ChildItem -LiteralPath $payload -Recurse -Force -File | Where-Object {
    $payloadRelative = $_.FullName.Substring($payload.Length).TrimStart("\", "/")
    $payloadRelative -match '(?i)^(data|logs|recordings|transcripts)([\\/]|$)' -or
    ($_.Name -match '^\.env($|\.)' -and $_.Name -ne '.env.example') -or
    $_.Name -match '(?i)(token|cookie|secret).*\.json$'
}
if ($forbiddenFiles) {
    throw "Private/runtime files entered the payload: $($forbiddenFiles.FullName -join ', ')"
}

$rg = Get-Command rg.exe -ErrorAction SilentlyContinue
if ($rg) {
    $firstPartyRoots = @(
        (Join-Path $payload "dist"),
        (Join-Path $payload "ribiwebgui\dist"),
        (Join-Path $payload "docs"),
        (Join-Path $payload "examples"),
        (Join-Path $payload "plugin-adapters"),
        (Join-Path $payload "scripts"),
        (Join-Path $payload "RabiRoute-Tray.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $leaks = & $rg.Source -a -l -F $repo @firstPartyRoots 2>$null
    if ($LASTEXITCODE -eq 0 -and $leaks) {
        throw "Build-machine path found in release payload: $($leaks -join ', ')"
    }
}

if (-not $SkipSmokeTest) {
    Write-Step "Smoke testing the packaged Manager on port 18790"
    $env:GATEWAY_MANAGER_PORT = "18790"
    $manager = Start-Process -FilePath (Join-Path $payload "node.exe") -ArgumentList "dist\manager.js" -WorkingDirectory $payload -WindowStyle Hidden -PassThru
    try {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $meta = Invoke-RestMethod -Uri "http://127.0.0.1:18790/meta" -TimeoutSec 1
                if ($meta) { $ready = $true; break }
            } catch {}
            if ($manager.HasExited) { break }
        }
        if (-not $ready) { throw "Packaged Manager did not become ready on port 18790." }
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:18790/manager/shutdown" -TimeoutSec 3 | Out-Null
        $manager.WaitForExit(5000) | Out-Null
    } finally {
        Remove-Item Env:GATEWAY_MANAGER_PORT -ErrorAction SilentlyContinue
        if (-not $manager.HasExited) { Stop-Process -Id $manager.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath (Join-Path $payload "data") -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$portableName = "RabiRoute-$Version-windows-x64-portable.zip"
$portablePath = Join-Path $OutputRoot $portableName
Write-Step "Creating $portableName"
Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $portablePath -CompressionLevel Optimal -Force

$installerPath = $null
if (-not $SkipInstaller) {
    $iscc = Resolve-Iscc
    if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) was not found." }
    $installerBase = "RabiRoute-$Version-windows-x64-setup"
    Write-Step "Compiling $installerBase.exe"
    & $iscc "/DAppVersion=$Version" "/DSourceDir=$payload" "/DOutputDir=$OutputRoot" "/DOutputBaseFilename=$installerBase" (Join-Path $repo "installer\RabiRoute.iss")
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }
    $installerPath = Join-Path $OutputRoot "$installerBase.exe"
    if (-not (Test-Path -LiteralPath $installerPath)) { throw "Installer output was not found: $installerPath" }
}

$artifacts = @($portablePath)
if ($installerPath) { $artifacts += $installerPath }
$checksumPath = Join-Path $OutputRoot "SHA256SUMS.txt"
$checksumLines = foreach ($artifact in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $artifact)"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))

Write-Step "Release artifacts are ready in $OutputRoot"
Get-Item -LiteralPath ($artifacts + $checksumPath) | Select-Object Name, Length, FullName
