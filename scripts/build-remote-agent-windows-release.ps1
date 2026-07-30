param(
    [string]$Version,
    [string]$NodeVersion = "22.17.1",
    [string]$OutputRoot,
    [switch]$SkipTests,
    [switch]$SkipInstaller,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
$bridgeRoot = Join-Path $repo "plugin-adapters\remote-agent-rabiroute"
if (-not $OutputRoot) { $OutputRoot = Join-Path $repo "output\remote-agent" }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$payload = Join-Path $OutputRoot "payload"
$package = Get-Content -LiteralPath (Join-Path $bridgeRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if ($Version -ne [string]$package.version) {
    throw "Release version $Version does not match remote-agent package version $($package.version)."
}
if ($OutputRoot -eq $repo -or $OutputRoot -eq $bridgeRoot -or -not $OutputRoot.StartsWith([System.IO.Path]::GetFullPath((Join-Path $repo "output")), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside the repository output directory: $OutputRoot"
}

function Write-Step([string]$Message) { Write-Host "[remote-agent-release] $Message" }

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

function Copy-AppFile([string]$RelativePath) {
    $source = Join-Path $bridgeRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required Remote Agent source file is missing: $RelativePath"
    }
    $destination = Join-Path (Join-Path $payload "app") $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

Set-Location $repo
if (-not $SkipTests) {
    Write-Step "Installing locked bridge dependencies and running tests"
    & npm.cmd ci --prefix $bridgeRoot
    if ($LASTEXITCODE -ne 0) { throw "Remote Agent npm ci failed." }
    & npm.cmd run check --prefix $bridgeRoot
    if ($LASTEXITCODE -ne 0) { throw "Remote Agent checks failed." }
}

Write-Step "Creating a clean Windows x64 payload"
if (Test-Path -LiteralPath $OutputRoot) {
    Remove-Item -LiteralPath $OutputRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $payload "app") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $payload "runtime") | Out-Null

foreach ($relative in @(
    "index.mjs",
    "launcher.mjs",
    "launcher-config.mjs",
    "codex-app-server-client.mjs",
    "cwd-policy.mjs",
    "keyed-task-queue.mjs",
    "public-control-url.mjs",
    "task-lifecycle.mjs",
    "thread-coordinator.mjs",
    "package.json",
    "package-lock.json",
    "README.md",
    "README_en.md"
)) {
    Copy-AppFile $relative
}
Copy-Item -LiteralPath (Join-Path $repo "LICENSE") -Destination (Join-Path $payload "LICENSE") -Force

Write-Step "Installing production-only bridge dependencies"
& npm.cmd ci --omit=dev --ignore-scripts --prefix (Join-Path $payload "app")
if ($LASTEXITCODE -ne 0) { throw "Production Remote Agent npm install failed." }

Write-Step "Embedding verified Node.js $NodeVersion x64"
$nodeName = "node-v$NodeVersion-win-x64.zip"
$nodeArchive = Join-Path $env:TEMP $nodeName
$nodeChecksums = Join-Path $env:TEMP "node-v$NodeVersion-SHASUMS256.txt"
$nodeExtract = Join-Path $env:TEMP "rabiroute-remote-agent-node-$NodeVersion"
if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$nodeName" -OutFile $nodeArchive
}
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $nodeChecksums
$checksumLine = Get-Content -LiteralPath $nodeChecksums -Encoding UTF8 | Where-Object { $_ -match "\s+$([regex]::Escape($nodeName))$" } | Select-Object -First 1
if (-not $checksumLine) { throw "Node.js checksum was not found for $nodeName." }
$expectedNodeHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
$actualNodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash.ToLowerInvariant()
if ($actualNodeHash -ne $expectedNodeHash) {
    throw "Node.js checksum mismatch for $nodeName."
}
if (Test-Path -LiteralPath $nodeExtract) {
    Remove-Item -LiteralPath $nodeExtract -Recurse -Force
}
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
Copy-Item -LiteralPath (Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe") -Destination (Join-Path $payload "runtime\node.exe") -Force

Write-Step "Building the native launcher executable"
$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
if (-not $rustc) { throw "rustc.exe was not found. Install the stable x86_64-pc-windows-msvc toolchain." }
$launcherSourceDir = Join-Path $bridgeRoot "launcher"
$launcherPath = Join-Path $payload "RabiRoute-Remote-Agent.exe"
Push-Location $launcherSourceDir
try {
    & $rustc.Source "--edition=2021" "-O" "-C" "strip=symbols" "-C" "panic=abort" "rabiroute_remote_agent_launcher.rs" "-o" $launcherPath
    if ($LASTEXITCODE -ne 0) { throw "Native Remote Agent launcher build failed." }
} finally {
    Pop-Location
}
Remove-Item -LiteralPath (Join-Path $payload "RabiRoute-Remote-Agent.pdb") -Force -ErrorAction SilentlyContinue

[System.IO.File]::WriteAllText(
    (Join-Path $payload "VERSION.txt"),
    "RabiRoute Remote Agent $Version`nNode.js $NodeVersion`n@openai/codex $($package.dependencies.'@openai/codex')`n",
    [System.Text.UTF8Encoding]::new($false)
)

$forbiddenFiles = Get-ChildItem -LiteralPath $payload -Recurse -Force -File | Where-Object {
    $relative = $_.FullName.Substring($payload.Length).TrimStart("\", "/")
    $relative -match '(?i)^(data|logs|recordings|transcripts|\.codex)([\\/]|$)' -or
    $_.Extension -eq ".pdb" -or
    $_.Name -match '^\.env($|\.)' -or
    $_.Name -match '(?i)(password|token|cookie|secret).*\.json$'
}
if ($forbiddenFiles) {
    throw "Private/runtime files entered the Remote Agent payload: $($forbiddenFiles.FullName -join ', ')"
}

$rg = Get-Command rg.exe -ErrorAction SilentlyContinue
if ($rg) {
    $firstPartyRoots = @(
        (Join-Path $payload "RabiRoute-Remote-Agent.exe"),
        (Join-Path $payload "app\index.mjs"),
        (Join-Path $payload "app\launcher.mjs"),
        (Join-Path $payload "app\launcher-config.mjs"),
        (Join-Path $payload "app\README.md"),
        (Join-Path $payload "app\README_en.md")
    )
    $leaks = & $rg.Source -a -l -F $repo @firstPartyRoots 2>$null
    if ($LASTEXITCODE -eq 0 -and $leaks) {
        throw "Build-machine path found in Remote Agent payload: $($leaks -join ', ')"
    }
}

if (-not $SkipSmokeTest) {
    Write-Step "Smoke testing the packaged EXE, bundled Codex, and bridge listeners"
    $smokeWorkspace = Join-Path $OutputRoot "smoke-workspace"
    $smokeConfig = Join-Path $OutputRoot "smoke-config.json"
    New-Item -ItemType Directory -Force -Path $smokeWorkspace | Out-Null
    $smokeConfigValue = @{
        schemaVersion = 1
        deviceName = "RabiRoute Release Smoke"
        defaultCwd = $smokeWorkspace
        allowedCwds = @($smokeWorkspace)
        defaultThreadName = "Remote Agent Smoke"
        password = "release-smoke-password-32-bytes"
        allowNetwork = $false
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($smokeConfig, $smokeConfigValue, [System.Text.UTF8Encoding]::new($false))
    $previousConfig = $env:RABIROUTE_REMOTE_AGENT_CONFIG
    try {
        $env:RABIROUTE_REMOTE_AGENT_CONFIG = $smokeConfig
        & $launcherPath "--check" "--non-interactive" "--skip-login-check"
        if ($LASTEXITCODE -ne 0) { throw "Packaged Remote Agent runtime check failed." }
        & $launcherPath "--smoke-test" "--non-interactive" "--skip-login-check"
        if ($LASTEXITCODE -ne 0) { throw "Packaged Remote Agent listener smoke test failed." }
    } finally {
        if ($null -eq $previousConfig) {
            Remove-Item Env:RABIROUTE_REMOTE_AGENT_CONFIG -ErrorAction SilentlyContinue
        } else {
            $env:RABIROUTE_REMOTE_AGENT_CONFIG = $previousConfig
        }
        Remove-Item -LiteralPath $smokeConfig -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $smokeWorkspace -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$portableName = "RabiRoute-Remote-Agent-$Version-windows-x64-portable.zip"
$portablePath = Join-Path $OutputRoot $portableName
Write-Step "Creating $portableName"
Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $portablePath -CompressionLevel Optimal -Force

$installerPath = $null
if (-not $SkipInstaller) {
    $iscc = Resolve-Iscc
    if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) was not found." }
    $installerBase = "RabiRoute-Remote-Agent-$Version-windows-x64-setup"
    Write-Step "Compiling $installerBase.exe"
    & $iscc "/DAppVersion=$Version" "/DSourceDir=$payload" "/DOutputDir=$OutputRoot" "/DOutputBaseFilename=$installerBase" (Join-Path $repo "installer\RabiRouteRemoteAgent.iss")
    if ($LASTEXITCODE -ne 0) { throw "Remote Agent Inno Setup compilation failed." }
    $installerPath = Join-Path $OutputRoot "$installerBase.exe"
    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "Remote Agent installer output was not found: $installerPath"
    }
}

$artifacts = @($portablePath)
if ($installerPath) { $artifacts += $installerPath }
$checksumPath = Join-Path $OutputRoot "SHA256SUMS.txt"
$checksumLines = foreach ($artifact in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $artifact)"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))

Write-Step "Remote Agent release artifacts are ready in $OutputRoot"
Get-Item -LiteralPath ($artifacts + $checksumPath) | Select-Object Name, Length, FullName
