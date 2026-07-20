param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputFile = "",
    [switch]$Dump,
    [switch]$ClearBeforeWatch,
    [switch]$Dedupe,
    [switch]$IncludeRaw
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

function Resolve-AdbPath {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "指定的 adb 不存在：$ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $projectAdb = Join-Path $projectRoot "out\tools\android-sdk\platform-tools\adb.exe"
    if (Test-Path -LiteralPath $projectAdb) {
        return (Resolve-Path -LiteralPath $projectAdb).Path
    }

    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCommand) {
        return $adbCommand.Source
    }

    throw "没有找到 adb。请传入 -AdbPath，或保留项目内置 out\tools\android-sdk\platform-tools\adb.exe。"
}

function Invoke-Adb {
    param(
        [string]$Adb,
        [string]$DeviceSerial,
        [string[]]$AdbArgs
    )

    $prefix = @()
    if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
        $prefix = @("-s", $DeviceSerial)
    }

    $output = & $Adb @prefix @AdbArgs 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "adb 执行失败 ($exitCode): $Adb $($prefix -join ' ') $($AdbArgs -join ' ')`n$output"
    }
    return @($output)
}

function New-Event {
    param(
        [string]$Type,
        [string]$Text,
        [string]$Command,
        [string]$Kind,
        [string]$Channel,
        [string]$ClientId,
        [string]$Protocol,
        [string]$RawLine
    )

    $event = [ordered]@{
        type = $Type
        text = $Text
        command = $Command
        kind = $Kind
        channel = $Channel
        clientId = $ClientId
        protocol = $Protocol
        observedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    }
    if ($IncludeRaw) {
        $event.raw = $RawLine
    }
    return $event
}

function Convert-RabiProtocolEvent {
    param(
        [string]$Protocol,
        [string]$Channel,
        [string]$ClientId,
        [string]$RawLine
    )

    if ([string]::IsNullOrWhiteSpace($Protocol)) {
        return $null
    }

    if ($Protocol.StartsWith("RABI_GLASS_ANDROID_ASR_PARTIAL:")) {
        return New-Event -Type "asr_partial" -Text $Protocol.Substring("RABI_GLASS_ANDROID_ASR_PARTIAL:".Length).Trim() -Kind "glass_android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_GLASS_ANDROID_ASR:")) {
        return New-Event -Type "asr_text" -Text $Protocol.Substring("RABI_GLASS_ANDROID_ASR:".Length).Trim() -Kind "glass_android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_GLASS_ANDROID_TTS_OK:")) {
        return New-Event -Type "tts_ack" -Text $Protocol.Substring("RABI_GLASS_ANDROID_TTS_OK:".Length).Trim() -Kind "glass_android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_GLASS_ANDROID_ERR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_GLASS_ANDROID_ERR:".Length).Trim() -Kind "glass_android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ANDROID_ASR:")) {
        return New-Event -Type "asr_text" -Text $Protocol.Substring("RABI_ANDROID_ASR:".Length).Trim() -Kind "android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ANDROID_TTS_OK:")) {
        return New-Event -Type "tts_ack" -Text $Protocol.Substring("RABI_ANDROID_TTS_OK:".Length).Trim() -Kind "android_system" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ROKID_AI_ASR_PARTIAL:")) {
        return New-Event -Type "asr_partial" -Text $Protocol.Substring("RABI_ROKID_AI_ASR_PARTIAL:".Length).Trim() -Kind "rokid_ai_sdk" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ROKID_AI_ASR:")) {
        return New-Event -Type "asr_text" -Text $Protocol.Substring("RABI_ROKID_AI_ASR:".Length).Trim() -Kind "rokid_ai_sdk" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ROKID_AI_TTS_REQUEST:")) {
        return New-Event -Type "tts_request" -Text $Protocol.Substring("RABI_ROKID_AI_TTS_REQUEST:".Length).Trim() -Kind "rokid_ai_sdk" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ROKID_AI_ERROR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_ROKID_AI_ERROR:".Length).Trim() -Kind "rokid_ai_sdk" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR:")) {
        return New-Event -Type "asr_text" -Text $Protocol.Substring("RABI_ASR:".Length).Trim() -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR_ERR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_ASR_ERR:".Length).Trim() -Kind "asr" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_TTS_OK:")) {
        return New-Event -Type "tts_ack" -Text $Protocol.Substring("RABI_TTS_OK:".Length).Trim() -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_TTS_ERR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_TTS_ERR:".Length).Trim() -Kind "tts" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_PONG:")) {
        return New-Event -Type "command_ack" -Text $Protocol.Substring("RABI_PONG:".Length).Trim() -Command "ping" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR_START_OK:")) {
        return New-Event -Type "command_ack" -Text $Protocol.Substring("RABI_ASR_START_OK:".Length).Trim() -Command "asr_start" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR_START_ERR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_ASR_START_ERR:".Length).Trim() -Kind "asr_start" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR_STOP_OK:")) {
        return New-Event -Type "command_ack" -Text $Protocol.Substring("RABI_ASR_STOP_OK:".Length).Trim() -Command "asr_stop" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }
    if ($Protocol.StartsWith("RABI_ASR_STOP_ERR:")) {
        return New-Event -Type "native_voice_error" -Text $Protocol.Substring("RABI_ASR_STOP_ERR:".Length).Trim() -Kind "asr_stop" -Channel $Channel -ClientId $ClientId -Protocol $Protocol -RawLine $RawLine
    }

    return $null
}

