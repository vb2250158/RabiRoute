param(
    [string]$OutputDir = "",
    [int]$RecentFileCount = 20,
    [switch]$IncludeApkInfo
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$sourceRoot = Join-Path $projectRoot "out\rokid-native-voice"

if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw "没有找到 Rokid 原生语音输出目录：$sourceRoot"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $sourceRoot ("evidence-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Copy-IfExists {
    param(
        [string]$Path,
        [string]$TargetDir
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    $target = Join-Path $TargetDir (Split-Path -Leaf $Path)
    Copy-Item -LiteralPath $Path -Destination $target -Force
    return (Resolve-Path -LiteralPath $target).Path
}

function Copy-LatestByPattern {
    param(
        [string]$Pattern,
        [string]$TargetSubdir,
        [int]$Count
    )

    $targetDir = Join-Path $OutputDir $TargetSubdir
    $files = Get-ChildItem -LiteralPath $sourceRoot -Filter $Pattern -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First $Count
    $copied = @()
    foreach ($file in $files) {
        $copied += Copy-IfExists -Path $file.FullName -TargetDir $targetDir
    }
    return @($copied | Where-Object { $_ })
}

function Add-JsonSummaryLinks {
    param([string[]]$SummaryPaths)

    $links = @()
    foreach ($summary in $SummaryPaths) {
        try {
            $parsed = Get-Content -LiteralPath $summary -Raw | ConvertFrom-Json
            foreach ($property in @("rawLog", "filteredLog", "manifestPath")) {
                $value = $parsed.PSObject.Properties[$property]?.Value
                if ($value) {
                    $links += [string]$value
                }
            }
        } catch {
            # Ignore malformed historical files; index still records the copied summary.
        }
    }
    return @($links | Select-Object -Unique)
}

$copied = [ordered]@{
    readinessSummaries = Copy-LatestByPattern -Pattern "rokid-native-readiness-summary-*.json" -TargetSubdir "readiness" -Count $RecentFileCount
    readinessLogs = Copy-LatestByPattern -Pattern "rokid-native-readiness-log-*.txt" -TargetSubdir "readiness" -Count $RecentFileCount
    selfTestSummaries = Copy-LatestByPattern -Pattern "rokid-native-voice-summary-*.json" -TargetSubdir "self-test" -Count $RecentFileCount
    selfTestFilteredLogs = Copy-LatestByPattern -Pattern "rokid-native-voice-filtered-*.txt" -TargetSubdir "self-test" -Count $RecentFileCount
    realDeviceSummaries = Copy-LatestByPattern -Pattern "rokid-native-voice-real-summary-*.json" -TargetSubdir "real-device" -Count $RecentFileCount
    realDeviceFilteredLogs = Copy-LatestByPattern -Pattern "rokid-native-voice-real-filtered-*.txt" -TargetSubdir "real-device" -Count $RecentFileCount
    commandSummaries = Copy-LatestByPattern -Pattern "rokid-native-command-summary-*.json" -TargetSubdir "commands" -Count $RecentFileCount
    commandFilteredLogs = Copy-LatestByPattern -Pattern "rokid-native-command-filtered-*.txt" -TargetSubdir "commands" -Count $RecentFileCount
}

$manifestFiles = Get-ChildItem -LiteralPath $sourceRoot -Filter "rokid-native-voice-stack.json" -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First $RecentFileCount
$copied.stackManifests = @($manifestFiles | ForEach-Object {
    Copy-IfExists -Path $_.FullName -TargetDir (Join-Path $OutputDir "stack")
} | Where-Object { $_ })

$linkedFiles = Add-JsonSummaryLinks -SummaryPaths @(
    $copied.readinessSummaries +
    $copied.selfTestSummaries +
    $copied.realDeviceSummaries +
    $copied.commandSummaries
)
$copied.linkedEvidence = @($linkedFiles | ForEach-Object {
    Copy-IfExists -Path $_ -TargetDir (Join-Path $OutputDir "linked")
} | Where-Object { $_ })

if ($IncludeApkInfo) {
    $apkDir = Join-Path $OutputDir "apk"
    Copy-IfExists -Path (Join-Path $projectRoot "app\build\outputs\apk\debug\app-debug.apk") -TargetDir $apkDir | Out-Null
    Copy-IfExists -Path (Join-Path $projectRoot "glass-asr\build\outputs\apk\debug\glass-asr-debug.apk") -TargetDir $apkDir | Out-Null
}

$index = [ordered]@{
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    projectRoot = (Resolve-Path -LiteralPath $projectRoot).Path
    sourceRoot = (Resolve-Path -LiteralPath $sourceRoot).Path
    outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    recentFileCount = $RecentFileCount
    copied = $copied
    completionEvidenceStillRequired = @(
        "真实 RABI_PONG 或 ping command_ack",
        "真实 RABI_ASR:<非空文本> 或 RABI_ROKID_AI_ASR:<非空文本>",
        "真实 RABI_TTS_OK:<文本> 或 RABI_ROKID_AI_TTS_REQUEST:<文本>",
        "实际听到 Rokid 眼镜播报"
    )
}

$indexPath = Join-Path $OutputDir "rokid-native-evidence-index.json"
$index | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $indexPath -Encoding UTF8

[pscustomobject]@{
    OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    Index = (Resolve-Path -LiteralPath $indexPath).Path
    ReadinessSummaries = $copied.readinessSummaries.Count
    SelfTestSummaries = $copied.selfTestSummaries.Count
    RealDeviceSummaries = $copied.realDeviceSummaries.Count
    CommandSummaries = $copied.commandSummaries.Count
    StackManifests = $copied.stackManifests.Count
}
