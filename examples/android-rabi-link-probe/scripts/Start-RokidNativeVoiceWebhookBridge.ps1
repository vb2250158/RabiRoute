param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$WebhookUrl = "",
    [string]$Source = "rokid-native-voice",
    [string]$SourceDeviceName = "Rokid Glass",
    [string]$SessionId = "",
    [string[]]$ForwardEventTypes = @("asr_text"),
    [switch]$Dump,
    [switch]$ClearBeforeWatch,
    [switch]$Dedupe,
    [switch]$IncludeRaw,
    [switch]$DryRun,
    [int]$MaxEvents = 0
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$watchScript = Join-Path $PSScriptRoot "Watch-RokidNativeVoiceEvents.ps1"

if (-not (Test-Path -LiteralPath $watchScript)) {
    throw "事件监听脚本不存在：$watchScript"
}

if ([string]::IsNullOrWhiteSpace($WebhookUrl)) {
    $WebhookUrl = if ([string]::IsNullOrWhiteSpace($env:RABIROUTE_WEBHOOK_URL)) {
        "http://127.0.0.1:8791/webhook"
    } else {
        $env:RABIROUTE_WEBHOOK_URL
    }
}

if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = "rokid-native-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

function Convert-EventToWebhookPayload {
    param([object]$Event)

    $text = ""
    if ($null -ne $Event.text) {
        $text = [string]$Event.text
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    $eventKind = ""
    if ($null -ne $Event.kind) {
        $eventKind = [string]$Event.kind
    }
    $protocol = ""
    if ($null -ne $Event.protocol) {
        $protocol = [string]$Event.protocol
    }
    $isAndroidSystemVoice = ($eventKind -eq "android_system") -or $protocol.StartsWith("RABI_ANDROID_")
    $isRokidAiSdkVoice = ($eventKind -eq "rokid_ai_sdk") -or $protocol.StartsWith("RABI_ROKID_AI_")

    $sourceArea = if ($isAndroidSystemVoice) {
        "android-system-voice"
    } elseif ($isRokidAiSdkVoice) {
        "rokid-ai-sdk-voice"
    } else {
        "rokid-glass"
    }
    $speakerName = if ($isAndroidSystemVoice) {
        "Android 系统 ASR"
    } elseif ($isRokidAiSdkVoice) {
        "RokidAiSdk ASR"
    } else {
        "Rokid 原生 ASR"
    }

    $payload = [ordered]@{
        type = "voice_transcript"
        source = $Source
        sourceDeviceName = $SourceDeviceName
        sourceArea = $sourceArea
        sessionId = $SessionId
        messageId = "rokid-native-" + (Get-Date -Format "yyyyMMddHHmmssfff")
        time = [int][DateTimeOffset]::Now.ToUnixTimeSeconds()
        text = $text.Trim()
        speakerKind = "user"
        speakerName = $speakerName
    }

    return $payload
}

function Send-WebhookPayload {
    param([object]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 6 -Compress
    if ($DryRun) {
        Write-Output $json
        return
    }

    $response = Invoke-WebRequest -Uri $WebhookUrl -Method Post -ContentType "application/json; charset=utf-8" -Body $json -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -notin @(200, 202, 204)) {
        throw "Webhook request failed: HTTP $($response.StatusCode) $($response.Content)"
    }
    Write-Output ([ordered]@{
        forwarded = $true
        statusCode = $response.StatusCode
        webhookUrl = $WebhookUrl
        payload = $Payload
    } | ConvertTo-Json -Depth 6 -Compress)
}

$watchParams = @{}
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $watchParams.Serial = $Serial
}
if (-not [string]::IsNullOrWhiteSpace($AdbPath)) {
    $watchParams.AdbPath = $AdbPath
}
if ($Dump) {
    $watchParams.Dump = $true
}
if ($ClearBeforeWatch) {
    $watchParams.ClearBeforeWatch = $true
}
if ($Dedupe) {
    $watchParams.Dedupe = $true
}
if ($IncludeRaw) {
    $watchParams.IncludeRaw = $true
}

function Handle-EventJsonLine {
    param([string]$Line)

    if ($MaxEvents -gt 0 -and $script:forwardedCount -ge $MaxEvents) {
        return
    }

    $line = [string]$Line
    if ([string]::IsNullOrWhiteSpace($line)) {
        return
    }

    $event = $null
    try {
        $event = $line | ConvertFrom-Json
    } catch {
        Write-Warning "跳过非 JSONL 事件：$line"
        return
    }

    if ($ForwardEventTypes -notcontains [string]$event.type) {
        return
    }

    $payload = Convert-EventToWebhookPayload -Event $event
    if ($null -eq $payload) {
        return
    }

    Send-WebhookPayload -Payload $payload
    $script:forwardedCount++
}

$script:forwardedCount = 0
if ($Dump) {
    $eventLines = @(& $watchScript @watchParams)
    foreach ($eventLine in $eventLines) {
        Handle-EventJsonLine -Line ([string]$eventLine)
    }
} else {
    & $watchScript @watchParams | ForEach-Object {
        Handle-EventJsonLine -Line ([string]$_)
    }
}
