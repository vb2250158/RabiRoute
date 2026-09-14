param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$ConfigPath = "",
    [string]$OutputDir = "",
    [string]$TtsText = "Rabi 眼镜 AI SDK TTS 测试",
    [int]$WaitSeconds = 10,
    [switch]$CreateTemplate,
    [switch]$SkipConfigSend,
    [switch]$ProbeOnly,
    [switch]$ConfirmHeardTts
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$readinessScript = Join-Path $PSScriptRoot "Test-RokidGlassAiSdkReadiness.ps1"
$configScript = Join-Path $PSScriptRoot "Set-RokidGlassAiSdkConfig.ps1"
$sendScript = Join-Path $PSScriptRoot "Send-RokidNativeVoiceCommand.ps1"
$collectEvidenceScript = Join-Path $PSScriptRoot "Collect-RokidNativeVoiceEvidence.ps1"
$assertCompletionScript = Join-Path $PSScriptRoot "Assert-RokidNativeVoiceCompletion.ps1"

foreach ($script in @($readinessScript, $configScript, $sendScript, $collectEvidenceScript, $assertCompletionScript)) {
    if (-not (Test-Path -LiteralPath $script)) {
        throw "缺少脚本：$script"
    }
}

function Add-OptionalArg {
    param(
        [hashtable]$Params,
        [string]$Name,
        [string]$Value
    )

    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $Params[$Name] = $Value
    }
}

function Invoke-And-Capture {
    param(
        [scriptblock]$Block,
        [string]$Path
    )

    $output = @(& $Block 2>&1)
    $output | Set-Content -LiteralPath $Path -Encoding UTF8
    return @($output)
}

function Read-JsonFromOutput {
    param([object[]]$Output)

    $text = (@($Output) -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    return $text | ConvertFrom-Json
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $projectRoot "secrets\rokid-ai-sdk.properties"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot ("out\rokid-native-voice\glass-ai-trial-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ($CreateTemplate) {
    $templateOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "create-template-output.txt") -Block {
        & $configScript -ConfigPath $ConfigPath -CreateTemplate
    }
    $templateJson = Read-JsonFromOutput -Output $templateOutput
    [ordered]@{
        ok = $true
        status = "template_created"
        outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        configPath = if ($templateJson) { [string]$templateJson.configPath } else { $ConfigPath }
        nextAction = "填入 Rokid 开放平台审核后给出的 key/secret/deviceTypeId/deviceId/seed，再运行本脚本。"
    } | ConvertTo-Json -Depth 5
    exit 0
}

$readinessBeforeOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "readiness-before-output.txt") -Block {
    & $readinessScript -ConfigPath $ConfigPath -OutputDir (Join-Path $projectRoot "out\rokid-native-voice")
}
$readinessBefore = Read-JsonFromOutput -Output $readinessBeforeOutput
if (-not $readinessBefore) {
    throw "readiness 输出不是 JSON，请查看：$(Join-Path $OutputDir 'readiness-before-output.txt')"
}

if (-not [bool]$readinessBefore.phoneApk.exists -or -not [bool]$readinessBefore.glassApk.exists) {
    [ordered]@{
        ok = $false
        status = "apk_missing"
        outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        readiness = $readinessBefore
        nextAction = "先运行 Gradle :app:assembleDebug，并安装新版手机 APK。"
    } | ConvertTo-Json -Depth 8
    exit 0
}

if (-not [bool]$readinessBefore.config.complete -and -not $SkipConfigSend) {
    [ordered]@{
        ok = $false
        status = "waiting_credentials"
        outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        readiness = $readinessBefore
        nextAction = "等待 Rokid 审核/语音接入凭证；拿到后可填入本机 secrets 配置再运行本脚本。若已在手机 APK 第 09 卡片填写并保存，再由第 07 卡片发送到眼镜端，可改用 -SkipConfigSend 只做 start/tts/证据收集。"
    } | ConvertTo-Json -Depth 8
    exit 0
}

if (-not $SkipConfigSend) {
    Invoke-And-Capture -Path (Join-Path $OutputDir "send-config-output.txt") -Block {
        $params = @{
            ConfigPath = $ConfigPath
            OutputDir = (Join-Path $projectRoot "out\rokid-native-voice")
            WaitSeconds = $WaitSeconds
            ProbeAfter = $true
        }
        Add-OptionalArg -Params $params -Name "Serial" -Value $Serial
        Add-OptionalArg -Params $params -Name "AdbPath" -Value $AdbPath
        & $configScript @params
    } | Out-Null
}

$startOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "start-output.txt") -Block {
    $params = @{
        Command = "glass_rokid_ai_start"
        OutputDir = (Join-Path $projectRoot "out\rokid-native-voice")
        WaitSeconds = $WaitSeconds
    }
    Add-OptionalArg -Params $params -Name "Serial" -Value $Serial
    Add-OptionalArg -Params $params -Name "AdbPath" -Value $AdbPath
    & $sendScript @params
}

$ttsOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "tts-output.txt") -Block {
    $params = @{
        Command = "glass_rokid_ai_tts"
        Text = $TtsText
        OutputDir = (Join-Path $projectRoot "out\rokid-native-voice")
        WaitSeconds = $WaitSeconds
    }
    Add-OptionalArg -Params $params -Name "Serial" -Value $Serial
    Add-OptionalArg -Params $params -Name "AdbPath" -Value $AdbPath
    & $sendScript @params
}

$readinessAfterOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "readiness-after-output.txt") -Block {
    & $readinessScript -ConfigPath $ConfigPath -OutputDir (Join-Path $projectRoot "out\rokid-native-voice")
}
$readinessAfter = Read-JsonFromOutput -Output $readinessAfterOutput

if ($ProbeOnly) {
    $evidenceDir = Join-Path $OutputDir "evidence"
    Invoke-And-Capture -Path (Join-Path $OutputDir "collect-evidence-output.txt") -Block {
        & $collectEvidenceScript -OutputDir $evidenceDir -RecentFileCount 10
    } | Out-Null
    $evidenceIndex = Join-Path $evidenceDir "rokid-native-evidence-index.json"

    $summary = [ordered]@{
        ok = $false
        status = "probe_only"
        generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
        outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        serial = $Serial
        configPath = $ConfigPath
        skippedConfigSend = [bool]$SkipConfigSend
        readinessBefore = $readinessBefore
        readinessAfter = $readinessAfter
        evidenceIndex = if (Test-Path -LiteralPath $evidenceIndex) { (Resolve-Path -LiteralPath $evidenceIndex).Path } else { "" }
        nextAction = "ProbeOnly 已完成；查看 readinessAfter/latestGlassAiEvidence。确认 credentials/configured 和眼镜 APK 状态后，再去掉 -ProbeOnly 执行 start/tts/完成断言。"
    }
    $summaryPath = Join-Path $OutputDir "rokid-glass-ai-sdk-trial-summary.json"
    $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

    [ordered]@{
        Ok = $false
        Status = "probe_only"
        OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        Summary = (Resolve-Path -LiteralPath $summaryPath).Path
        EvidenceIndex = $summary.evidenceIndex
        NextAction = $summary.nextAction
    } | ConvertTo-Json -Depth 6
    exit 0
}

$evidenceDir = Join-Path $OutputDir "evidence"
$evidenceOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "collect-evidence-output.txt") -Block {
    & $collectEvidenceScript -OutputDir $evidenceDir -RecentFileCount 10
}
$evidenceIndex = Join-Path $evidenceDir "rokid-native-evidence-index.json"

$assertOutput = Invoke-And-Capture -Path (Join-Path $OutputDir "assert-completion-output.txt") -Block {
    $params = @{
        EvidenceIndexPath = $evidenceIndex
    }
    if ($ConfirmHeardTts) {
        $params.ConfirmHeardTts = $true
    }
    & $assertCompletionScript @params
}
$assertVerdictPath = Join-Path $evidenceDir "rokid-native-completion-verdict.json"
$assertVerdict = if (Test-Path -LiteralPath $assertVerdictPath) {
    Get-Content -LiteralPath $assertVerdictPath -Raw | ConvertFrom-Json
} else {
    $null
}

$summary = [ordered]@{
    ok = if ($assertVerdict) { [bool]$assertVerdict.passed } else { $false }
    status = if ($assertVerdict -and [bool]$assertVerdict.passed) { "complete" } else { "not_complete" }
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    serial = $Serial
    configPath = $ConfigPath
    skippedConfigSend = [bool]$SkipConfigSend
    readinessBefore = $readinessBefore
    readinessAfter = $readinessAfter
    evidenceIndex = if (Test-Path -LiteralPath $evidenceIndex) { (Resolve-Path -LiteralPath $evidenceIndex).Path } else { "" }
    completionVerdict = $assertVerdict
    nextAction = if ($assertVerdict -and [bool]$assertVerdict.passed) {
        "原生 ASR/TTS 验收通过；保留 evidence 目录作为证据。"
    } else {
        "查看 completionVerdict.missing；若缺 ASR/TTS 回包，继续等官方凭证/权限或检查眼镜端 service 状态。"
    }
}
$summaryPath = Join-Path $OutputDir "rokid-glass-ai-sdk-trial-summary.json"
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

[ordered]@{
    Ok = [bool]$summary.ok
    Status = $summary.status
    OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    Summary = (Resolve-Path -LiteralPath $summaryPath).Path
    EvidenceIndex = $summary.evidenceIndex
    CompletionMissing = if ($assertVerdict) { ($assertVerdict.missing -join " | ") } else { "completion verdict missing" }
    NextAction = $summary.nextAction
} | ConvertTo-Json -Depth 6
