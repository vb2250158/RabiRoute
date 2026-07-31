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
$remoteRoot = Join-Path $repo "plugin-adapters\remote-agent-rabiroute"
if (-not $OutputRoot) { $OutputRoot = Join-Path $repo "output\remote-agent" }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$payload = Join-Path $OutputRoot "payload"
$app = Join-Path $payload "app"
$package = Get-Content -LiteralPath (Join-Path $remoteRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if ($Version -ne [string]$package.version) {
    throw "Release version $Version does not match remote-agent package version $($package.version)."
}
$outputBase = [System.IO.Path]::GetFullPath((Join-Path $repo "output"))
if ($OutputRoot -eq $repo -or -not $OutputRoot.StartsWith($outputBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside the repository output directory: $outputBase"
}

function Write-Step([string]$Message) { Write-Host "[remote-agent-release] $Message" }

function Resolve-Iscc {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

Set-Location $repo
if (-not $SkipTests) {
    Write-Step "Building the standalone Agent Host and running focused tests"
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "RabiRoute build failed." }
    & node --import tsx --test "src/remoteAgentHost/configStore.test.ts" "src/remoteAgentHost/bridge.test.ts"
    if ($LASTEXITCODE -ne 0) { throw "Remote Agent Host tests failed." }
} else {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "RabiRoute build failed." }
}

Write-Step "Compiling the Remote Agent-only dependency closure"
$remoteDist = Join-Path $repo "dist-remote-agent-host"
if (Test-Path -LiteralPath $remoteDist) {
    Remove-Item -LiteralPath $remoteDist -Recurse -Force
}
& node "node_modules\typescript\bin\tsc" "-p" "tsconfig.remote-agent-host.json"
if ($LASTEXITCODE -ne 0) { throw "Remote Agent-only TypeScript build failed." }
if (Test-Path -LiteralPath (Join-Path $remoteDist "manager.js")) {
    throw "Manager control-plane code entered the Remote Agent build."
}

Write-Step "Creating a clean standalone Agent Host payload"
if (Test-Path -LiteralPath $OutputRoot) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputRoot)
    if (-not $resolvedOutput.StartsWith($outputBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an output path outside $outputBase"
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $app | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $payload "runtime") | Out-Null

Copy-Item -LiteralPath $remoteDist -Destination (Join-Path $app "dist") -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $app "ribiwebgui") | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "ribiwebgui\dist") -Destination (Join-Path $app "ribiwebgui\dist") -Recurse -Force
Remove-Item -LiteralPath (Join-Path $app "ribiwebgui\dist\reports") -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $app "assets") | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "assets\rabiroute-icon.png") -Destination (Join-Path $app "assets\rabiroute-icon.png") -Force
Copy-Item -LiteralPath (Join-Path $repo "assets\rabiroute-mini-badge.svg") -Destination (Join-Path $app "assets\rabiroute-mini-badge.svg") -Force
Copy-Item -LiteralPath (Join-Path $repo "scripts\rabiroute_agent") -Destination (Join-Path $app "scripts\rabiroute_agent") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo "scripts\deploy-astrbot-adapter.cmd") -Destination (Join-Path $app "scripts\deploy-astrbot-adapter.cmd") -Force
Copy-Item -LiteralPath (Join-Path $remoteRoot "package.json") -Destination (Join-Path $app "package.json") -Force
Copy-Item -LiteralPath (Join-Path $remoteRoot "package-lock.json") -Destination (Join-Path $app "package-lock.json") -Force
Copy-Item -LiteralPath (Join-Path $remoteRoot "launcher.mjs") -Destination (Join-Path $app "launcher.mjs") -Force
Copy-Item -LiteralPath (Join-Path $remoteRoot "README.md") -Destination (Join-Path $app "README.md") -Force
Copy-Item -LiteralPath (Join-Path $remoteRoot "README_en.md") -Destination (Join-Path $app "README_en.md") -Force
Copy-Item -LiteralPath (Join-Path $repo "LICENSE") -Destination (Join-Path $payload "LICENSE") -Force

