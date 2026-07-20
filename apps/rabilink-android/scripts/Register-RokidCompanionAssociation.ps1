param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [string]$OutputDir = "",
    [string]$PackageName = "com.rabi.link",
    [string]$SourcePackageName = "com.rokid.sprite.aiapp",
    [string]$DisplayName = "Glasses_3268"
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

function Get-AddressSuffix {
    param([string]$Address)
    if ([string]::IsNullOrWhiteSpace($Address)) {
        return "unknown"
    }
    $cleaned = $Address.Trim()
    if ($cleaned.Length -le 5) {
        return $cleaned
    }
    return $cleaned.Substring($cleaned.Length - 5)
}

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-companion-register-summary-$timestamp.json"

$dumpBefore = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "companiondevice")
$dumpBeforeText = ($dumpBefore -join "`n")
$sourcePattern = "mPackageName='$([regex]::Escape($SourcePackageName))'.*?mDeviceMacAddress=([0-9a-f:]{17}).*?mDisplayName='$([regex]::Escape($DisplayName))'"
$sourceMatch = [regex]::Match($dumpBeforeText, $sourcePattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $sourceMatch.Success) {
    throw "没有找到 $SourcePackageName 的 $DisplayName Companion association。"
}

$address = $sourceMatch.Groups[1].Value
$targetPattern = "mPackageName='$([regex]::Escape($PackageName))'.*?mDeviceMacAddress=$([regex]::Escape($address))"
$targetExistsBefore = [regex]::IsMatch($dumpBeforeText, $targetPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$registerOutput = @()
if (-not $targetExistsBefore) {
    $registerOutput = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "cmd", "companiondevice", "associate", "0", $PackageName, $address)
}

$dumpAfter = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "dumpsys", "companiondevice")
$dumpAfterText = ($dumpAfter -join "`n")
$targetExistsAfter = [regex]::IsMatch($dumpAfterText, $targetPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)

$summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    serial = $Serial
    packageName = $PackageName
    sourcePackageName = $SourcePackageName
    displayName = $DisplayName
    addressSuffix = Get-AddressSuffix -Address $address
    targetExistsBefore = $targetExistsBefore
    targetExistsAfter = $targetExistsAfter
    changed = -not $targetExistsBefore -and $targetExistsAfter
    status = if ($targetExistsAfter) { "associated" } else { "failed" }
    registerOutput = @($registerOutput | ForEach-Object { $_ -replace [regex]::Escape($address), ("**:**:**:**:" + (Get-AddressSuffix -Address $address)) })
    summaryPath = [System.IO.Path]::GetFullPath($summaryPath)
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 5
