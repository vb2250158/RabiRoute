param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [int]$MaxAttempts = 4,
    [int]$ConnectWaitSeconds = 12,
    [int]$InstallWaitSeconds = 60,
    [switch]$SkipStayAwake
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$commandScript = Join-Path $PSScriptRoot "Invoke-RokidGlassAppCommand.ps1"

if (-not (Test-Path -LiteralPath $commandScript)) {
    throw "缺少脚本：$commandScript"
}

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

function Invoke-GlassCommandJson {
    param(
        [string]$Command,
        [int]$WaitSeconds,
        [string]$AttemptOutputDir
    )

    $params = @{
        Command = $Command
        WaitSeconds = $WaitSeconds
        OutputDir = $AttemptOutputDir
    }
    if (-not [string]::IsNullOrWhiteSpace($Serial)) {
        $params.Serial = $Serial
    }
    if (-not [string]::IsNullOrWhiteSpace($AdbPath)) {
        $params.AdbPath = $AdbPath
    }

    $text = (& $commandScript @params 2>&1) -join "`n"
    try {
        return $text | ConvertFrom-Json
    } catch {
        throw "解析 $Command 输出 JSON 失败：$text"
    }
}

if ($MaxAttempts -lt 1) {
    throw "-MaxAttempts 必须大于等于 1。"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot ("out\rokid-native-voice\glass-install-retry-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$attempts = @()

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $attemptDir = Join-Path $OutputDir ("attempt-" + $attempt.ToString("00"))
    New-Item -ItemType Directory -Force -Path $attemptDir | Out-Null

    if (-not $SkipStayAwake) {
        Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "settings", "put", "global", "stay_on_while_plugged_in", "7") | Out-Null
        Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "input", "keyevent", "WAKEUP") | Out-Null
        Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "input", "keyevent", "82") | Out-Null
    }

    $connect = Invoke-GlassCommandJson -Command "connect_glass_app" -WaitSeconds $ConnectWaitSeconds -AttemptOutputDir $attemptDir
    $install = Invoke-GlassCommandJson -Command "install_glass_asr" -WaitSeconds $InstallWaitSeconds -AttemptOutputDir $attemptDir

    $attemptSummary = [ordered]@{
        attempt = $attempt
        connectOk = [bool]$connect.ok
        connectStatus = [string]$connect.status
        installOk = [bool]$install.ok
        installStatus = [string]$install.status
        installSummary = $install
    }
    $attempts += [pscustomobject]$attemptSummary

    if ($install.ok -and $install.status -eq "installed") {
        break
    }

    Start-Sleep -Seconds ([Math]::Min(8, 2 * $attempt))
}

$passed = $attempts.Count -gt 0 -and [bool]$attempts[-1].installOk -and [string]$attempts[-1].installStatus -eq "installed"
$summary = [ordered]@{
    ok = [bool]$passed
    status = if ($passed) { "installed" } else { "failed" }
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    maxAttempts = $MaxAttempts
    outputDir = (Resolve-Path -LiteralPath $OutputDir).Path
    attempts = $attempts
}

$summaryPath = Join-Path $OutputDir "glass-install-retry-summary.json"
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 10
