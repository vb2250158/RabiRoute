param(
    [string]$ReferenceRoot = "",
    [string]$ConfigPath = "",
    [string]$OutputDir = "",
    [string]$Serial = "",
    [string]$AdbPath = "",
    [switch]$FailOnMissing
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($ReferenceRoot)) {
    $ReferenceRoot = Join-Path $projectRoot "out\reference\RokidAiSdkDemo"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-ai-sdk"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function New-Check {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail,
        [string]$Kind = "requirement"
    )

    return [pscustomobject][ordered]@{
        name = $Name
        kind = $Kind
        passed = $Passed
        detail = $Detail
    }
}

function Test-NonPlaceholderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    $trimmed = $Value.Trim()
    if ($trimmed -match "^(<.*>|TODO|todo|your_|YOUR_|placeholder|示例|example)$") {
        return $false
    }
    return $true
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

    return ""
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
    return [ordered]@{
        exitCode = $LASTEXITCODE
        output = @($output)
    }
}

function Get-ConfigValue {
    param(
        [object]$JsonConfig,
        [string]$JsonName,
        [string]$EnvName
    )

    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if (Test-NonPlaceholderValue $envValue) {
        return [ordered]@{
            present = $true
            source = "env:$EnvName"
        }
    }

    if ($JsonConfig -and $JsonConfig.PSObject.Properties.Name -contains $JsonName) {
        $jsonValue = [string]$JsonConfig.$JsonName
        if (Test-NonPlaceholderValue $jsonValue) {
            return [ordered]@{
                present = $true
                source = "json:$JsonName"
            }
        }
    }

    return [ordered]@{
        present = $false
        source = ""
    }
}

$checks = New-Object System.Collections.Generic.List[object]

$referenceExists = Test-Path -LiteralPath $ReferenceRoot
$checks.Add((New-Check -Name "referenceRoot" -Passed $referenceExists -Detail $ReferenceRoot -Kind "path"))

$libsRoot = Join-Path $ReferenceRoot "app\libs"
$assetsRoot = Join-Path $ReferenceRoot "app\src\main\assets\workdir_asr_cn"

$requiredAars = @(
    "basic-1.4.3.aar",
    "turenso-1.4.3.aar",
    "nlpconsumer-1.4.3.aar",
    "audioai-1.4.3.aar"
)

foreach ($aar in $requiredAars) {
    $path = Join-Path $libsRoot $aar
    $checks.Add((New-Check -Name "aar:$aar" -Passed (Test-Path -LiteralPath $path) -Detail $path -Kind "artifact"))
}

$requiredAssets = @(
    "logging.conf",
    "lothal_single.ini",
    "lothal_double.ini",
    "lothal_single_modules.ini",
    "lothal_double_modules.ini",
    "rasr.emb.single.ini",
    "rasr.emb.double.ini",
    "words.ini",
    "model\emb\output_graph.bin",
    "model\emb\symbol_table.txt"
)

foreach ($asset in $requiredAssets) {
    $path = Join-Path $assetsRoot $asset
    $checks.Add((New-Check -Name "asset:$asset" -Passed (Test-Path -LiteralPath $path) -Detail $path -Kind "asset"))
}

$jsonConfig = $null
$configResolvedPath = ""
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    if (Test-Path -LiteralPath $ConfigPath) {
        $configResolvedPath = (Resolve-Path -LiteralPath $ConfigPath).Path
        $jsonText = Get-Content -LiteralPath $configResolvedPath -Raw
        $jsonConfig = $jsonText | ConvertFrom-Json
        $checks.Add((New-Check -Name "configFile" -Passed $true -Detail $configResolvedPath -Kind "config"))
    } else {
        $checks.Add((New-Check -Name "configFile" -Passed $false -Detail $ConfigPath -Kind "config"))
    }
} else {
    $defaultConfigPath = Join-Path $projectRoot "secrets\rokid-ai-sdk-config.json"
    if (Test-Path -LiteralPath $defaultConfigPath) {
        $configResolvedPath = (Resolve-Path -LiteralPath $defaultConfigPath).Path
        $jsonText = Get-Content -LiteralPath $configResolvedPath -Raw
        $jsonConfig = $jsonText | ConvertFrom-Json
        $checks.Add((New-Check -Name "configFile" -Passed $true -Detail $configResolvedPath -Kind "config"))
    } else {
        $checks.Add((New-Check -Name "configFile" -Passed $false -Detail "未提供 -ConfigPath，且默认 secrets\rokid-ai-sdk-config.json 不存在；可改用环境变量。" -Kind "config"))
    }
}

