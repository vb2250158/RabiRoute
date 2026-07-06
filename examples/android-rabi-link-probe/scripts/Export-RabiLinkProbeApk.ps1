param(
    [string]$ApkPath = "",
    [string]$OutputDir = "",
    [switch]$Build
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$appBuildGradle = Join-Path $projectRoot "app\build.gradle"

if ($Build) {
    $gradleBat = Join-Path $projectRoot "gradlew.bat"
    if (Test-Path -LiteralPath $gradleBat) {
        & $gradleBat ":app:assembleDebug"
    } else {
        $knownGradle = Join-Path $projectRoot "out\tools\gradle-8.6\bin\gradle.bat"
        if (-not (Test-Path -LiteralPath $knownGradle)) {
            $knownGradle = Join-Path $env:USERPROFILE ".gradle\wrapper\dists\gradle-8.6-bin\afr5mpiioh2wthjmwnkmdsd5w\gradle-8.6\bin\gradle.bat"
        }
        if (-not (Test-Path -LiteralPath $knownGradle)) {
            throw "没有找到 gradlew.bat，也没有找到 Gradle 8.6。当前 APK 需要 AGP 8.4.2 / Gradle 8.6 才能打包 phone.sdk.rfmlite。"
        }
        $localJdk = Join-Path $projectRoot "out\tools\jdk-17.0.15+6"
        if (Test-Path -LiteralPath $localJdk) {
            $env:JAVA_HOME = $localJdk
            $env:Path = (Join-Path $localJdk "bin") + [System.IO.Path]::PathSeparator + $env:Path
        }
        $localAndroidSdk = Join-Path $projectRoot "out\tools\android-sdk"
        if (Test-Path -LiteralPath $localAndroidSdk) {
            $env:ANDROID_HOME = $localAndroidSdk
            $env:ANDROID_SDK_ROOT = $localAndroidSdk
        }
        Push-Location $projectRoot
        try {
            & $knownGradle ":app:assembleDebug"
        } finally {
            Pop-Location
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle 构建失败。"
    }
}

if ([string]::IsNullOrWhiteSpace($ApkPath)) {
    $ApkPath = Join-Path $projectRoot "app\build\outputs\apk\debug\app-debug.apk"
}
if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK 不存在：$ApkPath"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\apk"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$buildGradleText = Get-Content -LiteralPath $appBuildGradle -Raw -Encoding UTF8
$versionName = "unknown"
$versionCode = "unknown"
if ($buildGradleText -match 'versionName\s+"([^"]+)"') {
    $versionName = $Matches[1]
}
if ($buildGradleText -match 'versionCode\s+([0-9]+)') {
    $versionCode = $Matches[1]
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputName = "RabiLinkProbe-v$versionName+$versionCode-$timestamp-debug.apk"
$outputApk = Join-Path $OutputDir $outputName
Copy-Item -LiteralPath $ApkPath -Destination $outputApk -Force

$hash = Get-FileHash -LiteralPath $outputApk -Algorithm SHA256
$manifestPath = Join-Path $OutputDir ([System.IO.Path]::GetFileNameWithoutExtension($outputApk) + ".sha256.txt")
$summary = @(
    "APK: $outputApk"
    "VersionName: $versionName"
    "VersionCode: $versionCode"
    "ExportedAt: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")"
    "SizeBytes: $((Get-Item -LiteralPath $outputApk).Length)"
    "SHA256: $($hash.Hash)"
)
Set-Content -LiteralPath $manifestPath -Value $summary -Encoding UTF8

[pscustomobject]@{
    Apk = (Resolve-Path -LiteralPath $outputApk).Path
    Sha256File = (Resolve-Path -LiteralPath $manifestPath).Path
    VersionName = $versionName
    VersionCode = $versionCode
    SizeBytes = (Get-Item -LiteralPath $outputApk).Length
    SHA256 = $hash.Hash
}
