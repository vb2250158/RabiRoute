param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$WebhookUrl = "http://127.0.0.1:8791/webhook",
    [int]$TtsPort = 8794,
    [string]$OutputDir = "",
    [string[]]$Commands = @("ping", "tts", "asr_start", "asr_stop"),
    [string]$TtsText = "Rabi 原生 TTS 真机测试",
    [int]$AsrListenSeconds = 12,
    [int]$WaitAfterCommandSeconds = 8,
    [switch]$Build,
    [switch]$Install,
    [switch]$SkipStack,
    [switch]$KeepStackRunning,
    [switch]$SkipRealDevice,
    [switch]$ConfirmHeardTts
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$startStackScript = Join-Path $PSScriptRoot "Start-RokidNativeVoiceStack.ps1"
$stopStackScript = Join-Path $PSScriptRoot "Stop-RokidNativeVoiceStack.ps1"
$readinessScript = Join-Path $PSScriptRoot "Test-RokidNativeVoiceReadiness.ps1"
$realDeviceScript = Join-Path $PSScriptRoot "Test-RokidNativeVoiceRealDevice.ps1"
$collectEvidenceScript = Join-Path $PSScriptRoot "Collect-RokidNativeVoiceEvidence.ps1"
$assertCompletionScript = Join-Path $PSScriptRoot "Assert-RokidNativeVoiceCompletion.ps1"

foreach ($script in @($startStackScript, $stopStackScript, $readinessScript, $realDeviceScript, $collectEvidenceScript, $assertCompletionScript)) {
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

function Find-LatestStackManifestAfter {
    param([DateTime]$After)

    Get-ChildItem -LiteralPath (Join-Path $projectRoot "out\rokid-native-voice") -Filter "rokid-native-voice-stack.json" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $After.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot ("out\rokid-native-voice\trial-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$startedAt = Get-Date
$stackManifestPath = ""
$stackStartOutput = @()

try {
    if (-not $SkipStack) {
        $stackParams = @{
            TtsPort = $TtsPort
            OutputDir = (Join-Path $OutputDir "stack")
        }
        Add-OptionalArg -Params $stackParams -Name "Serial" -Value $Serial
        Add-OptionalArg -Params $stackParams -Name "AdbPath" -Value $AdbPath
        Add-OptionalArg -Params $stackParams -Name "WebhookUrl" -Value $WebhookUrl
        $stackStartOutput = @(& $startStackScript @stackParams 2>&1)
        $stackStartOutput | Set-Content -LiteralPath (Join-Path $OutputDir "start-stack-output.txt") -Encoding UTF8

        $stackManifest = Find-LatestStackManifestAfter -After $startedAt
        if ($stackManifest) {
            $stackManifestPath = $stackManifest.FullName
        }
    }

    $readinessBeforeParams = @{
        OutputDir = $OutputDir
    }
    Add-OptionalArg -Params $readinessBeforeParams -Name "Serial" -Value $Serial
    Add-OptionalArg -Params $readinessBeforeParams -Name "AdbPath" -Value $AdbPath
    Add-OptionalArg -Params $readinessBeforeParams -Name "ManifestPath" -Value $stackManifestPath
    $readinessBefore = @(& $readinessScript @readinessBeforeParams 2>&1)
    $readinessBefore | Set-Content -LiteralPath (Join-Path $OutputDir "readiness-before-output.txt") -Encoding UTF8

    $realDeviceOutput = @()
    if (-not $SkipRealDevice) {
        $realParams = @{
            OutputDir = $OutputDir
            Commands = $Commands
            TtsText = $TtsText
            AsrListenSeconds = $AsrListenSeconds
            WaitAfterCommandSeconds = $WaitAfterCommandSeconds
        }
        Add-OptionalArg -Params $realParams -Name "Serial" -Value $Serial
        Add-OptionalArg -Params $realParams -Name "AdbPath" -Value $AdbPath
        if ($Build) {
            $realParams.Build = $true
        }
        if ($Install) {
            $realParams.Install = $true
        }
        $realDeviceOutput = @(& $realDeviceScript @realParams 2>&1)
    } else {
        $realDeviceOutput = @("Skipped real-device test by -SkipRealDevice.")
    }
    $realDeviceOutput | Set-Content -LiteralPath (Join-Path $OutputDir "real-device-output.txt") -Encoding UTF8

    $readinessAfterParams = @{
        OutputDir = $OutputDir
    }
    Add-OptionalArg -Params $readinessAfterParams -Name "Serial" -Value $Serial
    Add-OptionalArg -Params $readinessAfterParams -Name "AdbPath" -Value $AdbPath
    Add-OptionalArg -Params $readinessAfterParams -Name "ManifestPath" -Value $stackManifestPath
    $readinessAfter = @(& $readinessScript @readinessAfterParams 2>&1)
    $readinessAfter | Set-Content -LiteralPath (Join-Path $OutputDir "readiness-after-output.txt") -Encoding UTF8

    $evidenceDir = Join-Path $OutputDir "evidence"
    $evidenceOutput = @(& $collectEvidenceScript -OutputDir $evidenceDir -RecentFileCount 10 2>&1)
    $evidenceOutput | Set-Content -LiteralPath (Join-Path $OutputDir "collect-evidence-output.txt") -Encoding UTF8
    $evidenceIndex = Join-Path $evidenceDir "rokid-native-evidence-index.json"

    $assertParams = @{
        EvidenceIndexPath = $evidenceIndex
    }
    if ($ConfirmHeardTts) {
        $assertParams.ConfirmHeardTts = $true
    }
    $assertOutput = @(& $assertCompletionScript @assertParams 2>&1)
    $assertOutput | Set-Content -LiteralPath (Join-Path $OutputDir "assert-completion-output.txt") -Encoding UTF8

    $assertVerdictPath = Join-Path $evidenceDir "rokid-native-completion-verdict.json"
    $assertVerdict = if (Test-Path -LiteralPath $assertVerdictPath) {
        Get-Content -LiteralPath $assertVerdictPath -Raw | ConvertFrom-Json
    } else {
        $null
    }

    $trialSummary = [ordered]@{
        generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
        outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        serial = $Serial
        stackManifest = $stackManifestPath
        skippedStack = [bool]$SkipStack
        skippedRealDevice = [bool]$SkipRealDevice
        evidenceIndex = if (Test-Path -LiteralPath $evidenceIndex) { (Resolve-Path -LiteralPath $evidenceIndex).Path } else { "" }
        completionVerdict = $assertVerdict
    }
    $trialSummaryPath = Join-Path $OutputDir "rokid-native-trial-summary.json"
    $trialSummary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $trialSummaryPath -Encoding UTF8

    $result = [ordered]@{
        OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
        Summary = (Resolve-Path -LiteralPath $trialSummaryPath).Path
        EvidenceIndex = $trialSummary.evidenceIndex
        CompletionPassed = if ($assertVerdict) { [bool]$assertVerdict.passed } else { $false }
        CompletionMissing = if ($assertVerdict) { ($assertVerdict.missing -join " | ") } else { "completion verdict missing" }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6))
} finally {
    if (-not $SkipStack -and -not $KeepStackRunning -and -not [string]::IsNullOrWhiteSpace($stackManifestPath)) {
        & $stopStackScript -ManifestPath $stackManifestPath | Out-Null
    }
}
