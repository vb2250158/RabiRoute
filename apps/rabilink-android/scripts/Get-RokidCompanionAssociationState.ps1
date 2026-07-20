param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

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

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$activityDumpPath = Join-Path $OutputDir "rokid-companion-state-activity-$timestamp.txt"
$uiDumpPath = Join-Path $OutputDir "rokid-companion-state-ui-$timestamp.xml"
$logPath = Join-Path $OutputDir "rokid-companion-state-log-$timestamp.txt"
$summaryPath = Join-Path $OutputDir "rokid-companion-state-summary-$timestamp.json"

$activityDump = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "activity", "activities")
$activityDump | Set-Content -LiteralPath $activityDumpPath -Encoding UTF8
$activityText = ($activityDump -join "`n")
$topActivity = Get-LastRegexGroup -Text $activityText -Pattern "(?:topResumedActivity|ResumedActivity|mResumedActivity):\s+ActivityRecord\{[^\r\n]*?\s([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)" -GroupIndex 1

$uiText = ""
$uiDumpOk = $false
try {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "uiautomator", "dump", "/sdcard/rabi-companion-state-ui.xml") | Out-Null
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("pull", "/sdcard/rabi-companion-state-ui.xml", $uiDumpPath) | Out-Null
    if (Test-Path -LiteralPath $uiDumpPath) {
        $uiText = Get-Content -LiteralPath $uiDumpPath -Raw
        $uiDumpOk = $true
    }
} catch {
    $uiText = $_.Exception.Message
}

$log = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("logcat", "-d", "-v", "time")
$filtered = @($log | Where-Object {
    $_ -match "RabiRokidProbe|RokidProbeActivity|Phone SDK Companion|Phone SDK device link|Phone SDK BT/Auth|Phone SDK BT connect|Phone SDK P2P|Phone SDK glass device info|Phone SDK voice auth"
})
$filtered | Set-Content -LiteralPath $logPath -Encoding UTF8
$joinedLog = ($filtered -join "`n")

$waitingForUserUnlock = [bool](
    $uiText -match "请用图案密码|指纹解锁|keyguard|lockPatternView|bouncer_message_area_title|com\.android\.systemui:id/keyguard"
)
$associationActivityVisible = [bool](
    $topActivity -match "com\.android\.companiondevicemanager/.+Association"
)
$associationPending = [bool](
    $joinedLog -match "Phone SDK Companion association pending|Phone SDK Companion association device found"
)
$associationCreated = [bool](
    $joinedLog -match "Phone SDK Companion association created|Phone SDK Companion association result resultCode=-1"
)
$associationFailed = [bool](
    $joinedLog -match "Phone SDK Companion association error|Phone SDK Companion association failure|系统 Companion 关联异常|系统 Companion 关联失败"
)
$deviceLinkSeen = [bool]($joinedLog -match "Phone SDK device link")
$btAuthSeen = [bool]($joinedLog -match "Phone SDK BT/Auth probe")

$status = "unknown"
$nextAction = "查看 activityDump/uiDump/log 进一步判断。"
if ($associationCreated) {
    $status = "associated"
    $nextAction = "系统关联已创建；运行 Test-RokidPhoneVoicePrerequisites.ps1 -IncludeBtConnect 比较 Phone SDK readiness。"
} elseif ($associationActivityVisible -and $waitingForUserUnlock) {
    $status = "waiting_unlock"
    $nextAction = "手机已在系统关联页但被锁屏遮住；解锁手机并确认关联。"
} elseif ($associationActivityVisible) {
    $status = "waiting_confirm"
    $nextAction = "手机正在显示系统关联页；确认关联 Glasses 设备。"
} elseif ($associationFailed) {
    $status = "failed"
    $nextAction = "系统关联失败；查看日志中的 Companion association failure/error。"
}

$summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    serial = $Serial
    status = $status
    nextAction = $nextAction
    topActivity = $topActivity
    associationActivityVisible = $associationActivityVisible
    waitingForUserUnlock = $waitingForUserUnlock
    associationPending = $associationPending
    associationCreated = $associationCreated
    associationFailed = $associationFailed
    deviceLinkSeen = $deviceLinkSeen
    btAuthSeen = $btAuthSeen
    activityDump = (Resolve-Path -LiteralPath $activityDumpPath).Path
    uiDumpOk = $uiDumpOk
    uiDump = if (Test-Path -LiteralPath $uiDumpPath) { (Resolve-Path -LiteralPath $uiDumpPath).Path } else { "" }
    log = (Resolve-Path -LiteralPath $logPath).Path
    summaryPath = ""
}

$summary["summaryPath"] = [System.IO.Path]::GetFullPath($summaryPath)
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 5
