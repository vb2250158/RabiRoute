param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        "ping", "status", "diag", "native_diag", "glass_diag", "tts", "asr_start", "start_asr", "asr_stop", "stop_asr", "echo_start", "start_echo",
        "offline_cmd_arm", "offline_arm", "arm_offline_cmd", "offline_cmd_clear", "offline_clear", "clear_offline_cmd",
        "glass_android_voice_probe", "glass_android_voice", "glass_system_voice",
        "glass_android_asr_start", "start_glass_android_asr", "glass_system_asr_start",
        "glass_android_asr_stop", "stop_glass_android_asr", "glass_system_asr_stop",
        "glass_android_tts", "glass_system_tts",
        "glass_rokid_ai_probe", "glass_ai_probe", "glass_rokid_ai_status",
        "glass_rokid_ai_save_config", "glass_ai_save_config", "glass_rokid_ai_config",
        "glass_rokid_ai_clear_config", "glass_ai_clear_config",
        "glass_rokid_ai_start", "start_glass_rokid_ai", "glass_ai_start",
        "glass_rokid_ai_stop", "stop_glass_rokid_ai", "glass_ai_stop",
        "glass_rokid_ai_tts", "glass_ai_tts",
        "phone_bt_scan", "scan_phone_bt", "probe_phone_bt_scan",
        "phone_device_link_probe", "phone_device_link", "probe_phone_device_link", "phone_official_link_probe",
        "phone_companion_associate", "phone_companion_pair", "associate_phone_companion", "phone_cdm_associate",
        "phone_bt_connect", "connect_phone_bt", "connect_phone_bt_bonded",
        "phone_bt_auth", "phone_bt_probe", "probe_phone_bt_auth",
        "phone_p2p_probe", "phone_p2p", "probe_phone_p2p",
        "phone_system_info_probe", "phone_system_info", "probe_phone_system_info", "phone_official_system_info",
        "phone_device_handshake", "phone_audio_handshake", "probe_phone_device_handshake",
        "phone_device_video_audio_handshake", "phone_video_audio_handshake", "phone_preview_handshake", "probe_phone_device_video_audio_handshake",
        "phone_device_info", "phone_glass_device", "probe_phone_device_info",
        "phone_auth_probe", "phone_auth", "probe_phone_auth", "phone_auth_apply", "apply_phone_auth",
        "phone_init", "init_phone", "phone_tts", "phone_asr_start", "start_phone_asr", "phone_asr_stop", "stop_phone_asr",
        "android_voice_probe", "android_system_voice", "android_voice_info",
        "android_voice_route_bluetooth", "android_route_bluetooth", "android_bt_route",
        "android_voice_clear_bluetooth", "android_clear_bluetooth", "android_bt_clear",
        "android_headset_voice_start", "android_bt_headset_voice", "android_headset_voice",
        "android_headset_voice_stop", "android_bt_headset_voice_stop",
        "android_asr_start", "start_android_asr",
        "android_asr_intent", "start_android_asr_intent", "android_recognizer_intent",
        "android_asr_stop", "stop_android_asr",
        "android_tts", "android_system_tts",
        "android_asr_tts_loop", "android_loopback", "android_voice_loopback",
        "rokid_ai_probe", "ai_probe", "rokid_ai_status", "rokid_ai_clear_config", "ai_clear_config",
        "rokid_ai_start", "ai_start", "rokid_ai_asr_start",
        "rokid_ai_stop", "ai_stop",
        "rokid_ai_tts", "ai_tts",
        "rokid_ai_pickup", "rokid_ai_pickup_on", "ai_pickup", "ai_pickup_on",
        "rokid_ai_pickup_off", "ai_pickup_off"
    )]
    [string]$Command,
    [string]$Text = "",
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [string]$RokidAiKey = "",
    [string]$RokidAiSecret = "",
    [string]$RokidAiDeviceTypeId = "",
    [string]$RokidAiDeviceId = "",
    [string]$RokidAiSeed = "",
    [string]$RokidAiWorkDir = "",
    [string]$RokidAiConfigFile = "",
    [int]$WaitSeconds = 3,
    [switch]$NoLaunch,
    [switch]$KeepLogcat
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

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$normalizedCommand = $Command.Trim().ToLowerInvariant()
$isCompanionAssociationCommand = $normalizedCommand -in @(
    "phone_companion_associate",
    "phone_companion_pair",
    "associate_phone_companion",
    "phone_cdm_associate"
)
$textToSend = $Text
if (($normalizedCommand -eq "tts" -or $normalizedCommand -eq "android_tts" -or $normalizedCommand -eq "android_system_tts" -or $normalizedCommand -eq "rokid_ai_tts" -or $normalizedCommand -eq "ai_tts" -or $normalizedCommand -eq "glass_rokid_ai_tts" -or $normalizedCommand -eq "glass_ai_tts") -and [string]::IsNullOrWhiteSpace($textToSend)) {
    $textToSend = "Rabi 原生 TTS 测试"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rawLogPath = Join-Path $OutputDir "rokid-native-command-raw-$timestamp.txt"
$filteredLogPath = Join-Path $OutputDir "rokid-native-command-filtered-$timestamp.txt"
$summaryPath = Join-Path $OutputDir "rokid-native-command-summary-$timestamp.json"

if (-not $KeepLogcat) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-c") | Out-Null
}

