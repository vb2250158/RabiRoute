$ErrorActionPreference = "Stop"

$sdkRoot = $env:ANDROID_HOME
if (-not $sdkRoot) {
    $sdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}

$androidJar = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "platforms") -Recurse -Filter android.jar |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if (-not $androidJar) {
    throw "找不到 Android SDK android.jar"
}

$d8 = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "build-tools") -Recurse -Filter d8.bat |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if (-not $d8) {
    throw "找不到 Android SDK d8.bat"
}

$outDir = Join-Path $PSScriptRoot "..\build\mihealth-query"
$dexDir = Join-Path $outDir "dex"
$jarPath = Join-Path $outDir "mihealth-query.jar"
$zipPath = Join-Path $outDir "mihealth-query.zip"
$sourcePath = Join-Path $PSScriptRoot "MiHealthProviderQuery.java"

Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null

javac -encoding UTF-8 -cp $androidJar.FullName -d $outDir $sourcePath
& $d8.FullName --output $dexDir (Join-Path $outDir "MiHealthProviderQuery.class")
Compress-Archive -Force -Path (Join-Path $dexDir "classes.dex") -DestinationPath $zipPath
Copy-Item -Force $zipPath $jarPath

Write-Output $jarPath
