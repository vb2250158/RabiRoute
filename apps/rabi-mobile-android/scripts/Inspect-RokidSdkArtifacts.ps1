param(
    [string[]]$Roots = @(),
    [string]$OutputDir = "",
    [int]$MaxClassHints = 40
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-sdk-artifacts"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (-not $Roots -or $Roots.Count -eq 0) {
    $defaultRoots = @()
    $gradleModules = Join-Path $env:USERPROFILE ".gradle\caches\modules-2\files-2.1"
    if (Test-Path -LiteralPath $gradleModules) {
        $defaultRoots += $gradleModules
    }
    $referenceLibs = Join-Path $projectRoot "out\reference\RokidAiSdkDemo\app\libs"
    if (Test-Path -LiteralPath $referenceLibs) {
        $defaultRoots += $referenceLibs
    }
    $appLibs = Join-Path $projectRoot "app\libs"
    if (Test-Path -LiteralPath $appLibs) {
        $defaultRoots += $appLibs
    }
    $Roots = $defaultRoots
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ZipEntries {
    param([string]$Path)

    $archive = $null
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
        return @($archive.Entries | ForEach-Object { $_.FullName })
    } finally {
        if ($archive) {
            $archive.Dispose()
        }
    }
}

function Get-NestedClassesJarEntries {
    param([string]$Path)

    $archive = $null
    $nestedArchive = $null
    $memory = $null
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
        $classesJar = $archive.GetEntry("classes.jar")
        if (-not $classesJar) {
            return @()
        }

        $memory = New-Object System.IO.MemoryStream
        $stream = $classesJar.Open()
        try {
            $stream.CopyTo($memory)
        } finally {
            $stream.Dispose()
        }
        $memory.Position = 0
        $nestedArchive = New-Object System.IO.Compression.ZipArchive($memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
        return @($nestedArchive.Entries | ForEach-Object { $_.FullName })
    } finally {
        if ($nestedArchive) {
            $nestedArchive.Dispose()
        }
        if ($memory) {
            $memory.Dispose()
        }
        if ($archive) {
            $archive.Dispose()
        }
    }
}

function Get-ArtifactCoordinate {
    param([string]$Path)

    $normalized = $Path -replace "/", "\"
    $marker = "\modules-2\files-2.1\"
    $index = $normalized.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
    if ($index -lt 0) {
        return [ordered]@{
            group = ""
            artifact = [System.IO.Path]::GetFileNameWithoutExtension($Path)
            version = ""
            coordinate = [System.IO.Path]::GetFileName($Path)
        }
    }

    $tail = $normalized.Substring($index + $marker.Length)
    $parts = $tail -split "\\"
    if ($parts.Count -lt 5) {
        return [ordered]@{
            group = ""
            artifact = [System.IO.Path]::GetFileNameWithoutExtension($Path)
            version = ""
            coordinate = [System.IO.Path]::GetFileName($Path)
        }
    }

    return [ordered]@{
        group = $parts[0]
        artifact = $parts[1]
        version = $parts[2]
        coordinate = "$($parts[0]):$($parts[1]):$($parts[2])"
    }
}

function Select-UniqueSorted {
    param([object[]]$Values)

    return @($Values | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
}

$artifactPattern = "(?i)(rokid|cxr|security|glass|audioai|turenso|nlpconsumer|rfmlite|aicore)"
$voicePattern = "(?i)(asr|tts|speech|voice|audioai|rfm|nlp)"
$files = @()
foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) {
        continue
    }
    $files += Get-ChildItem -LiteralPath $root -Recurse -File -Include *.aar,*.jar -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match $artifactPattern -or $_.Name -match $artifactPattern }
}

