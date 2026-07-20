param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [switch]$Build,
    [switch]$Install,
    [string[]]$Commands = @("ping", "tts", "asr_start", "asr_stop"),
    [string]$TtsText = "Rabi 原生 TTS 真机测试",
    [int]$AsrListenSeconds = 12,
    [int]$WaitAfterCommandSeconds = 8,
    [switch]$AllowNoAsrText,
    [switch]$KeepLogcat,
    [switch]$NoForceStop
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$packageName = "com.rabi.link"
$activityName = "com.rabi.link/.modules.rokid.RokidProbeActivity"

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

function Invoke-NativeCommand {
    param(
        [string]$Adb,
        [string]$DeviceSerial,
        [string]$Command,
        [string]$Text
    )

    $args = @(
        "shell", "am", "start",
        "-n", $activityName,
        "--es", "native_voice_command", $Command
    )
    if (-not [string]::IsNullOrWhiteSpace($Text)) {
        $encodedText = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
        $args += @("--es", "native_voice_text_b64", $encodedText)
    }

    Invoke-Adb -Adb $Adb -DeviceSerial $DeviceSerial -AdbArgs $args | Out-Null
}

function Wait-AfterCommand {
    param(
        [string]$Command,
        [int]$WaitSeconds,
        [int]$AsrSeconds
    )

    if ($Command -eq "asr_start" -or $Command -eq "start_asr" -or $Command -eq "echo_start" -or $Command -eq "start_echo" -or $Command -eq "phone_asr_start" -or $Command -eq "start_phone_asr" -or $Command -eq "android_asr_start" -or $Command -eq "start_android_asr" -or $Command -eq "android_asr_intent" -or $Command -eq "start_android_asr_intent" -or $Command -eq "android_recognizer_intent" -or $Command -eq "android_asr_tts_loop" -or $Command -eq "android_loopback" -or $Command -eq "android_voice_loopback") {
        Write-Host "请现在对 Rokid 眼镜说话，等待 $AsrSeconds 秒收集真实 ASR 回包..."
        Start-Sleep -Seconds $AsrSeconds
    } elseif ($Command -eq "phone_bt_scan" -or $Command -eq "scan_phone_bt" -or $Command -eq "probe_phone_bt_scan") {
        Start-Sleep -Seconds ([Math]::Max($WaitSeconds, 10))
    } elseif ($Command -eq "phone_bt_connect" -or $Command -eq "connect_phone_bt" -or $Command -eq "connect_phone_bt_bonded") {
        Start-Sleep -Seconds ([Math]::Max($WaitSeconds, 8))
    } else {
        Start-Sleep -Seconds $WaitSeconds
    }
}

function Get-LastRegexGroup {
    param(
        [string]$Text,
        [string]$Pattern,
        [int]$GroupIndex = 1
    )

    $matches = [regex]::Matches($Text, $Pattern)
    if ($matches.Count -eq 0) {
        return ""
    }
    return $matches[$matches.Count - 1].Groups[$GroupIndex].Value.Trim()
}

function Get-RegexGroups {
    param(
        [string]$Text,
        [string]$Pattern,
        [int]$GroupIndex = 1
    )

    $matches = [regex]::Matches($Text, $Pattern)
    $values = @()
    foreach ($match in $matches) {
        $value = $match.Groups[$GroupIndex].Value.Trim()
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $values += $value
        }
    }
    return @($values)
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ($Build) {
    $localJdk = Join-Path $projectRoot "out\tools\jdk-17.0.15+6"
    if (Test-Path -LiteralPath $localJdk) {
        $env:JAVA_HOME = $localJdk
        $env:Path = (Join-Path $localJdk "bin") + [System.IO.Path]::PathSeparator + $env:Path
    }
    $localAndroidSdk = Join-Path $projectRoot "out\tools\android-sdk"
    if (Test-Path -LiteralPath $localAndroidSdk) {
        $env:ANDROID_HOME = $localAndroidSdk
        $env:ANDROID_SDK_ROOT = $localAndroidSdk
    }

    $gradleBat = Join-Path $projectRoot "out\tools\gradle-8.6\bin\gradle.bat"
    if (-not (Test-Path -LiteralPath $gradleBat)) {
        throw "没有找到项目内 Gradle 8.6：$gradleBat。当前 APK 需要 AGP 8.4.2 / Gradle 8.6 才能打包 phone.sdk.rfmlite。"
    }

    Push-Location $projectRoot
    try {
        & $gradleBat "assembleDebug"
        if ($LASTEXITCODE -ne 0) {
            throw "Gradle 构建失败。"
        }
    } finally {
        Pop-Location
    }
}

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$apkPath = Join-Path $projectRoot "app\build\outputs\apk\debug\app-debug.apk"
if ($Install) {
    if (-not (Test-Path -LiteralPath $apkPath)) {
        throw "APK 不存在：$apkPath；请先构建或加 -Build。"
    }
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("install", "-r", $apkPath) | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rawLogPath = Join-Path $OutputDir "rokid-native-voice-real-raw-$timestamp.txt"
$filteredLogPath = Join-Path $OutputDir "rokid-native-voice-real-filtered-$timestamp.txt"
$summaryPath = Join-Path $OutputDir "rokid-native-voice-real-summary-$timestamp.json"

if (-not $KeepLogcat) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-c") | Out-Null
}
if (-not $NoForceStop) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "force-stop", $packageName) | Out-Null
}
Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "start", "-n", $activityName) | Out-Null
Start-Sleep -Seconds 2

