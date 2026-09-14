param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [switch]$Build,
    [switch]$Install,
    [switch]$SkipFailureCases,
    [switch]$SkipTimeoutCase
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

function Invoke-Injection {
    param(
        [string]$Adb,
        [string]$DeviceSerial,
        [string]$Mode,
        [string]$Text,
        [string]$ClientId
    )

    Invoke-Adb -Adb $Adb -DeviceSerial $DeviceSerial -AdbArgs @(
        "shell", "am", "start",
        "-n", $activityName,
        "--es", "native_voice_mode", $Mode,
        "--es", "native_voice_text", $Text,
        "--es", "native_voice_channel", "adb-self-test",
        "--es", "native_voice_client_id", $ClientId
    ) | Out-Null
}

function Invoke-NativeCommand {
    param(
        [string]$Adb,
        [string]$DeviceSerial,
        [string]$Command,
        [string]$Text
    )

    Invoke-Adb -Adb $Adb -DeviceSerial $DeviceSerial -AdbArgs @(
        "shell", "am", "start",
        "-n", $activityName,
        "--es", "native_voice_command", $Command,
        "--es", "native_voice_text", $Text
    ) | Out-Null
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
$rawLogPath = Join-Path $OutputDir "rokid-native-voice-raw-$timestamp.txt"
$filteredLogPath = Join-Path $OutputDir "rokid-native-voice-filtered-$timestamp.txt"
$summaryPath = Join-Path $OutputDir "rokid-native-voice-summary-$timestamp.json"

Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-c") | Out-Null
Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "force-stop", $packageName) | Out-Null
Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "start", "-n", $activityName) | Out-Null
Start-Sleep -Seconds 2

$cases = @(
    @{ mode = "app_started"; text = "APP_STARTED_SELF_TEST"; client = "self-app" },
    @{ mode = "ping"; text = "PONG_SELF_TEST"; client = "self-ping" },
    @{ mode = "asr_start"; text = "started"; client = "self-asr-start" },
    @{ mode = "echo_on"; text = "ECHO_ON_SELF_TEST"; client = "self-echo-on" },
    @{ mode = "asr"; text = "ASR_SELF_TEST_TEXT"; client = "self-asr" },
    @{ mode = "tts_ack"; text = "TTS_SELF_TEST_TEXT"; client = "self-tts" }
)

if (-not $SkipFailureCases) {
    $cases += @(
        @{ mode = "asr_start_error"; text = "record_audio_permission_required"; client = "self-asr-start-error" },
        @{ mode = "tts_error"; text = "tts_service_unavailable"; client = "self-tts-error" }
    )
}

foreach ($case in $cases) {
    Invoke-Injection -Adb $adb -DeviceSerial $Serial -Mode $case.mode -Text $case.text -ClientId $case.client
    Start-Sleep -Milliseconds 450
}

Invoke-NativeCommand -Adb $adb -DeviceSerial $Serial -Command "tts" -Text "COMMAND_TTS_SELF_TEST"
Start-Sleep -Milliseconds 450
Invoke-Injection -Adb $adb -DeviceSerial $Serial -Mode "tts_ack" -Text "COMMAND_TTS_SELF_TEST" -ClientId "self-command-tts"
Start-Sleep -Milliseconds 450

if (-not $SkipTimeoutCase) {
    Invoke-Injection -Adb $adb -DeviceSerial $Serial -Mode "timeout" -Text "TIMEOUT_SELF_TEST" -ClientId "self-timeout"
    Start-Sleep -Seconds 8
}

Start-Sleep -Seconds 1
$rawLog = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time")
$rawLog | Set-Content -LiteralPath $rawLogPath -Encoding UTF8

$filtered = @($rawLog | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|ProbeResult|native voice|原生|RABI_|AndroidRuntime|FATAL EXCEPTION"
})
$filtered | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8

$joined = ($filtered -join "`n")
$checks = [ordered]@{
    packageLaunched = $joined -match "RokidProbeActivity"
    appStarted = $joined -match "onOpenAppResult=true"
    pingAck = $joined -match "PONG_SELF_TEST"
    asrStartAck = $joined -match "asr_start.*started"
    asrText = $joined -match "ASR_SELF_TEST_TEXT"
    echoLoopback = $joined -match "ASR 回声测试发送 TTS"
    ttsAck = $joined -match "TTS_SELF_TEST_TEXT"
    commandTts = $joined -match "native voice command=tts" -and $joined -match "COMMAND_TTS_SELF_TEST"
    asrStartError = $SkipFailureCases -or ($joined -match "record_audio_permission_required")
    ttsError = $SkipFailureCases -or ($joined -match "tts_service_unavailable")
    timeoutError = $SkipTimeoutCase -or ($joined -match "self_timeout" -and $joined -match "回包超时")
    noFatalException = -not ($joined -match "FATAL EXCEPTION|Process: com\.rabi\.link")
}

$passed = -not ($checks.Values -contains $false)
$summary = [ordered]@{
    passed = $passed
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    adb = $adb
    serial = $Serial
    packageName = $packageName
    activity = $activityName
    installed = [bool]$Install
    built = [bool]$Build
    rawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
    filteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    checks = $checks
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

[pscustomobject]@{
    Passed = $passed
    Summary = (Resolve-Path -LiteralPath $summaryPath).Path
    FilteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    RawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
}
