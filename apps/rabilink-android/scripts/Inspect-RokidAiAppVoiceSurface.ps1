param(
    [string]$Serial = "",
    [string]$PackageName = "com.rokid.sprite.aiapp",
    [string]$AdbPath = "",
    [string]$AaptPath = "",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $projectRoot "out\rokid-aiapp"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

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

function Resolve-OptionalToolPath {
    param(
        [string]$ExplicitPath,
        [string]$ProjectPath,
        [string]$CommandName
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }
        return ""
    }

    if (-not [string]::IsNullOrWhiteSpace($ProjectPath) -and (Test-Path -LiteralPath $ProjectPath)) {
        return (Resolve-Path -LiteralPath $ProjectPath).Path
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    return ""
}

function Invoke-Adb {
    param(
        [string]$Adb,
        [string]$DeviceSerial,
        [string[]]$AdbArgs,
        [switch]$AllowFailure
    )

    $prefix = @()
    if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
        $prefix = @("-s", $DeviceSerial)
    }

    $output = & $Adb @prefix @AdbArgs 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "adb 执行失败 ($exitCode): $Adb $($prefix -join ' ') $($AdbArgs -join ' ')`n$output"
    }
    return [ordered]@{
        exitCode = $exitCode
        output = @($output)
    }
}

function Match-Lines {
    param(
        [string]$Path,
        [string]$Pattern,
        [int]$Max = 200
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    return @(
        Select-String -LiteralPath $Path -Pattern $Pattern -CaseSensitive:$false |
            Select-Object -First $Max |
            ForEach-Object {
                [ordered]@{
                    line = $_.LineNumber
                    text = $_.Line.Trim()
                }
            }
    )
}

function Parse-BadgingValue {
    param(
        [string]$Text,
        [string]$Pattern
    )

    $match = [regex]::Match($Text, $Pattern)
    if ($match.Success -and $match.Groups.Count -gt 1) {
        return $match.Groups[1].Value
    }
    return ""
}

function Extract-ManifestActionNames {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    $lines = Get-Content -LiteralPath $Path
    $actions = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -notmatch "^\s*E: action") {
            continue
        }

        $actionLine = $i + 1
        $max = [Math]::Min($i + 6, $lines.Count - 1)
        for ($j = $i + 1; $j -le $max; $j++) {
            $match = [regex]::Match($lines[$j], 'A: android:name.*Raw: "([^"]+)"')
            if ($match.Success) {
                $actions += [ordered]@{
                    line = $j + 1
                    actionLine = $actionLine
                    text = $match.Groups[1].Value
                }
                break
            }
        }
    }

    return @($actions)
}

$adb = Resolve-ToolPath `
    -ExplicitPath $AdbPath `
    -ProjectPath (Join-Path $projectRoot "out\tools\android-sdk\platform-tools\adb.exe") `
    -CommandName "adb" `
    -DisplayName "adb"

$aapt = Resolve-ToolPath `
    -ExplicitPath $AaptPath `
    -ProjectPath (Join-Path $projectRoot "out\tools\android-sdk\build-tools\34.0.0\aapt.exe") `
    -CommandName "aapt" `
    -DisplayName "aapt"

$jar = Resolve-ToolPath `
    -ExplicitPath "" `
    -ProjectPath (Join-Path $projectRoot "out\tools\jdk-17.0.15+6\bin\jar.exe") `
    -CommandName "jar" `
    -DisplayName "jar"

$apkanalyzer = Resolve-OptionalToolPath `
    -ExplicitPath "" `
    -ProjectPath (Join-Path $projectRoot "out\tools\android-sdk\cmdline-tools\latest\bin\apkanalyzer.bat") `
    -CommandName "apkanalyzer"

$projectJavaHome = Join-Path $projectRoot "out\tools\jdk-17.0.15+6"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutputDir "inspect-$timestamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$pathProbe = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "pm", "path", $PackageName)
$remoteApk = (($pathProbe.output | Select-Object -First 1) -replace "^package:", "").Trim()
if ([string]::IsNullOrWhiteSpace($remoteApk)) {
    throw "没有找到包 $PackageName 的 APK 路径。输出：$($pathProbe.output -join "`n")"
}

$apkPath = Join-Path $runDir "$PackageName-base.apk"
Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("pull", $remoteApk, $apkPath) | Out-Null

