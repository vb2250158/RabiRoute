param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [string]$ManifestPath = "",
    [int]$RecentLogLines = 1200
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
        [string[]]$AdbArgs,
        [switch]$AllowFailure
    )

    $prefix = @()
    if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
        $prefix = @("-s", $DeviceSerial)
    }

    $output = & $Adb @prefix @AdbArgs 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "adb 执行失败 ($exitCode): $Adb $($prefix -join ' ') $($AdbArgs -join ' ')`n$output"
    }
    return [ordered]@{
        exitCode = $exitCode
        output = @($output)
    }
}

function Find-LatestManifest {
    $stackRoot = Join-Path $projectRoot "out\rokid-native-voice"
    Get-ChildItem -LiteralPath $stackRoot -Filter "rokid-native-voice-stack.json" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Test-ManifestProcess {
    param([object]$ProcessEntry)

    $pidValue = [int]$ProcessEntry.pid
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    return [ordered]@{
        name = [string]$ProcessEntry.name
        pid = $pidValue
        running = [bool]$process
        processName = if ($process) { $process.ProcessName } else { "" }
        stdout = [string]$ProcessEntry.stdout
        stderr = [string]$ProcessEntry.stderr
    }
}

function Contains-Any {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }
    return $false
}

function Test-RuntimePermissionGranted {
    param(
        [object]$PermissionProbe,
        [string]$PackageDump,
        [string]$PermissionName
    )

    $probeText = ($PermissionProbe.output -join "`n").Trim()
    if ($probeText -match "(?m)^\s*granted\s*$|PERMISSION_GRANTED") {
        return $true
    }
    if ($probeText -match "(?m)^\s*denied\s*$|PERMISSION_DENIED") {
        return $false
    }

    $permissionPattern = [regex]::Escape($PermissionName)
    return $PackageDump -match "$permissionPattern\s*:\s*granted=true"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-native-readiness-summary-$timestamp.json"
$filteredLogPath = Join-Path $OutputDir "rokid-native-readiness-log-$timestamp.txt"

$devices = Invoke-Adb -Adb $adb -DeviceSerial "" -AdbArgs @("devices") -AllowFailure
$packageInfo = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "package", $packageName) -AllowFailure
$activityResolve = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "cmd", "package", "resolve-activity", "--brief", $packageName) -AllowFailure
$recordAudioPerm = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "pm", "check-permission", "android.permission.RECORD_AUDIO", $packageName) -AllowFailure
$cameraPerm = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "pm", "check-permission", "android.permission.CAMERA", $packageName) -AllowFailure
$bluetoothPerm = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "pm", "check-permission", "android.permission.BLUETOOTH_CONNECT", $packageName) -AllowFailure
$savedTokenProbe = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "run-as", $packageName, "cat", "shared_prefs/rokid_probe.xml") -AllowFailure
$rokidAiInfo = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "package", "com.rokid.sprite.aiapp") -AllowFailure

$log = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @(
    "logcat", "-d", "-v", "time", "-t", [string]$RecentLogLines,
    "RabiRokidProbe:*", "RokidProbeActivity:*", "AndroidRuntime:E", "*:S"
) -AllowFailure
$taggedLogText = ($log.output -join "`n")
if ($taggedLogText -notmatch "RabiRokidProbe|RokidProbeActivity|FATAL EXCEPTION") {
    $fallbackLines = [Math]::Max($RecentLogLines * 10, 20000)
    $log = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time", "-t", [string]$fallbackLines) -AllowFailure
}
$filtered = @($log.output | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|ProbeResult|native voice|原生|RABI_|Phone SDK|GlassAsrProbe|AndroidRuntime|FATAL EXCEPTION"
})
if ($filtered.Count -gt 0) {
    $filtered | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8
} else {
    "" | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8
}
$joined = ($filtered -join "`n")

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $latestManifest = Find-LatestManifest
    if ($latestManifest) {
        $ManifestPath = $latestManifest.FullName
    }
}

$manifest = $null
$bridgeProcesses = @()
if (-not [string]::IsNullOrWhiteSpace($ManifestPath) -and (Test-Path -LiteralPath $ManifestPath)) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $bridgeProcesses = @($manifest.processes | ForEach-Object { Test-ManifestProcess -ProcessEntry $_ })
}

