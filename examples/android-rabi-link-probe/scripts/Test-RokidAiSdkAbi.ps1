param(
    [string]$AarDir = "",
    [string]$AdbPath = "",
    [string]$Serial = "",
    [string[]]$RequiredAbis = @("armeabi-v7a")
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($AarDir)) {
    $AarDir = Join-Path $projectRoot "out\reference\RokidAiSdkDemo\app\libs"
}
if (-not (Test-Path -LiteralPath $AarDir)) {
    throw "AAR 目录不存在：$AarDir"
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

    if ([string]::IsNullOrWhiteSpace($Adb)) {
        return @()
    }
    $prefix = @()
    if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
        $prefix = @("-s", $DeviceSerial)
    }
    $output = & $Adb @prefix @AdbArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        return @()
    }
    return @($output)
}

$javaHome = ""
try {
    $javaHome = (Resolve-Path -LiteralPath (Join-Path $projectRoot "out\tools\jdk-17.0.15+6")).Path
} catch {
    $javaHome = $env:JAVA_HOME
}
$jar = if (-not [string]::IsNullOrWhiteSpace($javaHome)) { Join-Path $javaHome "bin\jar.exe" } else { "" }
if (-not (Test-Path -LiteralPath $jar)) {
    $jarCommand = Get-Command jar -ErrorAction SilentlyContinue
    if ($jarCommand) {
        $jar = $jarCommand.Source
    }
}
if (-not (Test-Path -LiteralPath $jar)) {
    throw "没有找到 jar.exe，无法读取 AAR 内容。"
}

$aarReports = @()
$allNativeAbis = New-Object System.Collections.Generic.HashSet[string]
foreach ($aar in Get-ChildItem -LiteralPath $AarDir -Filter *.aar | Sort-Object Name) {
    $entries = & $jar tf $aar.FullName
    $nativeEntries = @($entries | Where-Object { $_ -match '^(jni|lib)/([^/]+)/.+\.so$' })
    $abis = New-Object System.Collections.Generic.HashSet[string]
    foreach ($entry in $nativeEntries) {
        if ($entry -match '^(jni|lib)/([^/]+)/') {
            [void]$abis.Add($Matches[2])
            [void]$allNativeAbis.Add($Matches[2])
        }
    }
    $aarReports += [ordered]@{
        name = $aar.Name
        path = $aar.FullName
        length = $aar.Length
        nativeAbis = @($abis | Sort-Object)
        nativeLibCount = $nativeEntries.Count
    }
}

$adb = Resolve-AdbPath -ExplicitPath $AdbPath
$deviceAbis = @()
$device32BitAbis = @()
$device64BitAbis = @()
if (-not [string]::IsNullOrWhiteSpace($adb)) {
    $deviceAbis = @((Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "getprop", "ro.product.cpu.abilist")) -join "," -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $device32BitAbis = @((Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "getprop", "ro.product.cpu.abilist32")) -join "," -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $device64BitAbis = @((Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "getprop", "ro.product.cpu.abilist64")) -join "," -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

$nativeAbis = @($allNativeAbis | Sort-Object)
$deviceCanLoadRequiredAbi = $false
foreach ($abi in $RequiredAbis) {
    if ($deviceAbis -contains $abi -or $device32BitAbis -contains $abi -or $device64BitAbis -contains $abi) {
        $deviceCanLoadRequiredAbi = $true
    }
}

[ordered]@{
    ok = $deviceCanLoadRequiredAbi
    generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
    aarDir = (Resolve-Path -LiteralPath $AarDir).Path
    requiredAbis = @($RequiredAbis)
    aarNativeAbis = $nativeAbis
    deviceAbis = @($deviceAbis)
    device32BitAbis = @($device32BitAbis)
    device64BitAbis = @($device64BitAbis)
    deviceCanLoadRequiredAbi = $deviceCanLoadRequiredAbi
    conclusion = if ($deviceCanLoadRequiredAbi) {
        "设备 ABI 可加载当前 RokidAiSdk native 库，可继续启动验证。"
    } else {
        "当前设备 ABI 无法加载 RokidAiSdk native 库；需要支持 32 位 ABI 的手机或 arm64-v8a 版 RokidAiSdk AAR。"
    }
    aars = @($aarReports)
} | ConvertTo-Json -Depth 6