if (-not $NoLaunch) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "start", "-n", $activityName) | Out-Null
    Start-Sleep -Milliseconds 800
}

$args = @(
    "shell", "am", "start",
    "-n", $activityName,
    "--es", "native_voice_command", $normalizedCommand
)
if (-not [string]::IsNullOrWhiteSpace($textToSend)) {
    $encodedText = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($textToSend))
    $args += @("--es", "native_voice_text_b64", $encodedText)
}
if ($normalizedCommand -in @("glass_rokid_ai_save_config", "glass_ai_save_config", "glass_rokid_ai_config", "rokid_ai_save_config", "ai_save_config", "rokid_ai_config")) {
    $configExtras = @{
        "rokid_ai_key_b64" = $RokidAiKey
        "rokid_ai_secret_b64" = $RokidAiSecret
        "rokid_ai_device_type_id_b64" = $RokidAiDeviceTypeId
        "rokid_ai_device_id_b64" = $RokidAiDeviceId
        "rokid_ai_seed_b64" = $RokidAiSeed
    }
    foreach ($entry in $configExtras.GetEnumerator()) {
        if (-not [string]::IsNullOrWhiteSpace($entry.Value)) {
            $args += @("--es", $entry.Key, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($entry.Value)))
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($RokidAiWorkDir)) {
        $args += @("--es", "rokid_ai_work_dir", $RokidAiWorkDir)
    }
    if (-not [string]::IsNullOrWhiteSpace($RokidAiConfigFile)) {
        $args += @("--es", "rokid_ai_config_file", $RokidAiConfigFile)
    }
}

Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs $args | Out-Null
if ($WaitSeconds -gt 0) {
    Start-Sleep -Seconds $WaitSeconds
}

$rawLog = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time")
$rawLog | Set-Content -LiteralPath $rawLogPath -Encoding UTF8

$filtered = @($rawLog | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|ProbeResult|native voice|原生|RABI_|Phone SDK|Android system|Android 系统|GlassAsrProbe|RabiGlassAsr|offline voice|离线语音|AndroidRuntime|FATAL EXCEPTION"
})
$filtered | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8

