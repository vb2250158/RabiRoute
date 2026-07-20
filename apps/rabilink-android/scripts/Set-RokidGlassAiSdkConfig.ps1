param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$ConfigPath = "",
    [string]$OutputDir = "",
    [int]$WaitSeconds = 10,
    [switch]$CreateTemplate,
    [switch]$Clear,
    [switch]$ProbeAfter,
    [switch]$StartAfterConfig
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$sendScript = Join-Path $PSScriptRoot "Send-RokidNativeVoiceCommand.ps1"

if (-not (Test-Path -LiteralPath $sendScript)) {
    throw "没有找到 Send-RokidNativeVoiceCommand.ps1：$sendScript"
}

function Read-ConfigFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "配置文件不存在：$Path"
    }

    if ([IO.Path]::GetExtension($Path).ToLowerInvariant() -eq ".json") {
        $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        return @{
            key = [string]$json.key
            secret = [string]$json.secret
            deviceTypeId = [string]$json.deviceTypeId
            deviceId = [string]$json.deviceId
            seed = [string]$json.seed
            workDir = [string]$json.workDir
            configFile = [string]$json.configFile
        }
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }
        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }
        $values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1).Trim()
    }
    return $values
}

function Require-Field {
    param(
        [hashtable]$Values,
        [string]$Name
    )

    $value = [string]$Values[$Name]
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "配置缺少必填字段：$Name"
    }
    return $value
}

function Invoke-NativeCommand {
    param(
        [string]$Command,
        [hashtable]$ExtraArgs = @{}
    )

    $args = @{
        Command = $Command
        Serial = $Serial
        AdbPath = $AdbPath
        OutputDir = $OutputDir
        WaitSeconds = $WaitSeconds
    }
    foreach ($key in $ExtraArgs.Keys) {
        $args[$key] = $ExtraArgs[$key]
    }
    & $sendScript @args
}

function New-TemplateFile {
    param([string]$Path)

    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    if (Test-Path -LiteralPath $Path) {
        throw "配置文件已存在，不覆盖：$Path"
    }
    @(
        "# RokidAiSdk 私有测试凭证。不要提交，不要发到聊天。"
        "key="
        "secret="
        "deviceTypeId="
        "deviceId="
        "seed="
        "workDir=workdir_asr_cn"
        "configFile=lothal_single.ini"
    ) | Set-Content -LiteralPath $Path -Encoding UTF8
    [ordered]@{
        ok = $true
        configPath = (Resolve-Path -LiteralPath $Path).Path
        note = "已创建空模板；填入 Rokid 开放平台凭证后再运行 -ProbeAfter 或 -StartAfterConfig。"
    } | ConvertTo-Json -Depth 3
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $projectRoot "secrets\rokid-ai-sdk.properties"
}

if ($CreateTemplate) {
    New-TemplateFile -Path $ConfigPath
    exit 0
}

if ($Clear) {
    Invoke-NativeCommand -Command "glass_rokid_ai_clear_config"
    exit 0
}

$config = Read-ConfigFile -Path $ConfigPath
$key = Require-Field -Values $config -Name "key"
$secret = Require-Field -Values $config -Name "secret"
$deviceTypeId = Require-Field -Values $config -Name "deviceTypeId"
$deviceId = Require-Field -Values $config -Name "deviceId"
$seed = Require-Field -Values $config -Name "seed"
$workDir = [string]$config["workDir"]
$configFile = [string]$config["configFile"]

if ([string]::IsNullOrWhiteSpace($workDir)) {
    $workDir = "workdir_asr_cn"
}
if ([string]::IsNullOrWhiteSpace($configFile)) {
    $configFile = "lothal_single.ini"
}

Invoke-NativeCommand -Command "glass_rokid_ai_save_config" -ExtraArgs @{
    RokidAiKey = $key
    RokidAiSecret = $secret
    RokidAiDeviceTypeId = $deviceTypeId
    RokidAiDeviceId = $deviceId
    RokidAiSeed = $seed
    RokidAiWorkDir = $workDir
    RokidAiConfigFile = $configFile
}

if ($ProbeAfter) {
    Invoke-NativeCommand -Command "glass_rokid_ai_probe"
}

if ($StartAfterConfig) {
    Invoke-NativeCommand -Command "glass_rokid_ai_start"
}