$sentCommands = @()
foreach ($command in $Commands) {
    if ([string]::IsNullOrWhiteSpace($command)) {
        continue
    }
    $normalized = $command.Trim().ToLowerInvariant()
    if ($normalized -notin @("ping", "status", "diag", "native_diag", "glass_diag", "tts", "asr_start", "start_asr", "asr_stop", "stop_asr", "echo_start", "start_echo", "phone_bt_scan", "scan_phone_bt", "probe_phone_bt_scan", "phone_bt_connect", "connect_phone_bt", "connect_phone_bt_bonded", "phone_bt_auth", "phone_bt_probe", "probe_phone_bt_auth", "phone_device_handshake", "phone_audio_handshake", "probe_phone_device_handshake", "phone_device_info", "phone_glass_device", "probe_phone_device_info", "phone_auth_probe", "phone_auth", "probe_phone_auth", "phone_auth_apply", "apply_phone_auth", "phone_init", "init_phone", "phone_tts", "phone_asr_start", "start_phone_asr", "phone_asr_stop", "stop_phone_asr", "android_voice_probe", "android_system_voice", "android_voice_info", "android_asr_start", "start_android_asr", "android_asr_intent", "start_android_asr_intent", "android_recognizer_intent", "android_asr_stop", "stop_android_asr", "android_tts", "android_system_tts", "android_asr_tts_loop", "android_loopback", "android_voice_loopback")) {
        throw "未知命令：$command；支持 ping, status, diag, tts, asr_start, asr_stop, echo_start, phone_bt_scan, phone_bt_connect, phone_bt_auth, phone_device_handshake, phone_device_info, phone_auth_probe, phone_auth_apply, phone_init, phone_tts, phone_asr_start, phone_asr_stop, android_voice_probe, android_asr_start, android_asr_intent, android_asr_stop, android_tts, android_asr_tts_loop。"
    }

    Write-Host "发送真实 native_voice_command=$normalized"
    $text = if ($normalized -eq "tts" -or $normalized -eq "phone_tts" -or $normalized -eq "android_tts" -or $normalized -eq "android_system_tts" -or $normalized -eq "android_asr_tts_loop" -or $normalized -eq "android_loopback" -or $normalized -eq "android_voice_loopback") { $TtsText } else { "" }
    Invoke-NativeCommand -Adb $adb -DeviceSerial $Serial -Command $normalized -Text $text
    $sentCommands += [ordered]@{
        command = $normalized
        text = $text
        sentAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    }
    Wait-AfterCommand -Command $normalized -WaitSeconds $WaitAfterCommandSeconds -AsrSeconds $AsrListenSeconds
}

Start-Sleep -Seconds 1
$rawLog = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time")
$rawLog | Set-Content -LiteralPath $rawLogPath -Encoding UTF8

$filtered = @($rawLog | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|ProbeResult|native voice|原生|RABI_|Phone SDK|手机侧 Rokid|Android system|Android 系统|WebSocket|GlassAsrProbe|AndroidRuntime|FATAL EXCEPTION"
})
$filtered | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8