$joined = ($filtered -join "`n")
$companionUiState = $null
if ($isCompanionAssociationCommand) {
    $activityDumpPath = Join-Path $OutputDir "rokid-companion-activity-$timestamp.txt"
    $uiDumpPath = Join-Path $OutputDir "rokid-companion-ui-$timestamp.xml"
    $activityDump = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "activity", "activities")
    $activityDump | Set-Content -LiteralPath $activityDumpPath -Encoding UTF8
    $activityText = ($activityDump -join "`n")
    $topActivity = Get-LastRegexGroup -Text $activityText -Pattern "(?:topResumedActivity|ResumedActivity|mResumedActivity):\s+ActivityRecord\{[^\r\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)" -GroupIndex 1

    $uiDumpOk = $false
    $uiText = ""
    try {
        Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "uiautomator", "dump", "/sdcard/rabi-companion-ui.xml") | Out-Null
        Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("pull", "/sdcard/rabi-companion-ui.xml", $uiDumpPath) | Out-Null
        if (Test-Path -LiteralPath $uiDumpPath) {
            $uiText = Get-Content -LiteralPath $uiDumpPath -Raw
            $uiDumpOk = $true
        }
    } catch {
        $uiText = $_.Exception.Message
    }

    $waitingForUserUnlock = [bool](
        $uiText -match "请用图案密码|指纹解锁|keyguard|lockPatternView|bouncer_message_area_title|com\.android\.systemui:id/keyguard"
    )
    $associationActivityVisible = [bool](
        $topActivity -match "com\.android\.companiondevicemanager/.+Association"
    )
    $associationPending = [bool](
        $joined -match "Phone SDK Companion association pending|Phone SDK Companion association device found"
    )
    $associationCreated = [bool](
        $joined -match "Phone SDK Companion association created|Phone SDK Companion association result resultCode=-1"
    )
    $associationFailed = [bool](
        $joined -match "Phone SDK Companion association error|Phone SDK Companion association failure|系统 Companion 关联异常|系统 Companion 关联失败"
    )

    $companionUiState = [ordered]@{
        associationPending = $associationPending
        associationCreated = $associationCreated
        associationFailed = $associationFailed
        associationActivityVisible = $associationActivityVisible
        waitingForUserUnlock = $waitingForUserUnlock
        topActivity = $topActivity
        activityDump = (Resolve-Path -LiteralPath $activityDumpPath).Path
        uiDumpOk = $uiDumpOk
        uiDump = if (Test-Path -LiteralPath $uiDumpPath) { (Resolve-Path -LiteralPath $uiDumpPath).Path } else { "" }
        nextAction = if ($associationCreated) {
            "已创建系统关联；查看自动回跑的 phone_device_link_probe / phone_bt_auth 日志。"
        } elseif ($associationActivityVisible -and $waitingForUserUnlock) {
            "手机已拉起系统关联页，但当前锁屏；先解锁手机，再确认系统关联。"
        } elseif ($associationActivityVisible -and $associationPending) {
            "手机正在显示系统关联页；请在手机上确认关联 Glasses 设备。"
        } elseif ($associationFailed) {
            "系统关联失败；查看 filteredLog 中的 Companion association error。"
        } else {
            "未确认系统关联页状态；查看 activityDump/uiDump。"
        }
    }
}
$androidSystemAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "RABI_ANDROID_ASR:([^\r\n]+)"
if ([string]::IsNullOrWhiteSpace($androidSystemAsrFinalText)) {
    $androidSystemAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "Android system ASR final=([^\r\n]+)"
}
$androidSystemTtsDoneText = Get-LastRegexGroup -Text $joined -Pattern "RABI_ANDROID_TTS_OK:([^\r\n]+)"
if ([string]::IsNullOrWhiteSpace($androidSystemTtsDoneText)) {
    $androidSystemTtsDoneText = Get-LastRegexGroup -Text $joined -Pattern "Android 系统 TTS onDone text=([^\r\n]+)"
}
$glassAndroidAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "RABI_GLASS_ANDROID_ASR:([^\r\n]+)"
$glassAndroidTtsDoneText = Get-LastRegexGroup -Text $joined -Pattern "RABI_GLASS_ANDROID_TTS_OK:([^\r\n]+)"
$glassAndroidErrors = Get-RegexGroups -Text $joined -Pattern "RABI_GLASS_ANDROID_ERR:([^\r\n]+)"
$rokidAiSdkAsrFinalText = Get-LastRegexGroup -Text $joined -Pattern "RABI_ROKID_AI_ASR:([^\r\n]+)"
$rokidAiSdkErrors = Get-RegexGroups -Text $joined -Pattern "RABI_ROKID_AI_ERROR:([^\r\n]+)"
$androidSystemErrors = Get-RegexGroups -Text $joined -Pattern "Android 系统语音错误 kind=([^\r\n]+)"
$isPhoneProbeCommand = $normalizedCommand -in @(
    "phone_device_info", "phone_glass_device", "probe_phone_device_info",
    "phone_bt_scan", "scan_phone_bt", "probe_phone_bt_scan",
    "phone_device_link_probe", "phone_device_link", "probe_phone_device_link", "phone_official_link_probe",
    "phone_companion_associate", "phone_companion_pair", "associate_phone_companion", "phone_cdm_associate",
    "phone_bt_connect", "connect_phone_bt", "connect_phone_bt_bonded",
    "phone_bt_auth", "phone_bt_probe", "probe_phone_bt_auth",
    "phone_p2p_probe", "phone_p2p", "probe_phone_p2p",
    "phone_system_info_probe", "phone_system_info", "probe_phone_system_info", "phone_official_system_info",
    "phone_device_handshake", "phone_audio_handshake", "probe_phone_device_handshake",
    "phone_device_video_audio_handshake", "phone_video_audio_handshake", "phone_preview_handshake", "probe_phone_device_video_audio_handshake",
    "phone_auth_probe", "phone_auth", "probe_phone_auth", "phone_auth_apply", "apply_phone_auth",
    "phone_init", "init_phone", "phone_tts", "phone_asr_start", "start_phone_asr", "phone_asr_stop", "stop_phone_asr",
    "android_voice_probe", "android_system_voice", "android_voice_info",
    "android_voice_route_bluetooth", "android_route_bluetooth", "android_bt_route",
    "android_voice_clear_bluetooth", "android_clear_bluetooth", "android_bt_clear",
    "android_headset_voice_start", "android_bt_headset_voice", "android_headset_voice",
    "android_headset_voice_stop", "android_bt_headset_voice_stop",
    "android_asr_start", "start_android_asr",
    "android_asr_intent", "start_android_asr_intent", "android_recognizer_intent",
    "android_asr_stop", "stop_android_asr",
    "android_tts", "android_system_tts",
    "android_asr_tts_loop", "android_loopback", "android_voice_loopback",
    "glass_rokid_ai_probe", "glass_ai_probe", "glass_rokid_ai_status",
    "glass_rokid_ai_save_config", "glass_ai_save_config", "glass_rokid_ai_config",
    "glass_rokid_ai_clear_config", "glass_ai_clear_config",
    "glass_rokid_ai_start", "start_glass_rokid_ai", "glass_ai_start",
    "glass_rokid_ai_stop", "stop_glass_rokid_ai", "glass_ai_stop",
    "glass_rokid_ai_tts", "glass_ai_tts",
    "rokid_ai_probe", "ai_probe", "rokid_ai_status", "rokid_ai_clear_config", "ai_clear_config",
    "rokid_ai_start", "ai_start", "rokid_ai_asr_start",
    "rokid_ai_stop", "ai_stop",
    "rokid_ai_tts", "ai_tts",
    "rokid_ai_pickup", "rokid_ai_pickup_on", "ai_pickup", "ai_pickup_on",
    "rokid_ai_pickup_off", "ai_pickup_off"
)
$checks = [ordered]@{
    commandAccepted = $joined -match ("native voice command=" + [regex]::Escape($normalizedCommand))
    customCmdSkipped = $joined -match "CXR CustomCmd 未发送|CustomApp 会话未就绪"
    sentToPhoneSdk = $isPhoneProbeCommand -or (($joined -match "Phone SDK send native|CXR CustomCmd send payload=|ASR 回声测试") -and -not ($joined -match "CXR CustomCmd 未发送|CustomApp 会话未就绪"))
    responseSeen = $joined -match "RABI_PONG:|RABI_STATUS:|RABI_ASR:|RABI_ASR_START_OK:|RABI_ASR_STOP_OK:|RABI_TTS_OK:|RABI_OFFLINE_CMD_STATUS:|RABI_OFFLINE_CMD:|RABI_GLASS_ANDROID_|RABI_ROKID_AI_|眼镜原生命令 ack|眼镜原生状态|眼镜原生 TTS ack|收到眼镜端原生 ASR 文本|offline voice commands armed|offline voice triggered|离线语音|Phone SDK BT scan requested|Phone SDK BT scan found|Phone SDK BT scan finished|Phone SDK BT scan timeout stop requested|Phone SDK device link|Phone SDK Companion association|Phone SDK Companion observing presence|Phone SDK BT bonded candidates|Phone SDK BT connect requested|Phone SDK BT connect callback|Phone SDK BT connect skipped|Phone SDK BT/Auth probe|Phone SDK P2P probe|Phone SDK P2P isConnect callback|Phone SDK P2P sendConnectP2pRequest callback|Phone SDK P2P peers available|Phone SDK P2P connection info|Phone SDK official system info requested|Phone SDK official system info response|Phone SDK official system info timeout|Phone SDK device audio handshake requested|Phone SDK device audio handshake callback|Phone SDK device audio handshake timeout|Phone SDK device video/audio handshake|Phone SDK glass device info probe|Phone SDK voice auth probe|Phone SDK voice auth apply result|Phone SDK voice auth apply skipped|Phone SDK ASR/TTS probe init requested|Phone SDK TTS request text=|Phone SDK ASR/TTS probe not ready|Phone SDK ASR start requested|Phone SDK ASR stop requested|Android system voice probe|Android 系统语音探测|Android system voice Bluetooth route|Android 系统语音蓝牙路由|Android Bluetooth HEADSET profile proxy requested|Android Bluetooth HEADSET voice recognition requested|Android BluetoothHeadset.startVoiceRecognition 请求|Android BluetoothHeadset.stopVoiceRecognition 请求|Android system TTS speak requested|Android system TTS onDone|Android 系统 TTS 请求|Android system ASR startListening requested|Android system ASR final=|Android system ASR partial=|Android 系统 ASR 文本|Android system ASR stopped|Android 前台系统 ASR 已启动|Android 前台系统 ASR final=|Android 系统语音回环|RokidAiSdk readiness|RokidAiSdk ASR|RokidAiSdk TTS requested|RokidAiSdk state="
    errorSeen = ($joined -match "RABI_[A-Z_]+_ERR:|RABI_ROKID_AI_ERROR:|眼镜端原生语音错误|眼镜原生语音回包超时|Phone SDK 消息桥未初始化|Phone SDK Companion association error|Phone SDK Companion association failure|系统 Companion 关联异常|系统 Companion 关联失败|CXR CustomCmd 未发送|CustomApp 会话未就绪|Android 系统语音错误|Android system ASR error code=|Android system TTS onError|Android 前台系统 ASR 未返回文本|Android 前台系统 ASR 启动失败|RokidAiSdk 错误|未知 native_voice_command") -and [string]::IsNullOrWhiteSpace($androidSystemAsrFinalText) -and [string]::IsNullOrWhiteSpace($glassAndroidAsrFinalText) -and [string]::IsNullOrWhiteSpace($rokidAiSdkAsrFinalText) -and -not ($joined -match "Android system ASR partial=\S|Android 系统 ASR 文本|Android 前台系统 ASR final=\S|RokidAiSdk ASR partial=\S|RABI_GLASS_ANDROID_ASR_PARTIAL:\S")
    noFatalException = -not ($joined -match "FATAL EXCEPTION|Process: com\.rabi\.link")
}
$accepted = $checks.commandAccepted -and $checks.sentToPhoneSdk -and $checks.noFatalException -and (-not $checks.errorSeen)
$status = "failed"
if ($accepted -and $checks.responseSeen) {
    $status = "acknowledged"
} elseif ($accepted) {
    $status = "requested"
}
if ($isCompanionAssociationCommand -and $null -ne $companionUiState) {
    if (($companionUiState["associationActivityVisible"] -and $companionUiState["waitingForUserUnlock"]) -or
        ($companionUiState["associationActivityVisible"] -and $companionUiState["associationPending"] -and -not $companionUiState["associationCreated"])) {
        $status = "waiting_user"
    } elseif ($companionUiState["associationFailed"]) {
        $status = "failed"
    }
}