$packageDumpText = ($packageInfo.output -join "`n")
$checks = [ordered]@{
    adbAvailable = (Test-Path -LiteralPath $adb)
    deviceListed = ($devices.output -join "`n") -match "device$"
    phoneApkInstalled = $packageDumpText -match ("Package \[" + [regex]::Escape($packageName) + "\]")
    activityResolvable = ($activityResolve.output -join "`n") -match "RokidProbeActivity|$packageName"
    recordAudioGranted = Test-RuntimePermissionGranted -PermissionProbe $recordAudioPerm -PackageDump $packageDumpText -PermissionName "android.permission.RECORD_AUDIO"
    cameraGranted = Test-RuntimePermissionGranted -PermissionProbe $cameraPerm -PackageDump $packageDumpText -PermissionName "android.permission.CAMERA"
    bluetoothConnectGranted = Test-RuntimePermissionGranted -PermissionProbe $bluetoothPerm -PackageDump $packageDumpText -PermissionName "android.permission.BLUETOOTH_CONNECT"
    rokidTokenSaved = ($savedTokenProbe.output -join "`n") -match 'name="rokid_token">[^<]+'
    rokidAiAppInstalled = ($rokidAiInfo.output -join "`n") -match "Package \[com\.rokid\.sprite\.aiapp\]"
    phoneSdkInitialized = $joined -match "Phone SDK init result=true"
    messageListenerRegistered = $joined -match "Phone SDK message listener registered"
    outboundCommandSeen = $joined -match "Phone SDK send native|已向眼镜发送"
    realPongSeen = $joined -match "RABI_PONG:|眼镜原生命令 ack kind=ping"
    realAsrTextSeen = $joined -match "RABI_ASR:[^\r\n]+|收到眼镜端原生 ASR 文本：\S"
    realTtsAckSeen = $joined -match "RABI_TTS_OK:|眼镜原生 TTS ack"
    nativeErrorSeen = Contains-Any -Text $joined -Patterns @("RABI_[A-Z_]+_ERR:", "眼镜端原生语音错误", "眼镜原生语音回包超时", "Phone SDK 消息桥未初始化")
    noFatalException = -not ($joined -match "FATAL EXCEPTION|Process: com\.rabi\.link")
    bridgeManifestFound = [bool]$manifest
    bridgeProcessesRunning = $bridgeProcesses.Count -gt 0 -and -not (($bridgeProcesses | Where-Object { -not $_.running }).Count -gt 0)
}

$summary = [ordered]@{
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    adb = $adb
    serial = $Serial
    packageName = $packageName
    activity = $activityName
    manifestPath = $ManifestPath
    filteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    checks = $checks
    bridgeProcesses = $bridgeProcesses
    nextActions = @(
        if (-not $checks.deviceListed) { "连接手机 ADB，或传入正确 -Serial。" }
        if (-not $checks.phoneApkInstalled) { "安装 app-debug.apk 到手机。" }
        if (-not $checks.recordAudioGranted -or -not $checks.cameraGranted -or -not $checks.bluetoothConnectGranted) { "在手机 APK 中点击 Android 权限并授予权限。" }
        if (-not $checks.rokidAiAppInstalled) { "安装/登录 Rokid AI App。" }
        if (-not $checks.rokidTokenSaved) { "在手机 APK 中执行 Rokid 授权；新版会保存 token，后续 ADB 可复用。" }
        if (-not $checks.bridgeProcessesRunning) { "运行 Start-RokidNativeVoiceStack.ps1 启动 ASR/TTS 本地桥。" }
        if (-not $checks.realPongSeen) { "在手机 APK 内完成 CustomApp 会话、安装/启动眼镜 APK，然后发送 ping。" }
        if (-not $checks.realAsrTextSeen) { "发送 asr_start 并对眼镜说话，等待 RABI_ASR:<text>。" }
        if (-not $checks.realTtsAckSeen) { "发送 tts 测试并确认眼镜播报，等待 RABI_TTS_OK:<text>。" }
    )
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

[pscustomobject]@{
    Summary = (Resolve-Path -LiteralPath $summaryPath).Path
    DeviceListed = $checks.deviceListed
    PhoneApkInstalled = $checks.phoneApkInstalled
    RokidAiAppInstalled = $checks.rokidAiAppInstalled
    BridgeProcessesRunning = $checks.bridgeProcessesRunning
    RealPongSeen = $checks.realPongSeen
    RealAsrTextSeen = $checks.realAsrTextSeen
    RealTtsAckSeen = $checks.realTtsAckSeen
    NoFatalException = $checks.noFatalException
}
