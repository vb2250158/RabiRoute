param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$Key = "",
    [string]$Secret = "",
    [string]$DeviceTypeId = "",
    [string]$DeviceId = "",
    [string]$Seed = "",
    [string]$WorkDir = "workdir_asr_cn",
    [string]$ConfigFile = "lothal_single.ini",
    [switch]$Clear
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
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

function ConvertTo-B64 {
    param([string]$Value)
    if ($null -eq $Value) {
        $Value = ""
    }
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

if ($Clear) {
    $Key = ""
    $Secret = ""
    $DeviceTypeId = ""
    $DeviceId = ""
    $Seed = ""
}

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
if ($Clear) {
    Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @(
        "shell", "am", "start",
        "-n", $activityName,
        "--es", "native_voice_command", "rokid_ai_clear_config"
    ) | Out-Null

    [ordered]@{
        ok = $true
        packageName = "com.rabi.link"
        command = "rokid_ai_clear_config"
        serial = $Serial
        configured = $false
        workDir = $WorkDir
        configFile = $ConfigFile
        note = "RokidAiSdk 配置已清空。"
    } | ConvertTo-Json -Depth 3
    exit 0
}

$args = @(
    "shell", "am", "start",
    "-n", $activityName,
    "--es", "native_voice_command", "rokid_ai_save_config",
    "--es", "rokid_ai_key_b64", (ConvertTo-B64 $Key),
    "--es", "rokid_ai_secret_b64", (ConvertTo-B64 $Secret),
    "--es", "rokid_ai_device_type_id_b64", (ConvertTo-B64 $DeviceTypeId),
    "--es", "rokid_ai_device_id_b64", (ConvertTo-B64 $DeviceId),
    "--es", "rokid_ai_seed_b64", (ConvertTo-B64 $Seed),
    "--es", "rokid_ai_work_dir", $WorkDir,
    "--es", "rokid_ai_config_file", $ConfigFile
)

Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs $args | Out-Null

[ordered]@{
    ok = $true
    packageName = "com.rabi.link"
    command = "rokid_ai_save_config"
    serial = $Serial
    configured = -not $Clear -and -not [string]::IsNullOrWhiteSpace($Key) -and -not [string]::IsNullOrWhiteSpace($Secret) -and -not [string]::IsNullOrWhiteSpace($DeviceTypeId) -and -not [string]::IsNullOrWhiteSpace($DeviceId) -and -not [string]::IsNullOrWhiteSpace($Seed)
    workDir = $WorkDir
    configFile = $ConfigFile
    note = "密钥已通过 base64 intent extra 写入手机 SharedPreferences；stdout 不输出原文。"
} | ConvertTo-Json -Depth 3