$joined = ($filtered -join "`n")
$sent = ($sentCommands | ForEach-Object { $_.command })
$androidSystemAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "RABI_ANDROID_ASR:([^\r\n]+)"
if ([string]::IsNullOrWhiteSpace($androidSystemAsrFinalText)) {
    $androidSystemAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "Android system ASR final=([^\r\n]+)"
}
$androidSystemTtsDoneText = Get-LastRegexGroup -Text $joined -Pattern "RABI_ANDROID_TTS_OK:([^\r\n]+)"
if ([string]::IsNullOrWhiteSpace($androidSystemTtsDoneText)) {
    $androidSystemTtsDoneText = Get-LastRegexGroup -Text $joined -Pattern "Android 系统 TTS onDone text=([^\r\n]+)"
}
$androidSystemErrors = Get-RegexGroups -Text $joined -Pattern "Android 系统语音错误 kind=([^\r\n]+)"
$nativeVoiceErrors = Get-RegexGroups -Text $joined -Pattern "(RABI_[A-Z_]+_ERR:[^\r\n]+|眼镜端原生语音错误[^\r\n]+|眼镜原生语音回包超时[^\r\n]+)"
$checks = [ordered]@{
    packageLaunched = $joined -match "RokidProbeActivity"
    pingRequested = -not ($sent -contains "ping") -or ($joined -match "native voice command=ping" -or $joined -match "已向眼镜发送原生消息 Ping")
    realPong = -not ($sent -contains "ping") -or ($joined -match "RABI_PONG:" -or $joined -match "眼镜原生命令 ack kind=ping")
    statusRequested = -not ($sent -contains "status") -or ($joined -match "native voice command=status" -or $joined -match "RABI_STATUS")
    realStatusAck = -not ($sent -contains "status") -or ($joined -match "RABI_STATUS:" -or $joined -match "眼镜原生状态")
    diagRequested = -not (($sent -contains "diag") -or ($sent -contains "native_diag") -or ($sent -contains "glass_diag")) -or ($joined -match "native voice command=(diag|native_diag|glass_diag)" -or $joined -match "RABI_DIAG")
    realDiagAck = -not (($sent -contains "diag") -or ($sent -contains "native_diag") -or ($sent -contains "glass_diag")) -or ($joined -match "RABI_STATUS:" -or $joined -match "眼镜原生状态")
    ttsRequested = -not ($sent -contains "tts") -or ($joined -match "native voice command=tts" -or $joined -match "RABI_TTS:" -or $joined -match ([regex]::Escape($TtsText)))
    realTtsAck = -not ($sent -contains "tts") -or ($joined -match "RABI_TTS_OK:" -or $joined -match "眼镜原生 TTS ack")
    asrStartRequested = -not (($sent -contains "asr_start") -or ($sent -contains "start_asr")) -or ($joined -match "RABI_ASR_START" -or $joined -match "远程开始 ASR")
    realAsrStartAck = -not (($sent -contains "asr_start") -or ($sent -contains "start_asr")) -or ($joined -match "RABI_ASR_START_OK:" -or $joined -match "眼镜原生命令 ack kind=asr_start")
    asrTextReceived = $AllowNoAsrText -or -not (($sent -contains "asr_start") -or ($sent -contains "start_asr") -or ($sent -contains "echo_start") -or ($sent -contains "start_echo")) -or ($joined -match "RABI_ASR:[^\r\n]+" -or $joined -match "收到眼镜端原生 ASR 文本：\S")
    asrStopRequested = -not (($sent -contains "asr_stop") -or ($sent -contains "stop_asr")) -or ($joined -match "RABI_ASR_STOP" -or $joined -match "远程停止 ASR")
    realAsrStopAck = -not (($sent -contains "asr_stop") -or ($sent -contains "stop_asr")) -or ($joined -match "RABI_ASR_STOP_OK:" -or $joined -match "眼镜原生命令 ack kind=asr_stop")
    phoneVoiceInitRequested = -not (($sent -contains "phone_init") -or ($sent -contains "init_phone")) -or ($joined -match "Phone SDK ASR/TTS probe init requested")
    phoneBtScanSeen = -not (($sent -contains "phone_bt_scan") -or ($sent -contains "scan_phone_bt") -or ($sent -contains "probe_phone_bt_scan")) -or ($joined -match "Phone SDK BT scan requested|Phone SDK BT scan found|Phone SDK BT scan finished|Phone SDK BT scan timeout stop requested|Phone SDK BT scan request failed")
    phoneBtConnectSeen = -not (($sent -contains "phone_bt_connect") -or ($sent -contains "connect_phone_bt") -or ($sent -contains "connect_phone_bt_bonded")) -or ($joined -match "Phone SDK BT bonded candidates|Phone SDK BT connect requested|Phone SDK BT connect callback|Phone SDK BT connect request failed|Phone SDK BT connect skipped")
    phoneBtAuthProbeSeen = -not (($sent -contains "phone_bt_auth") -or ($sent -contains "phone_bt_probe") -or ($sent -contains "probe_phone_bt_auth")) -or ($joined -match "Phone SDK BT/Auth probe")
    phoneDeviceHandshakeRequested = -not (($sent -contains "phone_device_handshake") -or ($sent -contains "phone_audio_handshake") -or ($sent -contains "probe_phone_device_handshake")) -or ($joined -match "Phone SDK device audio handshake requested|Phone SDK device audio handshake callback|Phone SDK device audio handshake timeout|Phone SDK device audio handshake request failed")
    phoneGlassDeviceInfoProbeSeen = -not (($sent -contains "phone_device_info") -or ($sent -contains "phone_glass_device") -or ($sent -contains "probe_phone_device_info")) -or ($joined -match "Phone SDK glass device info probe")
    phoneVoiceAuthProbeSeen = -not (($sent -contains "phone_auth_probe") -or ($sent -contains "phone_auth") -or ($sent -contains "probe_phone_auth")) -or ($joined -match "Phone SDK voice auth probe")
    phoneVoiceAuthApplySeen = -not (($sent -contains "phone_auth_apply") -or ($sent -contains "apply_phone_auth")) -or ($joined -match "Phone SDK voice auth apply result|Phone SDK voice auth apply skipped|Phone SDK voice auth token generation failed|Phone SDK voice auth header apply failed")
    phoneTtsRequested = -not ($sent -contains "phone_tts") -or ($joined -match "Phone SDK TTS request text=|Phone SDK ASR/TTS probe not ready")
    phoneAsrStartRequested = -not (($sent -contains "phone_asr_start") -or ($sent -contains "start_phone_asr")) -or ($joined -match "Phone SDK ASR start requested")
    phoneAsrStopRequested = -not (($sent -contains "phone_asr_stop") -or ($sent -contains "stop_phone_asr")) -or ($joined -match "Phone SDK ASR stop requested")
    phoneVoiceTimeoutOrCallbackSeen = -not (($sent -contains "phone_tts") -or ($sent -contains "phone_asr_start") -or ($sent -contains "start_phone_asr")) -or ($joined -match "手机侧 Rokid 语音引擎超时|Phone SDK ASR/TTS probe not ready|Phone SDK ASR final=|Phone SDK TTS listener onFinish|Phone SDK ASR error|Phone SDK TTS error|WebSocket连接失败")
    androidSystemVoiceProbeSeen = -not (($sent -contains "android_voice_probe") -or ($sent -contains "android_system_voice") -or ($sent -contains "android_voice_info")) -or ($joined -match "Android system voice probe|Android 系统语音探测")
    androidSystemTtsRequested = -not (($sent -contains "android_tts") -or ($sent -contains "android_system_tts")) -or ($joined -match "Android system TTS speak requested|Android system TTS onDone|Android 系统 TTS 请求")
    androidSystemAsrStartRequested = -not (($sent -contains "android_asr_start") -or ($sent -contains "start_android_asr")) -or ($joined -match "Android system ASR startListening requested|Android 系统 ASR 启动请求")
    androidSystemAsrIntentRequested = -not (($sent -contains "android_asr_intent") -or ($sent -contains "start_android_asr_intent") -or ($sent -contains "android_recognizer_intent")) -or ($joined -match "Android 前台系统 ASR 已启动|Android 前台系统 ASR final=|Android 前台系统 ASR 未返回文本|Android 前台系统 ASR 启动失败")
    androidSystemAsrStopRequested = -not (($sent -contains "android_asr_stop") -or ($sent -contains "stop_android_asr")) -or ($joined -match "Android system ASR stopped|Android 系统 ASR 停止请求")
    androidSystemLoopbackRequested = -not (($sent -contains "android_asr_tts_loop") -or ($sent -contains "android_loopback") -or ($sent -contains "android_voice_loopback")) -or ($joined -match "Android 系统语音回环|Android system TTS speak requested")
    androidSystemAsrFinalTextSeen = -not [string]::IsNullOrWhiteSpace($androidSystemAsrFinalText) -or ($joined -match "Android system ASR partial=\S|Android 系统 ASR 文本|Android 前台系统 ASR final=\S")
    androidSystemAsrTextReceived = $AllowNoAsrText -or -not (($sent -contains "android_asr_start") -or ($sent -contains "start_android_asr") -or ($sent -contains "android_asr_intent") -or ($sent -contains "start_android_asr_intent") -or ($sent -contains "android_recognizer_intent") -or ($sent -contains "android_asr_tts_loop") -or ($sent -contains "android_loopback") -or ($sent -contains "android_voice_loopback")) -or (-not [string]::IsNullOrWhiteSpace($androidSystemAsrFinalText)) -or ($joined -match "Android system ASR partial=\S|Android 系统 ASR 文本|Android 前台系统 ASR final=\S")
    androidSystemErrorSeen = $joined -match "Android 系统语音错误|Android system ASR error code=|Android system TTS onError|Android 前台系统 ASR 未返回文本|Android 前台系统 ASR 启动失败"
    androidSystemFatalErrorSeen = ($joined -match "Android 系统语音错误|Android system ASR error code=|Android system TTS onError|Android 前台系统 ASR 未返回文本|Android 前台系统 ASR 启动失败") -and [string]::IsNullOrWhiteSpace($androidSystemAsrFinalText) -and -not ($joined -match "Android system ASR partial=\S|Android 系统 ASR 文本|Android 前台系统 ASR final=\S")
    nativeErrorSeen = $joined -match "RABI_[A-Z_]+_ERR:|眼镜端原生语音错误|眼镜原生语音回包超时|Phone SDK 消息桥未初始化|CXR CustomCmd 未发送|CustomApp 会话未就绪"
    noFatalException = -not ($joined -match "FATAL EXCEPTION|Process: com\.rabi\.link")
}