# Older aapt builds can fail on non-ASCII paths. Use an ASCII temp path.
$asciiApk = Join-Path ([System.IO.Path]::GetTempPath()) "rokid-aiapp-inspect-$timestamp.apk"
Copy-Item -LiteralPath $apkPath -Destination $asciiApk -Force

$badgingPath = Join-Path $runDir "badging.txt"
$manifestPath = Join-Path $runDir "manifest-xmltree.txt"
$fileListPath = Join-Path $runDir "file-list.txt"
$dexPackagesPath = Join-Path $runDir "dex-packages.txt"

& $aapt dump badging $asciiApk | Set-Content -LiteralPath $badgingPath -Encoding UTF8
& $aapt dump xmltree $asciiApk AndroidManifest.xml | Set-Content -LiteralPath $manifestPath -Encoding UTF8
& $jar tf $asciiApk | Set-Content -LiteralPath $fileListPath -Encoding UTF8

$dexInspectionError = ""
if (-not [string]::IsNullOrWhiteSpace($apkanalyzer)) {
    $oldJavaHome = $env:JAVA_HOME
    $oldPath = $env:Path
    try {
        if (Test-Path -LiteralPath (Join-Path $projectJavaHome "bin\java.exe")) {
            $env:JAVA_HOME = (Resolve-Path -LiteralPath $projectJavaHome).Path
            $env:Path = "$env:JAVA_HOME\bin;$env:Path"
        }
        & $apkanalyzer dex packages $asciiApk | Set-Content -LiteralPath $dexPackagesPath -Encoding UTF8
        if ($LASTEXITCODE -ne 0) {
            $dexInspectionError = "apkanalyzer exited with code $LASTEXITCODE"
        }
    } catch {
        $dexInspectionError = $_.Exception.Message
    } finally {
        $env:JAVA_HOME = $oldJavaHome
        $env:Path = $oldPath
    }
} else {
    $dexInspectionError = "apkanalyzer not found"
}

$badgingText = Get-Content -LiteralPath $badgingPath -Raw
$fileListText = Get-Content -LiteralPath $fileListPath -Raw
$manifestText = Get-Content -LiteralPath $manifestPath -Raw
$dexPackagesText = ""
if (Test-Path -LiteralPath $dexPackagesPath) {
    $dexPackagesText = Get-Content -LiteralPath $dexPackagesPath -Raw
}

$voiceFileMatches = Match-Lines `
    -Path $fileListPath `
    -Pattern "lib/arm64-v8a/.*(asr|speech|tts|voice|audio|rokid|rfm)|assets/(rfmasr|tts|resource/audio|navi/custom_voice)"

$manifestVoiceMatches = Match-Lines `
    -Path $manifestPath `
    -Pattern "asr|tts|speech|voice|audio|chat|externalapp|CXRLink|AiService|service|provider"

$actionMatches = Match-Lines `
    -Path $manifestPath `
    -Pattern "A: android:name.*(ASR|TTS|SPEECH|VOICE|AUDIO|MEDIA_STREAM|AUTHORIZATION|CXR|externalapp)"

$cxrProviderUri = "content://com.rokid.sprite.aiapp.cxrl.provider"
$providerQuery = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "content", "query", "--uri", $cxrProviderUri) -AllowFailure
$providerCallGet = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "content", "call", "--uri", $cxrProviderUri, "--method", "get") -AllowFailure
$providerCallQuery = Invoke-Adb -Adb $adb -DeviceSerial $Serial -AdbArgs @("shell", "content", "call", "--uri", $cxrProviderUri, "--method", "query") -AllowFailure

$manifestActionNames = Extract-ManifestActionNames -Path $manifestPath
$cxrActionMatches = @(
    $manifestActionNames |
        Where-Object { $_.text -match "CXR|MEDIA_STREAM|externalapp\.AUTHORIZATION" }
)
$directVoiceActionMatches = @(
    $manifestActionNames |
        Where-Object {
            $_.text -match "(^|[._])(ASR|TTS|SPEECH|VOICE)([._]|$)" -and
            $_.text -notmatch "MEDIA_STREAM"
        }
)

$summaryPath = Join-Path $runDir "rokid-aiapp-voice-surface-summary.json"
$isPackedByNeteaseNis = [bool]($dexPackagesText -match "com\.netease\.nis\.wrapper")
$dexBusinessPackageVisible = [bool]($dexPackagesText -match "com\.rokid\.sprite\.aiapp")
$dexOnlyWrapper = [bool]($isPackedByNeteaseNis -and -not $dexBusinessPackageVisible)

