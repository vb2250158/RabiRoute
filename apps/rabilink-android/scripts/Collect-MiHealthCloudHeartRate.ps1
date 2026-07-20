param(
    [string]$Serial = "",
    [string]$DataTypes = "com.xiaomi.micloud.fit.heart_rate.bpm,com.xiaomi.micloud.fit.heart_rate.summary",
    [int64]$Hours = 24,
    [int64]$SliceHours = 0,
    [int]$Limit = 500,
    [int]$MaxPages = 20,
    [int]$WaitSeconds = 45,
    [switch]$InstallApk,
    [switch]$AllSdkDataTypes,
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$packageName = "com.rabi.link"
$serviceName = "$packageName/.modules.xiaomi.MiHealthCloudProbeService"
$apkPath = Join-Path $PSScriptRoot "..\app\build\outputs\apk\debug\app-debug.apk"
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $PSScriptRoot "..\out\mi-health-cloud"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ($AllSdkDataTypes) {
    $DataTypes = "__all_sdk__"
    if ($PSBoundParameters.ContainsKey("Hours") -eq $false) {
        $Hours = 168
    }
    if ($PSBoundParameters.ContainsKey("SliceHours") -eq $false) {
        $SliceHours = 24
    }
    if ($PSBoundParameters.ContainsKey("Limit") -eq $false) {
        $Limit = 1000
    }
    if ($PSBoundParameters.ContainsKey("MaxPages") -eq $false) {
        $MaxPages = 50
    }
    if ($PSBoundParameters.ContainsKey("WaitSeconds") -eq $false) {
        $WaitSeconds = 120
    }
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    if ([string]::IsNullOrWhiteSpace($Serial)) {
        & adb @Args
    } else {
        & adb -s $Serial @Args
    }
    if ($LASTEXITCODE -ne 0) {
        throw "adb failed: $($Args -join ' ')"
    }
}

if ($InstallApk) {
    if (-not (Test-Path -LiteralPath $apkPath)) {
        throw "APK not found: $apkPath"
    }
    Invoke-Adb install -r $apkPath
}

Invoke-Adb shell am start-foreground-service `
    -n $serviceName `
    --es data_types $DataTypes `
    --el hours $Hours `
    --el slice_hours $SliceHours `
    --ei limit $Limit `
    --ei max_pages $MaxPages

Start-Sleep -Seconds $WaitSeconds

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonOut = Join-Path $OutputDir "mi-health-heart-rate-$timestamp.json"
$mdOut = Join-Path $OutputDir "mi-health-heart-rate-$timestamp.md"
$logOut = Join-Path $OutputDir "mi-health-cloud-log-$timestamp.txt"
$rawOut = Join-Path $OutputDir "raw-$timestamp"
$zipOut = Join-Path $OutputDir "mi-health-cloud-$timestamp.zip"

Invoke-Adb exec-out run-as $packageName cat "files/mi-health-heart-rate-last.json" |
    Set-Content -LiteralPath $jsonOut -Encoding UTF8

Invoke-Adb exec-out run-as $packageName cat "files/mi-health-heart-rate-last.md" |
    Set-Content -LiteralPath $mdOut -Encoding UTF8

Invoke-Adb logcat -d -s RabiMiHealthCloud:I AndroidRuntime:E |
    Set-Content -LiteralPath $logOut -Encoding UTF8

New-Item -ItemType Directory -Force -Path $rawOut | Out-Null
$rawListArgs = @("shell", "run-as", $packageName, "sh", "-c", "ls files/mi-health-cloud-raw/*.json 2>/dev/null")
if ([string]::IsNullOrWhiteSpace($Serial)) {
    $rawFiles = & adb @rawListArgs
} else {
    $rawFiles = & adb -s $Serial @rawListArgs
}
if ($LASTEXITCODE -eq 0) {
    foreach ($rawFile in @($rawFiles)) {
        $remotePath = ([string]$rawFile).Trim()
        if ([string]::IsNullOrWhiteSpace($remotePath)) {
            continue
        }
        $fileName = [System.IO.Path]::GetFileName($remotePath)
        $localRaw = Join-Path $rawOut $fileName
        Invoke-Adb exec-out run-as $packageName cat $remotePath |
            Set-Content -LiteralPath $localRaw -Encoding UTF8
    }
}

$zipItems = @($jsonOut, $mdOut, $logOut)
if ((Test-Path -LiteralPath $rawOut) -and (Get-ChildItem -LiteralPath $rawOut -File -ErrorAction SilentlyContinue)) {
    $zipItems += $rawOut
}
Compress-Archive -LiteralPath $zipItems -DestinationPath $zipOut -Force

[pscustomobject]@{
    Json = (Resolve-Path -LiteralPath $jsonOut).Path
    Markdown = (Resolve-Path -LiteralPath $mdOut).Path
    Log = (Resolve-Path -LiteralPath $logOut).Path
    RawDir = (Resolve-Path -LiteralPath $rawOut).Path
    Zip = (Resolve-Path -LiteralPath $zipOut).Path
    DataTypes = $DataTypes
    Hours = $Hours
    SliceHours = $SliceHours
    Limit = $Limit
    MaxPages = $MaxPages
}