$summary = [ordered]@{
    ok = $accepted
    acknowledged = [bool]$checks.responseSeen
    status = $status
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    mode = "single-native-command"
    adb = $adb
    serial = $Serial
    packageName = $packageName
    activity = $activityName
    command = $normalizedCommand
    text = $textToSend
    waitSeconds = $WaitSeconds
    results = [ordered]@{
        androidSystemAsrFinalText = $androidSystemAsrFinalText
        androidSystemTtsDoneText = $androidSystemTtsDoneText
        androidSystemAsrProtocolSeen = $joined -match "RABI_ANDROID_ASR:"
        androidSystemTtsProtocolSeen = $joined -match "RABI_ANDROID_TTS_OK:"
        androidSystemErrors = @($androidSystemErrors)
        glassAndroidAsrFinalText = $glassAndroidAsrFinalText
        glassAndroidTtsDoneText = $glassAndroidTtsDoneText
        glassAndroidAsrProtocolSeen = $joined -match "RABI_GLASS_ANDROID_ASR:"
        glassAndroidTtsProtocolSeen = $joined -match "RABI_GLASS_ANDROID_TTS_OK:"
        glassAndroidErrors = @($glassAndroidErrors)
        rokidAiSdkAsrFinalText = $rokidAiSdkAsrFinalText
        rokidAiSdkAsrProtocolSeen = $joined -match "RABI_ROKID_AI_ASR:"
        rokidAiSdkTtsRequestSeen = $joined -match "RABI_ROKID_AI_TTS_REQUEST:"
        rokidAiSdkErrors = @($rokidAiSdkErrors)
        companionUiState = $companionUiState
    }
    rawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
    filteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    checks = $checks
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 5
