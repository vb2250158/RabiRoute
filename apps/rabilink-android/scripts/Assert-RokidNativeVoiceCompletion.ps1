param(
    [string]$EvidenceIndexPath = "",
    [string]$OutputPath = "",
    [switch]$ConfirmHeardTts
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$sourceRoot = Join-Path $projectRoot "out\rokid-native-voice"

function Find-LatestEvidenceIndex {
    Get-ChildItem -LiteralPath $sourceRoot -Filter "rokid-native-evidence-index.json" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function First-ExistingPath {
    param([object[]]$Items)

    foreach ($item in @($Items)) {
        $path = [string]$item
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }
    return ""
}

function Read-JsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Read-TextFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return ""
    }
    return Get-Content -LiteralPath $Path -Raw
}

function Read-TextFiles {
    param([object[]]$Paths)

    $parts = @()
    foreach ($path in @($Paths)) {
        $text = Read-TextFile -Path ([string]$path)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $parts += $text
        }
    }
    return ($parts -join "`n")
}

if ([string]::IsNullOrWhiteSpace($EvidenceIndexPath)) {
    $latest = Find-LatestEvidenceIndex
    if (-not $latest) {
        throw "没有找到 evidence index。请先运行 Collect-RokidNativeVoiceEvidence.ps1。"
    }
    $EvidenceIndexPath = $latest.FullName
}

if (-not (Test-Path -LiteralPath $EvidenceIndexPath)) {
    throw "evidence index 不存在：$EvidenceIndexPath"
}

$index = Read-JsonFile -Path $EvidenceIndexPath
$copied = $index.copied

$latestReadinessPath = First-ExistingPath -Items @($copied.readinessSummaries)
$latestRealDevicePath = First-ExistingPath -Items @($copied.realDeviceSummaries)
$latestRealLogPath = First-ExistingPath -Items @($copied.realDeviceFilteredLogs)
$latestCommandPath = First-ExistingPath -Items @($copied.commandSummaries)
$latestCommandLogPath = First-ExistingPath -Items @($copied.commandFilteredLogs)

$latestReadiness = Read-JsonFile -Path $latestReadinessPath
$latestRealDevice = Read-JsonFile -Path $latestRealDevicePath
$latestCommand = Read-JsonFile -Path $latestCommandPath
$latestRealLogText = Read-TextFile -Path $latestRealLogPath
$latestCommandLogText = Read-TextFile -Path $latestCommandLogPath
$allCommandLogText = Read-TextFiles -Paths @($copied.commandFilteredLogs)

$readinessChecks = $null
if ($latestReadiness) {
    $readinessChecks = $latestReadiness.checks
}
$realChecks = $null
if ($latestRealDevice) {
    $realChecks = $latestRealDevice.checks
}
$commandResults = $null
if ($latestCommand) {
    $commandResults = $latestCommand.results
}
$realEvidenceText = $latestRealLogText + "`n" + $latestCommandLogText + "`n" + $allCommandLogText

$readinessNoFatal = $false
if ($readinessChecks) {
    $property = $readinessChecks.PSObject.Properties["noFatalException"]
    if ($null -ne $property) {
        $readinessNoFatal = [bool]$property.Value
    }
}
$realNoFatal = $false
if ($realChecks) {
    $property = $realChecks.PSObject.Properties["noFatalException"]
    if ($null -ne $property) {
        $realNoFatal = [bool]$property.Value
    }
}

$glassSdkAsrStartAck = [bool]($realEvidenceText -match "RABI_ASR_START_OK:|眼镜原生命令 ack kind=asr_start")
$glassSdkAsrText = [bool]($realEvidenceText -match "RABI_ASR:[^\r\n]+|收到眼镜端原生 ASR 文本：\S")
$glassSdkTtsAck = [bool]($realEvidenceText -match "RABI_TTS_OK:|眼镜原生 TTS ack")
$glassSdkRouteComplete = [bool]($glassSdkAsrStartAck -and $glassSdkAsrText -and $glassSdkTtsAck)

