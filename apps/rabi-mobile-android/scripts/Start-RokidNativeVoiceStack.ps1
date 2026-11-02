param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$WebhookUrl = "",
    [ValidateRange(0, 65535)][int]$TtsPort = 0,
    [string]$TtsCommand = "tts",
    [string]$OutputDir = "",
    [string]$SessionId = "",
    [switch]$DryRun,
    [switch]$NoDedupe,
    [switch]$NoClearBeforeWatch
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WebhookUrl)) { $WebhookUrl = $env:RABIROUTE_WEBHOOK_URL }
if ([string]::IsNullOrWhiteSpace($WebhookUrl)) { throw "请通过 -WebhookUrl 或 RABIROUTE_WEBHOOK_URL 指定已配置的 webhook 地址。" }

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$ttsScript = Join-Path $PSScriptRoot "Start-RokidNativeTtsPlaybackServer.ps1"
$webhookBridgeScript = Join-Path $PSScriptRoot "Start-RokidNativeVoiceWebhookBridge.ps1"

if (-not (Test-Path -LiteralPath $ttsScript)) {
    throw "TTS playback server 脚本不存在：$ttsScript"
}
if (-not (Test-Path -LiteralPath $webhookBridgeScript)) {
    throw "ASR webhook bridge 脚本不存在：$webhookBridgeScript"
}

function Resolve-PowerShellExe {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }
    $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($powershell) {
        return $powershell.Source
    }
    throw "没有找到 pwsh 或 powershell.exe。"
}

function Add-OptionalArg {
    param(
        [System.Collections.Generic.List[string]]$ArgList,
        [string]$Name,
        [string]$Value
    )

    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $ArgList.Add($Name)
        $ArgList.Add($Value)
    }
}

function Start-BridgeProcess {
    param(
        [string]$Name,
        [string]$Script,
        [string[]]$ScriptArgs,
        [string]$StdOut,
        [string]$StdErr
    )

    $processArgs = New-Object 'System.Collections.Generic.List[string]'
    $processArgs.Add("-NoProfile")
    $processArgs.Add("-ExecutionPolicy")
    $processArgs.Add("Bypass")
    $processArgs.Add("-File")
    $processArgs.Add($Script)
    foreach ($item in $ScriptArgs) {
        $processArgs.Add($item)
    }

    # Start-Process joins ArgumentList into a command line; preserve paths with spaces.
    $quotedArgs = @($processArgs | ForEach-Object {
        '"' + (([string]$_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    })
    $process = Start-Process `
        -FilePath $script:PowerShellExe `
        -ArgumentList $quotedArgs `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput $StdOut `
        -RedirectStandardError $StdErr `
        -WindowStyle Hidden `
        -PassThru

    return [ordered]@{
        name = $Name
        pid = $process.Id
        script = $Script
        args = $ScriptArgs
        stdout = $StdOut
        stderr = $StdErr
    }
}

if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = "rokid-stack-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice\$SessionId"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$script:PowerShellExe = Resolve-PowerShellExe
$readyFile = Join-Path $OutputDir ("tts-ready-" + [guid]::NewGuid().ToString("N") + ".json")

$ttsArgs = New-Object 'System.Collections.Generic.List[string]'
$ttsArgs.Add("-Port")
$ttsArgs.Add([string]$TtsPort)
$ttsArgs.Add("-ReadyFile")
$ttsArgs.Add($readyFile)
Add-OptionalArg -ArgList $ttsArgs -Name "-Serial" -Value $Serial
Add-OptionalArg -ArgList $ttsArgs -Name "-AdbPath" -Value $AdbPath
Add-OptionalArg -ArgList $ttsArgs -Name "-TtsCommand" -Value $TtsCommand
if ($DryRun) {
    $ttsArgs.Add("-DryRun")
}

$webhookArgs = New-Object 'System.Collections.Generic.List[string]'
Add-OptionalArg -ArgList $webhookArgs -Name "-Serial" -Value $Serial
Add-OptionalArg -ArgList $webhookArgs -Name "-AdbPath" -Value $AdbPath
Add-OptionalArg -ArgList $webhookArgs -Name "-WebhookUrl" -Value $WebhookUrl
Add-OptionalArg -ArgList $webhookArgs -Name "-SessionId" -Value $SessionId
if (-not $NoClearBeforeWatch) {
    $webhookArgs.Add("-ClearBeforeWatch")
}
if (-not $NoDedupe) {
    $webhookArgs.Add("-Dedupe")
}
if ($DryRun) {
    $webhookArgs.Add("-DryRun")
}

$processes = @()
$processes += Start-BridgeProcess `
    -Name "rokid-native-tts-playback" `
    -Script $ttsScript `
    -ScriptArgs $ttsArgs.ToArray() `
    -StdOut (Join-Path $OutputDir "tts-playback.out.log") `
    -StdErr (Join-Path $OutputDir "tts-playback.err.log")

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $readyFile)) {
        if (-not (Get-Process -Id $processes[0].pid -ErrorAction SilentlyContinue)) { throw "TTS 播放服务启动失败，请检查日志。" }
        if ([DateTime]::UtcNow -ge $deadline) { throw "等待 TTS 播放服务就绪超时。" }
        Start-Sleep -Milliseconds 100
    }
    $ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
    if ($ready.pid -ne $processes[0].pid -or $ready.port -lt 1 -or $ready.port -gt 65535 -or
        $ready.playbackUrl -cne "http://127.0.0.1:$($ready.port)/api/fennenote/playback") {
        throw "TTS 播放服务就绪信息无效。"
    }
    $TtsPort = [int]$ready.port
} catch {
    Stop-Process -Id $processes[0].pid -ErrorAction SilentlyContinue
    throw
} finally {
    Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
}

try {
    $processes += Start-BridgeProcess `
        -Name "rokid-native-asr-webhook" `
        -Script $webhookBridgeScript `
        -ScriptArgs $webhookArgs.ToArray() `
        -StdOut (Join-Path $OutputDir "asr-webhook.out.log") `
        -StdErr (Join-Path $OutputDir "asr-webhook.err.log")
} catch {
    Stop-Process -Id $processes[0].pid -ErrorAction SilentlyContinue
    throw
}

$manifest = [ordered]@{
    sessionId = $SessionId
    startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    projectRoot = (Resolve-Path -LiteralPath $projectRoot).Path
    outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    powershell = $script:PowerShellExe
    serial = $Serial
    webhookUrl = $WebhookUrl
    ttsPlaybackUrl = "http://127.0.0.1:$TtsPort/api/fennenote/playback"
    ttsCommand = $TtsCommand
    dryRun = [bool]$DryRun
    processes = $processes
    rabirouteEnv = [ordered]@{
        FENNOTE_PLAYBACK_URL = "http://127.0.0.1:$TtsPort/api/fennenote/playback"
        RABIROUTE_WEBHOOK_URL = $WebhookUrl
    }
}

$manifestPath = Join-Path $OutputDir "rokid-native-voice-stack.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$result = [ordered]@{
    Started = $true
    SessionId = $SessionId
    Manifest = (Resolve-Path -LiteralPath $manifestPath).Path
    TtsPlaybackUrl = $manifest.ttsPlaybackUrl
    WebhookUrl = $WebhookUrl
    ProcessIds = ($processes | ForEach-Object { $_.pid }) -join ","
    RabiRouteEnv = "FENNOTE_PLAYBACK_URL=$($manifest.rabirouteEnv.FENNOTE_PLAYBACK_URL); RABIROUTE_WEBHOOK_URL=$WebhookUrl"
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 5))
