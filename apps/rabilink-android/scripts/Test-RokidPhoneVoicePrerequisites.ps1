param(
    [string]$Serial = "",
    [string]$OutputDir = "",
    [int]$WaitSeconds = 8,
    [switch]$IncludeBtConnect
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$sendCommandScript = Join-Path $PSScriptRoot "Send-RokidNativeVoiceCommand.ps1"
if (-not (Test-Path -LiteralPath $sendCommandScript)) {
    throw "找不到命令脚本：$sendCommandScript"
}

function Invoke-PhonePrereqCommand {
    param(
        [string]$Command,
        [string]$DeviceSerial,
        [int]$Seconds
    )

    if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
        $output = & $sendCommandScript -Command $Command -WaitSeconds $Seconds -Serial $DeviceSerial 2>&1
    } else {
        $output = & $sendCommandScript -Command $Command -WaitSeconds $Seconds 2>&1
    }
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
    $json = $null
    try {
        $json = $text | ConvertFrom-Json
    } catch {
        $json = $null
    }

    return [pscustomobject][ordered]@{
        command = $Command
        exitCode = $exitCode
        parsed = $null -ne $json
        summary = $json
        rawOutput = $text
    }
}

function Get-LastMatchValue {
    param(
        [string]$Text,
        [string]$Pattern,
        [string]$GroupName
    )

    $matches = [regex]::Matches($Text, $Pattern)
    if ($matches.Count -eq 0) {
        return ""
    }
    $last = $matches[$matches.Count - 1]
    return $last.Groups[$GroupName].Value
}

function ConvertTo-BoolString {
    param([string]$Value)
    if ($Value -eq "true") { return $true }
    if ($Value -eq "false") { return $false }
    return $null
}

$commands = @("phone_device_info", "phone_auth_probe", "phone_p2p_probe", "phone_device_handshake", "phone_device_video_audio_handshake", "phone_device_info", "phone_auth_probe")
if ($IncludeBtConnect) {
    $commands = @("phone_device_link_probe", "phone_bt_connect", "phone_system_info_probe") + $commands
}

$runs = @()
foreach ($command in $commands) {
    $runs += Invoke-PhonePrereqCommand -Command $command -DeviceSerial $Serial -Seconds $WaitSeconds
}

$filteredLogs = @(
    $runs |
        ForEach-Object {
            if ($_.summary -and $_.summary.filteredLog) {
                $_.summary.filteredLog
            }
        } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) } |
        Sort-Object -Unique
)

$joinedLog = ""
if ($filteredLogs.Count -gt 0) {
    $joinedLog = ($filteredLogs | ForEach-Object { Get-Content -LiteralPath $_ -Raw }) -join "`n"
}

$deviceInfoLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK glass device info probe (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$authLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK voice auth probe (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$handshakeLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK device audio handshake (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$videoAudioHandshakeLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK device video/audio handshake finish (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$btConnectLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK BT connect callback (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$companionObserveLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK Companion observing presence (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$deviceLinkLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK device link (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$officialSystemInfoRequestLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK official system info requested (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$officialSystemInfoResponseLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK official system info response (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$p2pLine = Get-LastMatchValue `
    -Text $joinedLog `
    -Pattern "Phone SDK P2P probe (?<payload>[^\r\n]+)" `
    -GroupName "payload"

$deviceInfoPresent = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $deviceInfoLine -Pattern "present=(?<value>true|false)" -GroupName "value")
$deviceIdReady = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $deviceInfoLine -Pattern "deviceId=(?<value>true|false)" -GroupName "value")
$readyForAppToken = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $deviceInfoLine -Pattern "readyForAppToken=(?<value>true|false)" -GroupName "value")
$authConfigured = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $authLine -Pattern "configured=(?<value>true|false)" -GroupName "value")
$authReady = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $authLine -Pattern "ready=(?<value>true|false)" -GroupName "value")
$handshakeTimedOut = [bool]($joinedLog -match "Phone SDK device audio handshake timeout")
$videoAudioVideoSeen = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $videoAudioHandshakeLine -Pattern "video=(?<value>true|false)" -GroupName "value")
$videoAudioAudioSeen = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $videoAudioHandshakeLine -Pattern "audio=(?<value>true|false)" -GroupName "value")
$videoAudioTimedOut = [bool]($joinedLog -match "Phone SDK device video/audio handshake .*timeout")
$companionObserved = -not [string]::IsNullOrWhiteSpace($companionObserveLine)
$btConnected = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $btConnectLine -Pattern "success=(?<value>true|false)" -GroupName "value")
$officialSystemInfoRequested = -not [string]::IsNullOrWhiteSpace($officialSystemInfoRequestLine)
$officialSystemInfoResponded = -not [string]::IsNullOrWhiteSpace($officialSystemInfoResponseLine)
$officialSystemInfoTimedOut = [bool]($joinedLog -match "Phone SDK official system info timeout")
$p2pServicePresent = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $p2pLine -Pattern "service=(?<value>true|false)" -GroupName "value")
$p2pConnected = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $p2pLine -Pattern "connected=(?<value>true|false)" -GroupName "value")
$p2pReadyForDeviceMedia = ConvertTo-BoolString -Value (Get-LastMatchValue -Text $p2pLine -Pattern "readyForDeviceMedia=(?<value>true|false)" -GroupName "value")

$readyForPhoneVoice = [bool](
    $deviceInfoPresent -eq $true -and
    $deviceIdReady -eq $true -and
    $readyForAppToken -eq $true -and
    $authConfigured -eq $true -and
    $authReady -eq $true -and
    $p2pReadyForDeviceMedia -eq $true -and
    -not $handshakeTimedOut
)

$missing = @()
if ($deviceInfoPresent -ne $true) { $missing += "Phone SDK 未缓存 GlassDeviceInfo。" }
if ($deviceIdReady -ne $true) { $missing += "Phone SDK 未拿到眼镜 deviceId。" }
if ($readyForAppToken -ne $true) { $missing += "不能生成手机侧在线语音 app token。" }
if ($authConfigured -ne $true) { $missing += "本机未配置 Rokid 在线语音 AK/SK。" }
if ($authReady -ne $true) { $missing += "x-app-authorization / x-user-authorization 未就绪。" }
if ($handshakeTimedOut) { $missing += "Phone SDK device audio handshake 超时。" }
if ($videoAudioVideoSeen -ne $true) { $missing += "Phone SDK video/audio 握手未收到首个视频包。" }
if ($videoAudioAudioSeen -ne $true) { $missing += "Phone SDK video/audio 握手未收到首个音频包。" }
if ($p2pServicePresent -ne $true) { $missing += "Phone SDK P2P service 不可用。" }
if ($p2pConnected -ne $true) { $missing += "Phone SDK P2P 未连接。" }
if ($IncludeBtConnect -and $btConnected -ne $true) { $missing += "Phone SDK ClassicBT connect 未成功。" }
if ($IncludeBtConnect -and $officialSystemInfoResponded -ne $true) { $missing += "Phone SDK 官方系统信息消息未收到响应。" }

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-phone-voice-prereq-summary-$timestamp.json"

$summary = [pscustomobject][ordered]@{
    generatedAt = (Get-Date).ToString("o")
    serial = $Serial
    waitSeconds = $WaitSeconds
    includeBtConnect = [bool]$IncludeBtConnect
    readyForPhoneVoice = $readyForPhoneVoice
    missing = @($missing)
    parsed = [ordered]@{
        deviceInfoPresent = $deviceInfoPresent
        deviceIdReady = $deviceIdReady
        readyForAppToken = $readyForAppToken
        authConfigured = $authConfigured
        authReady = $authReady
        handshakeTimedOut = $handshakeTimedOut
        videoAudioVideoSeen = $videoAudioVideoSeen
        videoAudioAudioSeen = $videoAudioAudioSeen
        videoAudioTimedOut = $videoAudioTimedOut
        companionObserved = $companionObserved
        companionObserveLine = $companionObserveLine
        btConnected = $btConnected
        deviceLinkLine = $deviceLinkLine
        officialSystemInfoRequested = $officialSystemInfoRequested
        officialSystemInfoResponded = $officialSystemInfoResponded
        officialSystemInfoTimedOut = $officialSystemInfoTimedOut
        officialSystemInfoRequestLine = $officialSystemInfoRequestLine
        officialSystemInfoResponseLine = $officialSystemInfoResponseLine
        p2pServicePresent = $p2pServicePresent
        p2pConnected = $p2pConnected
        p2pReadyForDeviceMedia = $p2pReadyForDeviceMedia
        deviceInfoLine = $deviceInfoLine
        authLine = $authLine
        handshakeLine = $handshakeLine
        videoAudioHandshakeLine = $videoAudioHandshakeLine
        btConnectLine = $btConnectLine
        p2pLine = $p2pLine
    }
    commands = @($runs | ForEach-Object {
        [pscustomobject][ordered]@{
            command = $_.command
            exitCode = $_.exitCode
            parsed = $_.parsed
            status = if ($_.summary) { $_.summary.status } else { "" }
            filteredLog = if ($_.summary) { $_.summary.filteredLog } else { "" }
            rawLog = if ($_.summary) { $_.summary.rawLog } else { "" }
        }
    })
    filteredLogs = @($filteredLogs)
    note = "readyForPhoneVoice only means the Phone SDK online ASR/TTS prerequisites look ready. It does not prove ASR text or TTS playback until phone_asr_start/phone_tts returns real callbacks."
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$summary |
    Select-Object generatedAt, serial, readyForPhoneVoice, missing, @{Name="summaryPath";Expression={$summaryPath}} |
    Format-List

Write-Host "Summary: $summaryPath"