$requiredChecks = @(
    $checks.packageLaunched,
    $checks.pingRequested,
    $checks.realPong,
    $checks.statusRequested,
    $checks.realStatusAck,
    $checks.diagRequested,
    $checks.realDiagAck,
    $checks.ttsRequested,
    $checks.realTtsAck,
    $checks.asrStartRequested,
    $checks.realAsrStartAck,
    $checks.asrTextReceived,
    $checks.asrStopRequested,
    $checks.realAsrStopAck,
    $checks.phoneVoiceInitRequested,
    $checks.phoneBtScanSeen,
    $checks.phoneBtConnectSeen,
    $checks.phoneBtAuthProbeSeen,
    $checks.phoneDeviceHandshakeRequested,
    $checks.phoneGlassDeviceInfoProbeSeen,
    $checks.phoneVoiceAuthProbeSeen,
    $checks.phoneVoiceAuthApplySeen,
    $checks.phoneTtsRequested,
    $checks.phoneAsrStartRequested,
    $checks.phoneAsrStopRequested,
    $checks.phoneVoiceTimeoutOrCallbackSeen,
    $checks.androidSystemVoiceProbeSeen,
    $checks.androidSystemTtsRequested,
    $checks.androidSystemAsrStartRequested,
    $checks.androidSystemAsrIntentRequested,
    $checks.androidSystemAsrStopRequested,
    $checks.androidSystemLoopbackRequested,
    $checks.androidSystemAsrTextReceived,
    (-not $checks.androidSystemFatalErrorSeen),
    (-not $checks.nativeErrorSeen),
    $checks.noFatalException
)
$passed = -not ($requiredChecks -contains $false)
$summary = [ordered]@{
    passed = $passed
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    mode = "real-device-no-injection"
    completionNote = "passed=true 只表示所请求命令的手机侧发送/回包/错误证据满足脚本检查；phone_* 命令不等于原生 ASR/TTS 已闭环，仍需 ASR 文本或 TTS 音频/播报证据。"
    adb = $adb
    serial = $Serial
    packageName = $packageName
    activity = $activityName
    installed = [bool]$Install
    built = [bool]$Build
    allowNoAsrText = [bool]$AllowNoAsrText
    commands = $sentCommands
    results = [ordered]@{
        androidSystemAsrFinalText = $androidSystemAsrFinalText
        androidSystemTtsDoneText = $androidSystemTtsDoneText
        androidSystemAsrProtocolSeen = $joined -match "RABI_ANDROID_ASR:"
        androidSystemTtsProtocolSeen = $joined -match "RABI_ANDROID_TTS_OK:"
        androidSystemErrors = @($androidSystemErrors)
        nativeVoiceErrors = @($nativeVoiceErrors)
    }
    rawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
    filteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    checks = $checks
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

[pscustomobject]@{
    Passed = $passed
    Mode = "real-device-no-injection"
    Summary = (Resolve-Path -LiteralPath $summaryPath).Path
    FilteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    RawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
}