$summary = [pscustomobject][ordered]@{
    inspectedAt = (Get-Date).ToString("o")
    packageName = $PackageName
    serial = $Serial
    remoteApk = $remoteApk
    apkPath = $apkPath
    badgingPath = $badgingPath
    manifestPath = $manifestPath
    fileListPath = $fileListPath
    dexPackagesPath = $dexPackagesPath
    summaryPath = $summaryPath
    versionCode = Parse-BadgingValue -Text $badgingText -Pattern "versionCode='([^']+)'"
    versionName = Parse-BadgingValue -Text $badgingText -Pattern "versionName='([^']+)'"
    nativeCode = Parse-BadgingValue -Text $badgingText -Pattern "native-code:\s*'([^']+)'"
    hasArm64NativeVoiceAssets = [bool]($fileListText -match "lib/arm64-v8a/librokid_rfm_asr\.so" -and $fileListText -match "assets/rfmasr/" -and $fileListText -match "assets/tts/")
    hasExportedCxrProvider = [bool]($manifestText -match "com\.rokid\.sprite\.aiapp\.external\.CXRLinkProvider" -and $manifestText -match "com\.rokid\.sprite\.aiapp\.cxrl\.provider")
    hasExportedCxrService = [bool]($manifestText -match "com\.rokid\.sprite\.aiapp\.externalapp\.service\.CXRLinkService" -and $manifestText -match "com\.rokid\.sprite\.aiapp\.externalapp\.MEDIA_STREAM_SERVICE")
    hasCxrMediaStreamAction = [bool]($cxrActionMatches | Where-Object { $_.text -match "MEDIA_STREAM_SERVICE" })
    hasDirectVoiceAction = [bool]($directVoiceActionMatches.Count -gt 0)
    hasExportedVoiceAction = [bool]($directVoiceActionMatches.Count -gt 0)
    hasQueryableCxrProviderRows = [bool](($providerQuery.output -join "`n") -notmatch "No result found|Result: null|Error")
    aiServiceExported = if ($manifestText -match "com\.rokid\.sprite\.aiapp\.library_ai\.service\.AiService[\s\S]{0,220}android:exported\(.*\)0x0") { $false } else { $null }
    dexInspection = [ordered]@{
        apkanalyzer = $apkanalyzer
        error = $dexInspectionError
        isPackedByNeteaseNis = $isPackedByNeteaseNis
        dexBusinessPackageVisible = $dexBusinessPackageVisible
        dexOnlyWrapper = $dexOnlyWrapper
        note = "This is a static dex package check only. A packed app may load business code at runtime, so absence of business classes here does not prove the runtime has no internal ASR/TTS implementation."
    }
    liveProviderProbe = [ordered]@{
        uri = $cxrProviderUri
        query = $providerQuery
        callGet = $providerCallGet
        callQuery = $providerCallQuery
        note = "A queryable provider row or call result would be only an IPC surface clue. Current null/empty results do not expose ASR/TTS text."
    }
    voiceFileMatches = @($voiceFileMatches)
    manifestActionNames = @($manifestActionNames)
    cxrActionMatches = @($cxrActionMatches)
    directVoiceActionMatches = @($directVoiceActionMatches)
    rawVoiceNameMatches = @($actionMatches)
    manifestVoiceMatches = @($manifestVoiceMatches)
    conclusion = "Rokid AI App contains arm64 native ASR/TTS assets. Manifest shows CXR external surfaces, but no obvious exported ASR/TTS action; library_ai AiService is not exported. Static dex inspection sees the NetEase NIS wrapper and no visible com.rokid.sprite.aiapp business package, so hidden runtime code cannot be used as a stable public ASR/TTS API."
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Remove-Item -LiteralPath $asciiApk -Force -ErrorAction SilentlyContinue

$summary |
    Select-Object packageName, versionName, nativeCode, hasArm64NativeVoiceAssets, hasExportedCxrProvider, hasExportedCxrService, hasCxrMediaStreamAction, hasDirectVoiceAction, hasQueryableCxrProviderRows, aiServiceExported, @{Name="isPackedByNeteaseNis";Expression={$_.dexInspection.isPackedByNeteaseNis}}, @{Name="dexBusinessPackageVisible";Expression={$_.dexInspection.dexBusinessPackageVisible}}, summaryPath |
    Format-List

Write-Host "Summary: $summaryPath"
