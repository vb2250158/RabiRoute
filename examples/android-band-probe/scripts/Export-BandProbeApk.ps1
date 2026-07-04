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
        $knownGradle = Join-Path $env:USERPROFILE ".gradle\wrapper\dists\gradle-7.5.1-bin\7jzzequgds1hbszbhq3npc5ng\gradle-7.5.1\bin\gradle.bat"
        if (-not (Test-Path -LiteralPath $knownGradle)) {
            throw "没有找到 gradlew.bat，也没有找到已知 Gradle: $knownGradle"
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
$outputName = "RabiBandProbe-v$versionName+$versionCode-$timestamp-debug.apk"
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
