param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$DemoActivityPath = "",
    [switch]$UseAlternateBlock
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($DemoActivityPath)) {
    $DemoActivityPath = Join-Path $projectRoot "out\reference\RokidAiSdkDemo\app\src\main\java\com\rokid\ai\sdkdemo\PhoneAudioActivity.java"
}
if (-not (Test-Path -LiteralPath $DemoActivityPath)) {
    throw "没有找到 RokidAiSdk demo Activity：$DemoActivityPath"
}

$source = Get-Content -LiteralPath $DemoActivityPath -Raw
$patterns = [ordered]@{
    Key = 'String\s+key\s*=\s*"([^"]+)"'
    Secret = 'String\s+secret\s*=\s*"([^"]+)"'
    DeviceTypeId = 'String\s+deviceTypeId\s*=\s*"([^"]+)"'
    DeviceId = 'String\s+deviceId\s*=\s*"([^"]+)"'
    Seed = 'String\s+seed\s*=\s*"([^"]+)"'
}

$values = @{}
foreach ($entry in $patterns.GetEnumerator()) {
    $matches = [regex]::Matches($source, $entry.Value)
    if ($matches.Count -eq 0) {
        throw "Demo Activity 缺少字段：$($entry.Key)"
    }
    $index = if ($UseAlternateBlock -and $matches.Count -gt 1) { 1 } else { 0 }
    $values[$entry.Key] = $matches[$index].Groups[1].Value
}

$setScript = Join-Path $PSScriptRoot "Set-RokidAiSdkConfig.ps1"
& $setScript `
    -Serial $Serial `
    -AdbPath $AdbPath `
    -Key $values.Key `
    -Secret $values.Secret `
    -DeviceTypeId $values.DeviceTypeId `
    -DeviceId $values.DeviceId `
    -Seed $values.Seed

[ordered]@{
    ok = $true
    source = (Resolve-Path -LiteralPath $DemoActivityPath).Path
    usedAlternateBlock = [bool]$UseAlternateBlock
    note = "已从本地 RokidAiSdkDemo 源码导入测试配置；未在 stdout 输出原值。"
} | ConvertTo-Json -Depth 3
