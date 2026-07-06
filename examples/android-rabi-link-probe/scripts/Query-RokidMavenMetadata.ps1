param(
    [string]$RepositoryBase = "https://maven.rokid.com/repository/maven-public/",
    [string[]]$Coordinates = @(),
    [string]$OutputDir = "",
    [int]$TimeoutSec = 15
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-maven"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (-not $Coordinates -or $Coordinates.Count -eq 0) {
    $Coordinates = @(
        "com.rokid.ai:basic",
        "com.rokid.ai:audioai",
        "com.rokid.ai:turenso",
        "com.rokid.ai:nlpconsumer",
        "com.rokid.ai:aicore",
        "com.rokid.ai:aicore_ncnn",
        "com.rokid.cxr:client-l",
        "com.rokid.cxr:cxr-service-bridge",
        "com.rokid.security:phone.sdk",
        "com.rokid.security:phone.sdk.api",
        "com.rokid.security:phone.sdk.server",
        "com.rokid.security:phone.sdk.rfmlite",
        "com.rokid.security:sdk.common.ability",
        "com.rokid.security:glass3.open.sdk",
        "com.rokid.glasses:transport.sdk",
        "com.rokid.glasses:transport.sdk.api",
        "com.rokid.glasses:transport.sdk.server"
    )
}

function ConvertTo-MetadataUrl {
    param(
        [string]$Base,
        [string]$Coordinate
    )

    $parts = $Coordinate -split ":"
    if ($parts.Count -ne 2) {
        throw "坐标必须是 group:artifact：$Coordinate"
    }
    $groupPath = $parts[0].Replace(".", "/")
    $artifact = $parts[1]
    return ($Base.TrimEnd("/") + "/" + $groupPath + "/" + $artifact + "/maven-metadata.xml")
}

function Get-Text {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
        return [pscustomobject][ordered]@{
            ok = $true
            statusCode = [int]$response.StatusCode
            text = [string]$response.Content
            error = ""
        }
    } catch {
        $statusCode = 0
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        return [pscustomobject][ordered]@{
            ok = $false
            statusCode = $statusCode
            text = ""
            error = $_.Exception.Message
        }
    }
}

function Parse-Metadata {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return [ordered]@{
            latest = ""
            release = ""
            versions = @()
            lastUpdated = ""
        }
    }

    [xml]$xml = $Text
    return [ordered]@{
        latest = [string]$xml.metadata.versioning.latest
        release = [string]$xml.metadata.versioning.release
        versions = @($xml.metadata.versioning.versions.version | ForEach-Object { [string]$_ })
        lastUpdated = [string]$xml.metadata.versioning.lastUpdated
    }
}

$results = @()
foreach ($coordinate in ($Coordinates | Sort-Object -Unique)) {
    $url = ConvertTo-MetadataUrl -Base $RepositoryBase -Coordinate $coordinate
    $probe = Get-Text -Url $url
    $parsed = if ($probe.ok) { Parse-Metadata -Text $probe.text } else {
        [ordered]@{
            latest = ""
            release = ""
            versions = @()
            lastUpdated = ""
        }
    }

    $results += [pscustomobject][ordered]@{
        coordinate = $coordinate
        metadataUrl = $url
        ok = $probe.ok
        statusCode = $probe.statusCode
        latest = $parsed.latest
        release = $parsed.release
        versionCount = @($parsed.versions).Count
        versions = @($parsed.versions)
        lastUpdated = $parsed.lastUpdated
        error = $probe.error
    }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-maven-metadata-summary-$timestamp.json"
$tablePath = Join-Path $OutputDir "rokid-maven-metadata-summary-$timestamp.md"

$summary = [pscustomobject][ordered]@{
    generatedAt = (Get-Date).ToString("o")
    repositoryBase = $RepositoryBase
    results = @($results)
    audioAiRoute = [ordered]@{
        basic = @($results | Where-Object { $_.coordinate -eq "com.rokid.ai:basic" } | Select-Object -First 1)
        audioai = @($results | Where-Object { $_.coordinate -eq "com.rokid.ai:audioai" } | Select-Object -First 1)
        turenso = @($results | Where-Object { $_.coordinate -eq "com.rokid.ai:turenso" } | Select-Object -First 1)
        nlpconsumer = @($results | Where-Object { $_.coordinate -eq "com.rokid.ai:nlpconsumer" } | Select-Object -First 1)
    }
    note = "This checks published Maven metadata only. A coordinate without metadata may still be distributed as a sample/local AAR, but it is not discoverable through this Maven path."
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$lines = @()
$lines += "# Rokid Maven Metadata"
$lines += ""
$lines += "Generated: $($summary.generatedAt)"
$lines += ""
$lines += "| Coordinate | HTTP | Latest | Release | Versions | Last Updated |"
$lines += "| --- | --- | --- | --- | --- | --- |"
foreach ($item in $results) {
    $versions = if ($item.versionCount -gt 0) { ($item.versions -join ", ") } else { "" }
    $lines += "| `$($item.coordinate)` | `$($item.statusCode)` | `$($item.latest)` | `$($item.release)` | `$versions` | `$($item.lastUpdated)` |"
}
$lines | Set-Content -LiteralPath $tablePath -Encoding UTF8

$results |
    Select-Object coordinate, ok, statusCode, latest, release, versionCount, lastUpdated |
    Format-Table -AutoSize

Write-Host "Summary: $summaryPath"
Write-Host "Table: $tablePath"