$rokidAiSdkServiceStarted = [bool]($realEvidenceText -match "RABI_ROKID_AI_STATE:.*service_connected|RokidAiSdk state=service_connected|RABI_ROKID_AI_STATE:.*recording_started|RokidAiSdk state=recording_started")
$rokidAiSdkAsrText = [bool](
    ($commandResults -and -not [string]::IsNullOrWhiteSpace([string]$commandResults.rokidAiSdkAsrFinalText)) -or
    ($realEvidenceText -match "RABI_ROKID_AI_ASR:[^\r\n]+|RokidAiSdk ASR final .* text=\S")
)
$rokidAiSdkTtsRequest = [bool](
    ($commandResults -and [bool]$commandResults.rokidAiSdkTtsRequestSeen) -or
    ($realEvidenceText -match "RABI_ROKID_AI_TTS_REQUEST:[^\r\n]+|RokidAiSdk TTS requested")
)
$rokidAiSdkRouteComplete = [bool]($rokidAiSdkAsrText -and $rokidAiSdkTtsRequest)

$requirements = [ordered]@{
    realDeviceSummaryPresent = [bool]$latestRealDevice
    phoneToGlassMessageReachable = [bool](
        ($realEvidenceText -match "RABI_PONG:|眼镜原生命令 ack kind=ping")
    )
    glassSdkRouteComplete = $glassSdkRouteComplete
    rokidAiSdkRouteComplete = $rokidAiSdkRouteComplete
    nativeAsrStartAck = [bool]($glassSdkAsrStartAck -or $rokidAiSdkServiceStarted -or $rokidAiSdkAsrText)
    nativeAsrText = [bool]($glassSdkAsrText -or $rokidAiSdkAsrText)
    nativeTtsAck = [bool]($glassSdkTtsAck -or $rokidAiSdkTtsRequest)
    heardTtsPlayback = [bool]$ConfirmHeardTts
    noFatalException = [bool]($realNoFatal -or $readinessNoFatal)
}

$missing = @()
if (-not $requirements.realDeviceSummaryPresent) { $missing += "缺少 Test-RokidNativeVoiceRealDevice.ps1 生成的真机无注入 summary。" }
if (-not $requirements.phoneToGlassMessageReachable) { $missing += "缺少真实 RABI_PONG 或 ping command_ack。" }
if (-not ($requirements.glassSdkRouteComplete -or $requirements.rokidAiSdkRouteComplete)) { $missing += "缺少同一路线完整闭环：Glass SDK 需 RABI_ASR + RABI_TTS_OK；RokidAiSdk 需 RABI_ROKID_AI_ASR + RABI_ROKID_AI_TTS_REQUEST。" }
if (-not $requirements.nativeAsrStartAck) { $missing += "缺少真实 RABI_ASR_START_OK/asr_start ack，或 RokidAiSdk service_connected/ASR 回包。" }
if (-not $requirements.nativeAsrText) { $missing += "缺少真实 RABI_ASR:<非空文本> 或 RABI_ROKID_AI_ASR:<非空文本>。" }
if (-not $requirements.nativeTtsAck) { $missing += "缺少真实 RABI_TTS_OK:<文本> 或 RABI_ROKID_AI_TTS_REQUEST:<文本>。" }
if (-not $requirements.heardTtsPlayback) { $missing += "缺少人工确认实际听到 Rokid 眼镜播报；如已确认，运行时加 -ConfirmHeardTts。" }
if (-not $requirements.noFatalException) { $missing += "缺少无崩溃证据，或日志中出现 FATAL EXCEPTION。" }

$passed = $missing.Count -eq 0
$result = [ordered]@{
    passed = $passed
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    evidenceIndex = (Resolve-Path -LiteralPath $EvidenceIndexPath).Path
    sources = [ordered]@{
        readinessSummary = $latestReadinessPath
        realDeviceSummary = $latestRealDevicePath
        realDeviceFilteredLog = $latestRealLogPath
        commandSummary = $latestCommandPath
        commandFilteredLog = $latestCommandLogPath
    }
    requirements = $requirements
    missing = $missing
    verdict = if ($passed) { "complete" } else { "not_complete" }
    note = "本脚本只采信真机无注入证据、单命令真机证据和 readiness 里的真实 RABI_* 回包；注入自测不作为完成依据。"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path (Split-Path -Parent $EvidenceIndexPath) "rokid-native-completion-verdict.json"
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

[pscustomobject]@{
    Passed = $passed
    Verdict = $result.verdict
    Output = (Resolve-Path -LiteralPath $OutputPath).Path
    Missing = ($missing -join " | ")
}
