param(
    [string]$ManifestPath = "",
    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $stackRoot = Join-Path $projectRoot "out\rokid-native-voice"
    $latest = Get-ChildItem -LiteralPath $stackRoot -Filter "rokid-native-voice-stack.json" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw "没有找到 stack manifest。请传入 -ManifestPath。"
    }
    $ManifestPath = $latest.FullName
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "manifest 不存在：$ManifestPath"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$results = @()

foreach ($entry in @($manifest.processes)) {
    $pidValue = [int]$entry.pid
    $name = [string]$entry.name
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) {
        $results += [ordered]@{
            name = $name
            pid = $pidValue
            status = "not_running"
        }
        continue
    }

    if ($WhatIfOnly) {
        $results += [ordered]@{
            name = $name
            pid = $pidValue
            status = "would_stop"
            processName = $process.ProcessName
        }
        continue
    }

    Stop-Process -Id $pidValue -Force
    $results += [ordered]@{
        name = $name
        pid = $pidValue
        status = "stopped"
        processName = $process.ProcessName
    }
}

[pscustomobject]@{
    Manifest = (Resolve-Path -LiteralPath $ManifestPath).Path
    StoppedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    Results = $results
}