$results = @()
foreach ($file in ($files | Sort-Object FullName -Unique)) {
    $entries = @()
    $classEntries = @()
    $errorText = ""
    try {
        $entries = Get-ZipEntries -Path $file.FullName
        if ($file.Extension -ieq ".aar") {
            $classEntries = Get-NestedClassesJarEntries -Path $file.FullName
        } else {
            $classEntries = @($entries | Where-Object { $_ -match "\.class$" })
        }
    } catch {
        $errorText = $_.Exception.Message
    }

    $nativeAbis = @()
    foreach ($entry in $entries) {
        $match = [regex]::Match($entry, "^(?:jni|lib)/([^/]+)/.*\.so$", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) {
            $nativeAbis += $match.Groups[1].Value
        }
    }
    $nativeAbis = Select-UniqueSorted -Values $nativeAbis

    $voiceClassHints = @(
        $classEntries |
            Where-Object { $_ -match $voicePattern } |
            Select-Object -First $MaxClassHints
    )

    $voiceAssetHints = @(
        $entries |
            Where-Object { $_ -match $voicePattern -and $_ -notmatch "\.class$" } |
            Select-Object -First $MaxClassHints
    )

    $coordinate = Get-ArtifactCoordinate -Path $file.FullName
    $results += [pscustomobject][ordered]@{
        coordinate = $coordinate.coordinate
        group = $coordinate.group
        artifact = $coordinate.artifact
        version = $coordinate.version
        fileName = $file.Name
        extension = $file.Extension.TrimStart(".").ToLowerInvariant()
        path = $file.FullName
        length = $file.Length
        nativeAbis = @($nativeAbis)
        hasArm64 = [bool]($nativeAbis -contains "arm64-v8a")
        hasArmeabiV7a = [bool]($nativeAbis -contains "armeabi-v7a")
        hasAnyNative = [bool]($nativeAbis.Count -gt 0)
        classEntryCount = @($classEntries).Count
        hasVoiceClassHints = [bool]($voiceClassHints.Count -gt 0)
        voiceClassHints = @($voiceClassHints)
        voiceAssetHints = @($voiceAssetHints)
        error = $errorText
    }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-sdk-artifacts-summary-$timestamp.json"
$tablePath = Join-Path $OutputDir "rokid-sdk-artifacts-summary-$timestamp.md"

$summary = [pscustomobject][ordered]@{
    generatedAt = (Get-Date).ToString("o")
    roots = @($Roots)
    artifactCount = @($results).Count
    arm64VoiceCandidates = @($results | Where-Object { $_.hasArm64 -and ($_.hasVoiceClassHints -or $_.voiceAssetHints.Count -gt 0) })
    armeabiOnlyVoiceCandidates = @($results | Where-Object { -not $_.hasArm64 -and $_.hasArmeabiV7a -and ($_.hasVoiceClassHints -or $_.voiceAssetHints.Count -gt 0) })
    artifacts = @($results)
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$lines = @()
$lines += "# Rokid SDK Artifact Inventory"
$lines += ""
$lines += "Generated: $($summary.generatedAt)"
$lines += ""
$lines += "| Coordinate | File | Native ABI | Voice hints | Path |"
$lines += "| --- | --- | --- | --- | --- |"
foreach ($item in $results) {
    $abis = if ($item.nativeAbis.Count -gt 0) { $item.nativeAbis -join ", " } else { "<none>" }
    $hints = @()
    if ($item.hasVoiceClassHints) { $hints += "class" }
    if ($item.voiceAssetHints.Count -gt 0) { $hints += "asset" }
    $hintText = if ($hints.Count -gt 0) { $hints -join "+" } else { "<none>" }
    $lines += "| `$($item.coordinate)` | `$($item.fileName)` | `$abis` | `$hintText` | `$($item.path)` |"
}
$lines | Set-Content -LiteralPath $tablePath -Encoding UTF8

$results |
    Sort-Object @{Expression = { -not $_.hasArm64 }}, artifact, version, fileName |
    Select-Object coordinate, fileName, @{Name="nativeAbis";Expression={$_.nativeAbis -join ","}}, hasArm64, hasVoiceClassHints |
    Format-Table -AutoSize

Write-Host "Summary: $summaryPath"
Write-Host "Table: $tablePath"