function Convert-LogLineToEvent {
    param([string]$Line)

    if ($Line -match "ShellService:\s+log\s+-t\s+") {
        return $null
    }

    if ($Line -match "Phone SDK text channel=(?<channel>[^ ]+) clientId=(?<clientId>[^ ]+) msg=(?<protocol>RABI_[^\r\n]+)") {
        return Convert-RabiProtocolEvent -Protocol $Matches.protocol -Channel $Matches.channel -ClientId $Matches.clientId -RawLine $Line
    }
    if ($Line -match "(?<protocol>RABI_ANDROID_ASR:[^\r\n]+)") {
        return Convert-RabiProtocolEvent -Protocol $Matches.protocol.Trim() -RawLine $Line
    }
    if ($Line -match "(?<protocol>RABI_ANDROID_TTS_OK:[^\r\n]+)") {
        return Convert-RabiProtocolEvent -Protocol $Matches.protocol.Trim() -RawLine $Line
    }
    if ($Line -match "(?<protocol>RABI_ROKID_AI_[A-Z_]+:[^\r\n]+)") {
        return Convert-RabiProtocolEvent -Protocol $Matches.protocol.Trim() -RawLine $Line
    }
    if ($Line -match "Android 系统 ASR 文本：(?<text>.*)$") {
        return New-Event -Type "asr_text" -Text $Matches.text.Trim() -Kind "android_system" -Protocol ("RABI_ANDROID_ASR:" + $Matches.text.Trim()) -RawLine $Line
    }
    if ($Line -match "RokidAiSdk ASR final local=[^ ]+ text=(?<text>.*)$") {
        return New-Event -Type "asr_text" -Text $Matches.text.Trim() -Kind "rokid_ai_sdk" -Protocol ("RABI_ROKID_AI_ASR:" + $Matches.text.Trim()) -RawLine $Line
    }
    if ($Line -match "RokidAiSdk ASR partial local=[^ ]+ text=(?<text>.*)$") {
        return New-Event -Type "asr_partial" -Text $Matches.text.Trim() -Kind "rokid_ai_sdk" -Protocol ("RABI_ROKID_AI_ASR_PARTIAL:" + $Matches.text.Trim()) -RawLine $Line
    }
    if ($Line -match "Android 系统语音错误：(?<kind>[^/]+) / (?<text>.*)$") {
        return New-Event -Type "native_voice_error" -Text $Matches.text.Trim() -Kind ("android_system_" + $Matches.kind.Trim()) -RawLine $Line
    }
    if ($Line -match "收到眼镜端原生 ASR 文本：(?<text>.*)$") {
        return New-Event -Type "asr_text" -Text $Matches.text.Trim() -Protocol ("RABI_ASR:" + $Matches.text.Trim()) -RawLine $Line
    }
    if ($Line -match "收到眼镜端 TTS ack：(?<text>.*)$") {
        return New-Event -Type "tts_ack" -Text $Matches.text.Trim() -Protocol ("RABI_TTS_OK:" + $Matches.text.Trim()) -RawLine $Line
    }
    if ($Line -match "收到眼镜端命令 ack：(?<command>[^/]+) / (?<text>.*)$") {
        return New-Event -Type "command_ack" -Text $Matches.text.Trim() -Command $Matches.command.Trim() -RawLine $Line
    }
    if ($Line -match "收到眼镜端原生语音错误：(?<kind>[^/]+) / (?<text>.*)$") {
        return New-Event -Type "native_voice_error" -Text $Matches.text.Trim() -Kind $Matches.kind.Trim() -RawLine $Line
    }
    if ($Line -match "眼镜原生语音回包超时：(?<kind>.*)$") {
        return New-Event -Type "native_voice_timeout" -Text "timeout" -Kind $Matches.kind.Trim() -RawLine $Line
    }

    return $null
}

function Write-EventJson {
    param([hashtable]$Seen, [object]$Event)

    if ($null -eq $Event) {
        return
    }

    $key = "$($Event.type)|$($Event.command)|$($Event.kind)|$($Event.text)|$($Event.protocol)"
    if ($Dedupe -and $Seen.ContainsKey($key)) {
        return
    }
    $Seen[$key] = $true

    $json = $Event | ConvertTo-Json -Depth 5 -Compress
    Write-Output $json
    if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
        Add-Content -LiteralPath $OutputFile -Value $json -Encoding UTF8
    }
}

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
    $parent = Split-Path -Parent $OutputFile
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
}

if ($ClearBeforeWatch) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-c") | Out-Null
}

$prefix = @()
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $prefix = @("-s", $Serial)
}
$modeArgs = if ($Dump) { @("logcat", "-d", "-v", "time") } else { @("logcat", "-v", "time") }
$seen = @{}

& $adb @prefix @modeArgs 2>&1 | ForEach-Object {
    $event = Convert-LogLineToEvent -Line ([string]$_)
    Write-EventJson -Seen $seen -Event $event
}
