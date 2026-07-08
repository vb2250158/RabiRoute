param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        "auth",
        "request_auth",
        "connect_custom_view",
        "connect_glass_app",
        "connect_glass_app_session",
        "query_glass_asr",
        "query_glass_asr_app",
        "install_glass_asr",
        "install_glass_asr_app",
        "start_glass_asr",
        "start_glass_asr_app",
        "stop_glass_asr",
        "stop_glass_asr_app"
    )]
    [string]$Command,
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [int]$WaitSeconds = 5,
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

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$normalizedCommand = $Command.Trim().ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rawLogPath = Join-Path $OutputDir "rokid-glass-app-command-raw-$timestamp.txt"
$filteredLogPath = Join-Path $OutputDir "rokid-glass-app-command-filtered-$timestamp.txt"
$summaryPath = Join-Path $OutputDir "rokid-glass-app-command-summary-$timestamp.json"

if (-not $KeepLogcat) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-c") | Out-Null
}

if (-not $NoLaunch) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "am", "start", "-n", $activityName) | Out-Null
    Start-Sleep -Milliseconds 800
}

Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @(
    "shell", "am", "start",
    "-n", $activityName,
    "--es", "rokid_probe_command", $normalizedCommand
) | Out-Null

if ($WaitSeconds -gt 0) {
    Start-Sleep -Seconds $WaitSeconds
}

$rawLog = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time")
$rawLog | Set-Content -LiteralPath $rawLogPath -Encoding UTF8

$filtered = @($rawLog | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|ProbeResult|CXRLink|CUSTOMAPP|CUSTOMVIEW|onGlassApp|onQueryAppResult|onInstallAppResult|onOpenAppResult|appUploadAndInstall|appStart|appIsInstalled|connectGlassAppSession|AndroidRuntime|FATAL EXCEPTION"
})
$filtered | Set-Content -LiteralPath $filteredLogPath -Encoding UTF8

$joined = ($filtered -join "`n")
$checks = [ordered]@{
    commandAccepted = $joined -match ("rokid probe command=" + [regex]::Escape($normalizedCommand))
    missingToken = $joined -match "缺少 token"
    connectRequested = $joined -match "RokidProbeActivity.*connectGlassAppSession=|RabiRokidProbe.*connectGlassAppSession=|RokidProbeActivity.*connect=|RabiRokidProbe.*connect="
    customAppSessionConfigured = $joined -match "configCXRSession CUSTOMAPP"
    customAppReady = $joined -match "onGlassAppSession(Start|Available)|CXRLink.*ready|Glass BT.*是"
    queryRequested = $joined -match "appIsInstalled target=com\.rabi\.link\.glass|已请求查询 (Rabi Glass Test|眼镜端 ASR APK) 安装状态"
    installRequested = $joined -match "appUploadAndInstall|已请求安装内置眼镜 APK"
    startRequested = $joined -match "appStart entry=com\.rabi\.link\.glass\.GlassAsrProbeActivity|已请求启动 (Rabi Glass Test|眼镜端 ASR 应用)"
    installed = $joined -match "onQueryAppResult installed=true|onInstallAppResult=true"
    missingOnGlass = $joined -match "onQueryAppResult installed=false"
    started = $joined -match "onOpenAppResult=true|onGlassAppResume=true"
    failed = $joined -match "ProbeResult\[rokid-glass/rokid\.glass_asr\] failed|onInstallAppResult=false|onOpenAppResult=false|未知 rokid_probe_command|眼镜应用会话未就绪|缺少 token"
    noFatalException = -not ($joined -match "FATAL EXCEPTION|Process: com\.rabi\.link")
}

$ok = $checks.commandAccepted -and $checks.noFatalException -and (-not $checks.failed) -and (-not $checks.missingToken)
$status = "requested"
if (-not $ok) {
    $status = "failed"
} elseif ($checks.started) {
    $status = "started"
} elseif ($checks.installed) {
    $status = "installed"
} elseif ($checks.customAppReady -or $checks.connectRequested -or $checks.queryRequested -or $checks.installRequested -or $checks.startRequested) {
    $status = "requested"
}

$summary = [ordered]@{
    ok = [bool]$ok
    status = $status
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    mode = "glass-app-command"
    adb = $adb
    serial = $Serial
    packageName = $packageName
    activity = $activityName
    command = $normalizedCommand
    waitSeconds = $WaitSeconds
    rawLog = (Resolve-Path -LiteralPath $rawLogPath).Path
    filteredLog = (Resolve-Path -LiteralPath $filteredLogPath).Path
    checks = $checks
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 5