$requiredConfig = @(
    @{ JsonName = "key"; EnvName = "ROKID_AI_KEY" },
    @{ JsonName = "secret"; EnvName = "ROKID_AI_SECRET" },
    @{ JsonName = "deviceTypeId"; EnvName = "ROKID_AI_DEVICE_TYPE_ID" },
    @{ JsonName = "deviceId"; EnvName = "ROKID_AI_DEVICE_ID" },
    @{ JsonName = "seed"; EnvName = "ROKID_AI_SEED" }
)

foreach ($item in $requiredConfig) {
    $probe = Get-ConfigValue -JsonConfig $jsonConfig -JsonName $item.JsonName -EnvName $item.EnvName
    $detail = if ($probe.present) { "present via $($probe.source); value hidden" } else { "missing: set $($item.EnvName) or JSON field $($item.JsonName)" }
    $checks.Add((New-Check -Name "config:$($item.JsonName)" -Passed ([bool]$probe.present) -Detail $detail -Kind "credential"))
}

$workDirValue = if ($jsonConfig -and $jsonConfig.PSObject.Properties.Name -contains "workDir" -and (Test-NonPlaceholderValue ([string]$jsonConfig.workDir)) ) { [string]$jsonConfig.workDir } else { "workdir_asr_cn" }
$configFileValue = if ($jsonConfig -and $jsonConfig.PSObject.Properties.Name -contains "configFile" -and (Test-NonPlaceholderValue ([string]$jsonConfig.configFile)) ) { [string]$jsonConfig.configFile } else { "lothal_single.ini" }

$checks.Add((New-Check -Name "config:workDir" -Passed ($workDirValue -eq "workdir_asr_cn") -Detail "effective=$workDirValue; demo assets only verified for workdir_asr_cn" -Kind "config"))
$configFileOk = $configFileValue -in @("lothal_single.ini", "lothal_double.ini")
$checks.Add((New-Check -Name "config:configFile" -Passed $configFileOk -Detail "effective=$configFileValue; expected lothal_single.ini or lothal_double.ini" -Kind "config"))

$deviceAbi = [ordered]@{
    checked = $false
    serial = $Serial
    abilist = ""
    abilist32 = ""
    supported = $false
    error = ""
}

if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $adb = Resolve-AdbPath -ExplicitPath $AdbPath
    if ([string]::IsNullOrWhiteSpace($adb)) {
        $deviceAbi.error = "adb not found"
        $checks.Add((New-Check -Name "device:armeabi-v7a" -Passed $false -Detail "指定了 -Serial，但没有找到 adb。" -Kind "device"))
    } else {
        $deviceAbi.checked = $true
        $abiProbe = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "getprop", "ro.product.cpu.abilist")
        $abi32Probe = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "getprop", "ro.product.cpu.abilist32")
        $deviceAbi.abilist = (($abiProbe.output -join "`n").Trim())
        $deviceAbi.abilist32 = (($abi32Probe.output -join "`n").Trim())
        if ($abiProbe.exitCode -ne 0 -or $abi32Probe.exitCode -ne 0) {
            $deviceAbi.error = "adb getprop failed"
        }
        $allAbiText = "$($deviceAbi.abilist),$($deviceAbi.abilist32)"
        $deviceAbi.supported = $allAbiText -match "(^|,)armeabi-v7a(,|$)"
        $detail = "abilist=$($deviceAbi.abilist); abilist32=$($deviceAbi.abilist32); RokidAiSdk 1.4.3 requires armeabi-v7a native libs"
        $checks.Add((New-Check -Name "device:armeabi-v7a" -Passed ([bool]$deviceAbi.supported) -Detail $detail -Kind "device"))
    }
}

$failedChecks = @($checks | Where-Object { -not $_.passed })
$passed = ($failedChecks.Count -eq 0)
$missing = @($failedChecks | ForEach-Object { [string]$_.name })

$summary = [ordered]@{
    checkedAt = (Get-Date).ToString("o")
    passed = [bool]$passed
    referenceRoot = $ReferenceRoot
    configPath = $configResolvedPath
    requiredForCompile = @("basic", "turenso", "nlpconsumer", "audioai", "workdir_asr_cn assets")
    requiredForRuntime = @("key", "secret", "deviceTypeId", "deviceId", "seed", "RECORD_AUDIO", "INTERNET", "armeabi-v7a device/runtime")
    deviceAbi = $deviceAbi
    missing = $missing
    checks = @($checks.ToArray())
    note = "This only checks readiness for integrating RokidAiSdk. It does not prove ASR/TTS works."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$summaryPath = Join-Path $OutputDir "rokid-ai-sdk-readiness-summary-$timestamp.json"
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$checks |
    Select-Object name, kind, passed, detail |
    Format-Table -AutoSize

Write-Host ""
Write-Host "Passed: $passed"
Write-Host "Summary: $summaryPath"

if (-not $passed -and $FailOnMissing) {
    exit 1
}
