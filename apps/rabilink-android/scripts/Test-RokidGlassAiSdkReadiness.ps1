param(
    [string]$ConfigPath = "",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $projectRoot "secrets\rokid-ai-sdk.properties"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-native-voice"
}

function Read-ConfigFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return @{}
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

function Field-State {
    param(
        [hashtable]$Values,
        [string]$Name
    )
    $value = [string]$Values[$Name]
    if ([string]::IsNullOrWhiteSpace($value)) {
        return "missing"
    }
    return "set:" + $value.Length
}

function Latest-GlassAiEvidence {
    param([string]$Dir)

    if (-not (Test-Path -LiteralPath $Dir)) {
        return $null
    }
    $files = Get-ChildItem -LiteralPath $Dir -Filter "rokid-native-command-summary-*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    foreach ($file in $files) {
        try {
            $json = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($json.command -like "glass_rokid_ai*") {
                return [ordered]@{
                    command = $json.command
                    status = $json.status
                    ok = [bool]$json.ok
                    acknowledged = [bool]$json.acknowledged
                    generatedAt = $json.generatedAt
                    summaryPath = $file.FullName
                    filteredLog = [string]$json.filteredLog
                    errors = @($json.results.rokidAiSdkErrors)
                }
            }
        } catch {
        }
    }
    return $null
}

$phoneApk = Join-Path $projectRoot "app\build\outputs\apk\debug\app-debug.apk"
$glassApk = Join-Path $projectRoot "glass-app\build\outputs\apk\debug\glass-app-debug.apk"
$config = Read-ConfigFile -Path $ConfigPath
$requiredFields = @("key", "secret", "deviceTypeId", "deviceId", "seed")
$missing = @()
$fieldStates = [ordered]@{}
foreach ($field in $requiredFields) {
    $fieldStates[$field] = Field-State -Values $config -Name $field
    if ($fieldStates[$field] -eq "missing") {
        $missing += $field
    }
}
$workDir = [string]$config["workDir"]
$configFile = [string]$config["configFile"]
if ([string]::IsNullOrWhiteSpace($workDir)) {
    $workDir = "workdir_asr_cn"
}
if ([string]::IsNullOrWhiteSpace($configFile)) {
    $configFile = "lothal_single.ini"
}

$phoneApkExists = Test-Path -LiteralPath $phoneApk
$glassApkExists = Test-Path -LiteralPath $glassApk
$configExists = Test-Path -LiteralPath $ConfigPath
$configComplete = $missing.Count -eq 0
$latestEvidence = Latest-GlassAiEvidence -Dir $OutputDir

[ordered]@{
    ok = $phoneApkExists -and $glassApkExists -and $configComplete
    mode = "rokid-glass-ai-sdk-readiness"
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    phoneApk = [ordered]@{
        exists = $phoneApkExists
        path = $phoneApk
    }
    glassApk = [ordered]@{
        exists = $glassApkExists
        path = $glassApk
    }
    config = [ordered]@{
        exists = $configExists
        path = $ConfigPath
        complete = $configComplete
        fields = $fieldStates
        missing = @($missing)
        workDir = $workDir
        configFile = $configFile
    }
    latestGlassAiEvidence = $latestEvidence
    nextAction = if (-not $phoneApkExists -or -not $glassApkExists) {
        "先运行 Gradle :app:assembleDebug 构建手机 APK 和内置眼镜 APK。"
    } elseif (-not $configExists) {
        "等待 Rokid 开放平台审核/语音接入凭证；拿到后可在手机 APK 第 09 卡片填写，或运行 Set-RokidGlassAiSdkConfig.ps1 -CreateTemplate 创建本机脚本配置。"
    } elseif (-not $configComplete) {
        "补齐配置文件或手机 APK 第 09 卡片中的 key/secret/deviceTypeId/deviceId/seed。"
    } else {
        "运行 Set-RokidGlassAiSdkConfig.ps1 -ProbeAfter，再运行 -StartAfterConfig 验证 ASR/TTS。"
    }
    note = "这个检查只验证本地准备度，不证明 RokidAiSdk ASR/TTS 已经成功。"
} | ConvertTo-Json -Depth 6
