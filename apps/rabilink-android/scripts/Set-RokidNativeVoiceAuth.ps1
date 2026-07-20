param(
    [string]$AccessKey = "",

    [string]$SecretKey = "",

    [string]$Serial = "",
    [string]$AdbPath = "",

    [switch]$Clear
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

function Resolve-ToolPath {
    param(
        [string]$ExplicitPath,
        [string]$ProjectPath,
        [string]$CommandName,
        [string]$DisplayName
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "指定的 $DisplayName 不存在：$ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    if (-not [string]::IsNullOrWhiteSpace($ProjectPath) -and (Test-Path -LiteralPath $ProjectPath)) {
        return (Resolve-Path -LiteralPath $ProjectPath).Path
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "没有找到 $DisplayName。"
}

function ConvertTo-Base64NoWrap {
    param([string]$Value)
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

if ($Clear) {
    $AccessKey = ""
    $SecretKey = ""
} elseif ([string]::IsNullOrWhiteSpace($AccessKey) -or [string]::IsNullOrWhiteSpace($SecretKey)) {
    throw "AccessKey 和 SecretKey 都不能为空。"
}

$adb = Resolve-ToolPath `
    -ExplicitPath $AdbPath `
    -ProjectPath (Join-Path $projectRoot "out\tools\android-sdk\platform-tools\adb.exe") `
    -CommandName "adb" `
    -DisplayName "adb"

$serialArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $serialArgs = @("-s", $Serial)
}

$accessKeyB64 = ConvertTo-Base64NoWrap $AccessKey
$secretKeyB64 = ConvertTo-Base64NoWrap $SecretKey

& $adb @serialArgs shell am start `
    -n "com.rabi.link/.modules.rokid.RokidProbeActivity" `
    --es native_voice_command save_auth `
    --es native_voice_access_key_b64 $accessKeyB64 `
    --es native_voice_secret_key_b64 $secretKeyB64 | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "adb am start 保存 Rokid 在线语音授权失败，exit=$LASTEXITCODE"
}

[pscustomobject]@{
    ok = $true
    serial = $Serial
    packageName = "com.rabi.link"
    activity = ".modules.rokid.RokidProbeActivity"
    configured = -not $Clear
    note = if ($Clear) {
        "已请求手机 APK 清空 Rokid 在线语音 AK/SK。"
    } else {
        "已请求手机 APK 保存 Rokid 在线语音 AK/SK；脚本不会输出密钥值。当前 APK 为避免 Rokid SDK logcat 泄漏，暂不自动把 AK/SK 注入 EngineParam。"
    }
} | ConvertTo-Json -Depth 3
