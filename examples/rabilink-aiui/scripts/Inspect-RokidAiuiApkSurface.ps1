param(
  [string] $AdbPath = "",
  [string] $AaptPath = "",
  [string] $ReportPath = "",
  [switch] $SkipPull,
  [switch] $KeepApk
)

$ErrorActionPreference = "Stop"

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Invoke-Text {
  param(
    [string] $FilePath,
    [string[]] $Arguments
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    return @(& $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-PackagePath {
  param(
    [string] $Adb,
    [string] $PackageName
  )
  $line = Invoke-Text -FilePath $Adb -Arguments @("shell", "pm", "path", $PackageName) | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -replace "^package:", "").Trim()
}

function Read-AaptOutput {
  param(
    [string] $Aapt,
    [string] $Apk,
    [string] $Mode
  )
  if ($Mode -eq "badging") {
    return Invoke-Text -FilePath $Aapt -Arguments @("dump", "badging", $Apk)
  }
  return Invoke-Text -FilePath $Aapt -Arguments @("dump", "xmltree", $Apk, "AndroidManifest.xml")
}

function Find-KeywordEntries {
  param(
    [string] $Apk,
    [string] $Pattern
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
  try {
    return @($zip.Entries |
      Where-Object { $_.FullName -match $Pattern } |
      Select-Object -First 500 |
      ForEach-Object {
        [ordered]@{
          path = $_.FullName
          size = $_.Length
        }
      })
  }
  finally {
    $zip.Dispose()
  }
}

function Select-RawValues {
  param(
    [string[]] $Lines,
    [string] $Pattern,
    [int] $Limit = 100
  )
  return @($Lines |
    Select-String -Pattern $Pattern -CaseSensitive:$false |
    Select-Object -First $Limit |
    ForEach-Object { $_.Line.Trim() })
}

function Test-AixIntentSupport {
  param([string[]] $ManifestLines)
  $text = $ManifestLines -join "`n"
  return [bool]($text -match "\.aix|application/x-aix|rokid.*aix|aiui.*package|aix.*package")
}

function New-PackageReport {
  param(
    [string] $PackageName,
    [string] $DeviceApkPath,
    [string] $LocalApkPath,
    [string] $BadgingPath,
    [string] $ManifestPath,
    [string[]] $Badging,
    [string[]] $Manifest,
    [object[]] $KeywordEntries
  )
  $manifestText = $Manifest -join "`n"
  $versionMatch = [regex]::Match(($Badging -join "`n"), "versionName='([^']+)'")
  return [ordered]@{
    package = $PackageName
    installed = $true
    device_apk_path = $DeviceApkPath
    local_apk_path = $LocalApkPath
    badging_path = $BadgingPath
    manifest_path = $ManifestPath
    version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { "" }
    supports_public_aix_file_intent = Test-AixIntentSupport -ManifestLines $Manifest
    has_ecology_agent_deeplink = [bool]($manifestText -match "ecology" -and $manifestText -match "agent")
    has_rokid_aiapp_deeplink = [bool]($manifestText -match 'android:scheme.*"rokid"' -and $manifestText -match 'android:host.*"aiapp"')
    has_external_proxy_gateway = [bool]($manifestText -match "ProxyGatewayService|CXRLinkProvider|CXRLinkService")
    deep_link_lines = Select-RawValues -Lines $Manifest -Pattern "android:scheme|android:host|android:path|android:pathPrefix|android:mimeType|android:name.*(VIEW|BROWSABLE|ecology|rokid|rokidai|agent)"
    exported_surface_lines = Select-RawValues -Lines $Manifest -Pattern "android:name.*(agentStore|AgentStore|AgentManage|AgentSearch|DialogFlow|MainActivity|ProxyGateway|CXRLink|Authorization)|android:exported"
    aix_or_aiui_lines = Select-RawValues -Lines $Manifest -Pattern "aix|aiui|application/|mimeType" -Limit 50
    keyword_entries = $KeywordEntries
  }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$repoRoot = Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..")
if (-not $AdbPath) {
  $AdbPath = Join-Path $repoRoot "examples\android-rabi-link-probe\out\tools\android-sdk\platform-tools\adb.exe"
}
if (-not $AaptPath) {
  $AaptPath = Join-Path $repoRoot "examples\android-rabi-link-probe\out\tools\android-sdk\build-tools\34.0.0\aapt.exe"
}
if (-not $ReportPath) {
  $ReportPath = Join-Path $projectRoot "dist\apk-inspect\rokid-aiui-apk-surface.json"
}

$resolvedAdbPath = Resolve-OptionalPath $AdbPath
$resolvedAaptPath = Resolve-OptionalPath $AaptPath
$resolvedReportPath = Resolve-OptionalPath $ReportPath
$reportDir = Split-Path -Parent $resolvedReportPath
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}
if (-not (Test-Path -LiteralPath $resolvedAdbPath)) { throw "adb not found: $resolvedAdbPath" }
if (-not (Test-Path -LiteralPath $resolvedAaptPath)) { throw "aapt not found: $resolvedAaptPath" }

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rabilink-aiui-apk-inspect-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  $packageReports = New-Object System.Collections.Generic.List[object]
  foreach ($packageName in @("com.rokid.sprite.aiapp", "com.weiyi.sprite")) {
    $deviceApkPath = Get-PackagePath -Adb $resolvedAdbPath -PackageName $packageName
    if (-not $deviceApkPath) {
      $packageReports.Add([ordered]@{ package = $packageName; installed = $false })
      continue
    }

    $localApkPath = Join-Path $reportDir "$packageName.base.apk"
    if (-not $SkipPull -or -not (Test-Path -LiteralPath $localApkPath)) {
      Invoke-Text -FilePath $resolvedAdbPath -Arguments @("pull", $deviceApkPath, $localApkPath) | Out-Null
    }
    $asciiApkPath = Join-Path $tempDir "$packageName.apk"
    Copy-Item -LiteralPath $localApkPath -Destination $asciiApkPath -Force

    $badging = Read-AaptOutput -Aapt $resolvedAaptPath -Apk $asciiApkPath -Mode "badging"
    $manifest = Read-AaptOutput -Aapt $resolvedAaptPath -Apk $asciiApkPath -Mode "manifest"
    $badgingPath = Join-Path $reportDir "$packageName.badging.txt"
    $manifestPath = Join-Path $reportDir "$packageName.manifest.xmltree.txt"
    $badging | Set-Content -LiteralPath $badgingPath -Encoding UTF8
    $manifest | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    $keywordEntries = Find-KeywordEntries -Apk $localApkPath -Pattern "(?i)(aix|aiui|agent|ecology|rokidai|craft|plugin|mini|jsui)"

    $packageReports.Add((New-PackageReport `
      -PackageName $packageName `
      -DeviceApkPath $deviceApkPath `
      -LocalApkPath $localApkPath `
      -BadgingPath $badgingPath `
      -ManifestPath $manifestPath `
      -Badging $badging `
      -Manifest $manifest `
      -KeywordEntries $keywordEntries))

    if (-not $KeepApk -and (Test-Path -LiteralPath $localApkPath)) {
      Remove-Item -LiteralPath $localApkPath -Force
    }
  }

  $rokidPackage = $packageReports | Where-Object { $_.package -eq "com.rokid.sprite.aiapp" } | Select-Object -First 1
  $reportPayload = [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    adb = $resolvedAdbPath
    aapt = $resolvedAaptPath
    packages = $packageReports
    conclusion = [ordered]@{
      public_aix_file_handler_detected = [bool]$rokidPackage.supports_public_aix_file_intent
      craft_or_store_sync_required = -not [bool]$rokidPackage.supports_public_aix_file_intent
      has_rokid_aiapp_main_deeplink = [bool]$rokidPackage.has_rokid_aiapp_deeplink
      has_ecology_agent_deeplink = [bool]$rokidPackage.has_ecology_agent_deeplink
      has_external_proxy_gateway = [bool]$rokidPackage.has_external_proxy_gateway
      interpretation = "The installed Rokid AI app exposes app/store/deeplink surfaces, but no public .aix/AIUI local package import intent was found. Craft/AIUI Studio or account store sync remains the install path."
    }
  }
  $reportPayload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resolvedReportPath -Encoding UTF8
  Write-Output ("Wrote APK surface report: {0}" -f $resolvedReportPath)
  Write-Output ("Public AIX file handler detected: {0}" -f $reportPayload.conclusion.public_aix_file_handler_detected)
  Write-Output ("Craft/store sync required: {0}" -f $reportPayload.conclusion.craft_or_store_sync_required)
}
finally {
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  }
}
