param(
    [string]$OutputRoot,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\build\windows-host"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)

function Assert-LocalDirectory([string]$PathValue) {
    if ($PathValue.StartsWith("\\")) {
        throw "Windows Host build output must be on a local disk: $PathValue"
    }
    $root = [System.IO.Path]::GetPathRoot($PathValue).TrimEnd("\")
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$root'" -ErrorAction SilentlyContinue
    if (-not $disk -or $disk.DriveType -eq 4) {
        throw "Windows Host build output must be on a local disk: $PathValue"
    }
}

Assert-LocalDirectory $OutputRoot
$artifacts = Join-Path $env:LOCALAPPDATA ("RabiRoute\build\windows-host-artifacts-" + [guid]::NewGuid().ToString("N"))
$coreProject = Join-Path $repo "desktop\windows-host\RabiRouteHost.csproj"
$tests = Join-Path $repo "desktop\windows-host\RabiRouteHost.Tests\RabiRouteHost.Tests.csproj"
$bootstrapProject = Join-Path $repo "desktop\windows-bootstrap\RabiRouteBootstrap.csproj"
$bootstrapTests = Join-Path $repo "desktop\windows-bootstrap\RabiRouteBootstrap.Tests\RabiRouteBootstrap.Tests.csproj"
$manifestScript = Join-Path $repo "scripts\create-windows-release-manifest.mjs"

try {
    if (-not $SkipTests) {
        Write-Host "[windows-host] Building and running Host contract tests"
        & dotnet run --project $tests -c Release --artifacts-path $artifacts
        if ($LASTEXITCODE -ne 0) { throw "Windows Host tests failed." }
        & dotnet run --project $bootstrapTests -c Release --artifacts-path $artifacts
        if ($LASTEXITCODE -ne 0) { throw "Windows bootstrap tests failed." }
    }

    if (Test-Path -LiteralPath $OutputRoot) {
        Remove-Item -LiteralPath $OutputRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    $versionRuntime = Join-Path $OutputRoot "version"
    New-Item -ItemType Directory -Force -Path $versionRuntime | Out-Null

    Write-Host "[windows-host] Publishing stable .NET 9 single-file win-x64 bootstrap"
    & dotnet publish $bootstrapProject `
        -c Release `
        -r win-x64 `
        --self-contained true `
        --artifacts-path $artifacts `
        -o $OutputRoot `
        -p:PublishSingleFile=true `
        -p:EnableCompressionInSingleFile=true `
        -p:DebugType=embedded
    if ($LASTEXITCODE -ne 0) { throw "Windows Host publish failed." }

    Write-Host "[windows-host] Publishing loadable version Host core"
    & dotnet publish $coreProject `
        -c Release `
        -r win-x64 `
        --self-contained false `
        --artifacts-path $artifacts `
        -o $versionRuntime `
        -p:DebugType=embedded
    if ($LASTEXITCODE -ne 0) { throw "Windows Host core publish failed." }

    $hostExe = Join-Path $OutputRoot "RabiRouteHost.exe"
    $hostCore = Join-Path $versionRuntime "RabiRouteHost.Core.dll"
    if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
        throw "Published Host bootstrap was not found: $hostExe"
    }
    if (-not (Test-Path -LiteralPath $hostCore -PathType Leaf)) {
        throw "Published Host core was not found: $hostCore"
    }

    $manifestJson = & node $manifestScript --payload $versionRuntime --version "0.0.0-host-core"
    if ($LASTEXITCODE -ne 0) { throw "Windows Host core release manifest failed." }
    $manifest = $manifestJson | ConvertFrom-Json
    if (-not $manifest.releaseId -or -not $manifest.payloadSha256) {
        throw "Windows Host core release manifest returned an invalid identity."
    }

    $distributionRoot = Join-Path $artifacts "distribution-smoke"
    $distributionVersionRoot = Join-Path $distributionRoot ("versions\" + [string]$manifest.releaseId)
    New-Item -ItemType Directory -Force -Path $distributionVersionRoot | Out-Null
    Copy-Item -LiteralPath $hostExe -Destination (Join-Path $distributionRoot "RabiRouteHost.exe") -Force
    Copy-Item -Path (Join-Path $versionRuntime "*") -Destination $distributionVersionRoot -Recurse -Force
    $current = [ordered]@{
        schemaVersion = 1
        appId = "io.rabiroute.windows"
        releaseId = [string]$manifest.releaseId
        versionPath = "versions/$([string]$manifest.releaseId)"
        payloadSha256 = [string]$manifest.payloadSha256
    }
    $currentJson = ($current | ConvertTo-Json -Compress) + [Environment]::NewLine
    [System.IO.File]::WriteAllText(
        (Join-Path $distributionRoot "current.json"),
        $currentJson,
        [System.Text.UTF8Encoding]::new($false))
    $smoke = Start-Process `
        -FilePath (Join-Path $distributionRoot "RabiRouteHost.exe") `
        -ArgumentList "--self-test" `
        -Wait `
        -PassThru
    if ($smoke.ExitCode -ne 0) { throw "Versioned Host bootstrap self-test failed with exit code $($smoke.ExitCode)." }
    Write-Host "[windows-host] Built bootstrap=$hostExe core=$hostCore release=$($manifest.releaseId)"
} finally {
    if (Test-Path -LiteralPath $artifacts) {
        Remove-Item -LiteralPath $artifacts -Recurse -Force -ErrorAction SilentlyContinue
    }
}