Write-Step "Installing production dependencies used by the shared Agent adapters"
& npm.cmd ci --omit=dev --ignore-scripts --prefix $app
if ($LASTEXITCODE -ne 0) { throw "Production dependency install failed." }

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
if ($actualNodeHash -ne $expectedNodeHash) { throw "Node.js checksum mismatch for $nodeName." }
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
Copy-Item -LiteralPath (Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe") -Destination (Join-Path $payload "runtime\node.exe") -Force

Write-Step "Building the windowless native launcher"
$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
if (-not $rustc) { throw "rustc.exe was not found." }
$launcherPath = Join-Path $payload "RabiRoute-Remote-Agent.exe"
Push-Location (Join-Path $remoteRoot "launcher")
try {
    & $rustc.Source "--edition=2021" "-O" "-C" "strip=symbols" "-C" "panic=abort" "rabiroute_remote_agent_launcher.rs" "-o" $launcherPath
    if ($LASTEXITCODE -ne 0) { throw "Native launcher build failed." }
} finally {
    Pop-Location
}
Remove-Item -LiteralPath (Join-Path $payload "RabiRoute-Remote-Agent.pdb") -Force -ErrorAction SilentlyContinue

[System.IO.File]::WriteAllText(
    (Join-Path $payload "VERSION.txt"),
    "RabiRoute Remote Agent $Version`nNode.js $NodeVersion`nRuntime form: standalone Agent message endpoint`n",
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
    throw "Private/runtime files entered the payload: $($forbiddenFiles.FullName -join ', ')"
}

if (-not $SkipSmokeTest) {
    Write-Step "Smoke testing the packaged EXE and standalone WebGUI"
    $smokeConfig = Join-Path $OutputRoot "smoke-config.json"
    $smoke = @{
        schemaVersion = 1
        enabled = $true
        deviceId = "rabi-agent-release-smoke"
        deviceName = "RabiRoute Release Smoke"
        password = "release-smoke-password-32-bytes"
        listenHost = "127.0.0.1"
        port = 19797
        discoveryPortStart = 19798
        discoveryPortEnd = 19818
        profile = @{ agentAdapters = @() }
    } | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($smokeConfig, $smoke, [System.Text.UTF8Encoding]::new($false))
    $previousConfig = $env:RABIROUTE_REMOTE_AGENT_HOST_CONFIG
    try {
        $env:RABIROUTE_REMOTE_AGENT_HOST_CONFIG = $smokeConfig
        $checkProcess = Start-Process -FilePath $launcherPath -ArgumentList "--check" -Wait -PassThru -WindowStyle Hidden
        if ($checkProcess.ExitCode -ne 0) { throw "Packaged runtime check failed with exit code $($checkProcess.ExitCode)." }
        $smokeProcess = Start-Process -FilePath $launcherPath -ArgumentList "--smoke-test" -Wait -PassThru -WindowStyle Hidden
        if ($smokeProcess.ExitCode -ne 0) { throw "Packaged Host listener smoke test failed with exit code $($smokeProcess.ExitCode)." }
    } finally {
        if ($null -eq $previousConfig) { Remove-Item Env:RABIROUTE_REMOTE_AGENT_HOST_CONFIG -ErrorAction SilentlyContinue }
        else { $env:RABIROUTE_REMOTE_AGENT_HOST_CONFIG = $previousConfig }
        Remove-Item -LiteralPath $smokeConfig -Force -ErrorAction SilentlyContinue
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
    & $iscc "/DAppVersion=$Version" "/DSourceDir=$payload" "/DOutputDir=$OutputRoot" "/DOutputBaseFilename=$installerBase" (Join-Path $repo "installer\RabiRouteRemoteAgent.iss")
    if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed." }
    $installerPath = Join-Path $OutputRoot "$installerBase.exe"
}

$artifacts = @($portablePath)
if ($installerPath) { $artifacts += $installerPath }
$checksumPath = Join-Path $OutputRoot "SHA256SUMS.txt"
$checksumLines = foreach ($artifact in $artifacts) {
    "$((Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant())  $(Split-Path -Leaf $artifact)"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))
Write-Step "Release artifacts are ready in $OutputRoot"
Get-Item -LiteralPath ($artifacts + $checksumPath) | Select-Object Name, Length, FullName
