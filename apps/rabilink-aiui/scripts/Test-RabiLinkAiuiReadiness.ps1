param(
  [string] $AixPath = "",
  [string] $AdbPath = "",
  [string] $CraftStagingPath = "",
  [string] $DeliveryPath = "",
  [string] $PhoneInstallSurfacePath = "",
  [string] $ApkSurfacePath = "",
  [string] $CraftUploadStatusPath = "",
  [string] $RuntimeProofStatusPath = "",
  [string] $RealGlassesStatusPath = "",
  [string] $DeviceStatusE2ePath = "",
  [string] $ExpectedRelayBaseUrl = "",
  [int] $DeviceEvidenceMaxAgeMinutes = 10,
  [int] $RuntimeProofMaxAgeMinutes = 20,
  [switch] $RequireCraftStaging,
  [switch] $RequireDelivery,
  [switch] $RequirePhoneInstallSurface,
  [switch] $RequireCraftUploadStatus,
  [switch] $RequireRuntimeProof,
  [switch] $RequireRokidCompanionApp,
  [switch] $RequireGlass
)

$ErrorActionPreference = "Stop"

function Write-Check {
  param(
    [string] $Name,
    [bool] $Ok,
    [string] $Detail = ""
  )
  $status = if ($Ok) { "OK" } else { "MISSING" }
  if ($Detail) {
    Write-Output ("[{0}] {1}: {2}" -f $status, $Name, $Detail)
  } else {
    Write-Output ("[{0}] {1}" -f $status, $Name)
  }
}

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Get-Sha256Hex {
  param([string] $PathValue)
  $stream = [System.IO.File]::OpenRead($PathValue)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
    }
    finally {
      $sha.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Read-AixVersion {
  param([string] $PathValue)

  Add-Type -AssemblyName System.IO.Compression
  $stream = [System.IO.File]::OpenRead($PathValue)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
      $entry = $archive.GetEntry("VERSION")
      if ($null -eq $entry) { return "" }
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { return $reader.ReadToEnd().Trim() }
      finally { $reader.Dispose() }
    }
    finally { $archive.Dispose() }
  }
  finally { $stream.Dispose() }
}

function Read-TextTree {
  param([string] $Root)

  return Get-ChildItem -LiteralPath $Root -Recurse -File |
    Where-Object { $_.Extension -in @(".js", ".json", ".wxml", ".wxss", ".md", ".ink", "") } |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }
}

function Normalize-RelayUrl {
  param([string] $Value)
  if (-not $Value) { return "" }
  return $Value.Trim().TrimEnd("/")
}

function Convert-ToEvidenceTimestamp {
  param([object] $Value)
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  try {
    return [System.DateTimeOffset]::Parse(
      [string]$Value,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal
    )
  }
  catch {
    return $null
  }
}

function Read-RelayDefaults {
  param([string] $Root)

  $defaultsPath = Join-Path $Root "utils\rabilink-defaults.js"
  $bundledPagePath = Join-Path $Root "pages\home\index.js"
  $appJsonPath = Join-Path $Root "app.json"
  $defaultsRelayUrl = ""
  $appJsonRelayUrl = ""
  $appJsonToken = ""

  if (Test-Path -LiteralPath $defaultsPath) {
    $defaultsText = Get-Content -LiteralPath $defaultsPath -Raw
    $match = [regex]::Match($defaultsText, 'relayBaseUrl:\s*"([^"]*)"')
    if ($match.Success) {
      $defaultsRelayUrl = $match.Groups[1].Value
    }
  } elseif (Test-Path -LiteralPath $bundledPagePath) {
    $bundledText = Get-Content -LiteralPath $bundledPagePath -Raw
    $match = [regex]::Match($bundledText, 'rabiLinkDefaults\s*=\s*\{[\s\S]*?relayBaseUrl:\s*"([^"]*)"')
    if ($match.Success) {
      $defaultsRelayUrl = $match.Groups[1].Value
    }
  }

  if (Test-Path -LiteralPath $appJsonPath) {
    $appJson = Get-Content -LiteralPath $appJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($appJson.rabiLink) {
      $appJsonRelayUrl = [string]$appJson.rabiLink.relayBaseUrl
      $appJsonToken = [string]$appJson.rabiLink.token
    }
  }

  return [pscustomobject]@{
    DefaultsRelayUrl = Normalize-RelayUrl $defaultsRelayUrl
    AppJsonRelayUrl = Normalize-RelayUrl $appJsonRelayUrl
    AppJsonToken = $appJsonToken
  }
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$repoRoot = Resolve-Path -LiteralPath (Join-Path $projectRoot "..\..")

if (-not $AixPath) {
  $AixPath = Join-Path $projectRoot "dist\rabilink-aiui.aix"
}
$resolvedAixPath = Resolve-OptionalPath $AixPath

if (-not $AdbPath) {
  $AdbPath = Join-Path $repoRoot "apps\rabilink-android\out\tools\android-sdk\platform-tools\adb.exe"
}
$resolvedAdbPath = Resolve-OptionalPath $AdbPath

if (-not $CraftStagingPath) {
  $CraftStagingPath = Join-Path $projectRoot "dist\craft-upload"
}
$resolvedCraftStagingPath = Resolve-OptionalPath $CraftStagingPath
if (-not $DeliveryPath) {
  $DeliveryPath = Join-Path $projectRoot "dist\delivery"
}
$resolvedDeliveryPath = Resolve-OptionalPath $DeliveryPath
if (-not $PhoneInstallSurfacePath) {
  $PhoneInstallSurfacePath = Join-Path $projectRoot "dist\phone-install-surface.json"
}
$resolvedPhoneInstallSurfacePath = Resolve-OptionalPath $PhoneInstallSurfacePath
if (-not $ApkSurfacePath) {
  $ApkSurfacePath = Join-Path $projectRoot "dist\apk-inspect\rokid-aiui-apk-surface.json"
}
$resolvedApkSurfacePath = Resolve-OptionalPath $ApkSurfacePath
if (-not $CraftUploadStatusPath) {
  $CraftUploadStatusPath = Join-Path $projectRoot "dist\craft-upload-status.json"
}
$resolvedCraftUploadStatusPath = Resolve-OptionalPath $CraftUploadStatusPath
if (-not $RuntimeProofStatusPath) {
  $RuntimeProofStatusPath = Join-Path $projectRoot "dist\runtime-proof-status.json"
}
$resolvedRuntimeProofStatusPath = Resolve-OptionalPath $RuntimeProofStatusPath
if (-not $RealGlassesStatusPath) {
  $RealGlassesStatusPath = Join-Path $projectRoot "dist\real-glasses-device-status.json"
}
$resolvedRealGlassesStatusPath = Resolve-OptionalPath $RealGlassesStatusPath
if (-not $DeviceStatusE2ePath) {
  $DeviceStatusE2ePath = Join-Path $projectRoot "dist\device-status-e2e.json"
}
$resolvedDeviceStatusE2ePath = Resolve-OptionalPath $DeviceStatusE2ePath
$normalizedExpectedRelayBaseUrl = Normalize-RelayUrl $ExpectedRelayBaseUrl

$failures = New-Object System.Collections.Generic.List[string]

$craftUploadScriptPath = Join-Path $projectRoot "scripts\Invoke-RabiLinkAiuiCraftUpload.ps1"
$craftUploadScriptExists = Test-Path -LiteralPath $craftUploadScriptPath
Write-Check "Craft API upload helper script" $craftUploadScriptExists $craftUploadScriptPath
if (-not $craftUploadScriptExists) {
  $failures.Add("Craft API upload helper script is missing.")
}
$craftMetadataScriptPath = Join-Path $projectRoot "scripts\RabiLinkAiuiCraftMetadata.ps1"
$craftMetadataScriptExists = Test-Path -LiteralPath $craftMetadataScriptPath
Write-Check "Craft AIX metadata helper script" $craftMetadataScriptExists $craftMetadataScriptPath
if (-not $craftMetadataScriptExists) {
  $failures.Add("Craft AIX metadata helper script is missing.")
}
$craftReleasePath = Join-Path $projectRoot "craft-release.json"
$craftReleaseExists = Test-Path -LiteralPath $craftReleasePath
Write-Check "Craft release metadata" $craftReleaseExists $craftReleasePath
if (-not $craftReleaseExists) {
  $failures.Add("Craft release metadata is missing.")
}
$currentCraftReleaseVersion = if ($craftReleaseExists) {
  [string](Get-Content -LiteralPath $craftReleasePath -Raw -Encoding UTF8 | ConvertFrom-Json).version
} else {
  ""
}
$craftBrowserUploadHelperPath = Join-Path $projectRoot "scripts\craft-browser-upload-helper.js"
$craftBrowserUploadHelperExists = Test-Path -LiteralPath $craftBrowserUploadHelperPath
Write-Check "Craft browser upload helper script" $craftBrowserUploadHelperExists $craftBrowserUploadHelperPath
if (-not $craftBrowserUploadHelperExists) {
  $failures.Add("Craft browser upload helper script is missing.")
}
$craftEmbeddedBrowserUploadTemplatePath = Join-Path $projectRoot "scripts\craft-browser-embedded-aix-upload-helper.template.js"
$craftEmbeddedBrowserUploadTemplateExists = Test-Path -LiteralPath $craftEmbeddedBrowserUploadTemplatePath
Write-Check "Craft embedded browser upload helper template" $craftEmbeddedBrowserUploadTemplateExists $craftEmbeddedBrowserUploadTemplatePath
if (-not $craftEmbeddedBrowserUploadTemplateExists) {
  $failures.Add("Craft embedded browser upload helper template is missing.")
}
$craftBrowserReportImportScriptPath = Join-Path $projectRoot "scripts\Import-RabiLinkAiuiBrowserCraftReport.ps1"
$craftBrowserReportImportScriptExists = Test-Path -LiteralPath $craftBrowserReportImportScriptPath
Write-Check "Craft browser report import helper script" $craftBrowserReportImportScriptExists $craftBrowserReportImportScriptPath
if (-not $craftBrowserReportImportScriptExists) {
  $failures.Add("Craft browser report import helper script is missing.")
}
$craftBrowserHelperLauncherPath = Join-Path $projectRoot "scripts\Open-RabiLinkAiuiCraftUploadHelper.ps1"
$craftBrowserHelperLauncherExists = Test-Path -LiteralPath $craftBrowserHelperLauncherPath
Write-Check "Craft browser helper launcher script" $craftBrowserHelperLauncherExists $craftBrowserHelperLauncherPath
if (-not $craftBrowserHelperLauncherExists) {
  $failures.Add("Craft browser helper launcher script is missing.")
}
$craftEmbeddedBrowserHelperLauncherPath = Join-Path $projectRoot "scripts\Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1"
$craftEmbeddedBrowserHelperLauncherExists = Test-Path -LiteralPath $craftEmbeddedBrowserHelperLauncherPath
Write-Check "Craft embedded browser helper launcher script" $craftEmbeddedBrowserHelperLauncherExists $craftEmbeddedBrowserHelperLauncherPath
if (-not $craftEmbeddedBrowserHelperLauncherExists) {
  $failures.Add("Craft embedded browser helper launcher script is missing.")
}
$craftBrowserReportWatchScriptPath = Join-Path $projectRoot "scripts\Wait-RabiLinkAiuiBrowserCraftReport.ps1"
$craftBrowserReportWatchScriptExists = Test-Path -LiteralPath $craftBrowserReportWatchScriptPath
Write-Check "Craft browser report watch helper script" $craftBrowserReportWatchScriptExists $craftBrowserReportWatchScriptPath
if (-not $craftBrowserReportWatchScriptExists) {
  $failures.Add("Craft browser report watch helper script is missing.")
}
$craftStatusScriptPath = Join-Path $projectRoot "scripts\Test-RabiLinkAiuiCraftStatus.ps1"
$craftStatusScriptExists = Test-Path -LiteralPath $craftStatusScriptPath
Write-Check "Craft status helper script" $craftStatusScriptExists $craftStatusScriptPath
if (-not $craftStatusScriptExists) {
  $failures.Add("Craft status helper script is missing.")
}
$goalEvidenceScriptPath = Join-Path $projectRoot "scripts\Test-RabiLinkAiuiGoalEvidence.ps1"
$goalEvidenceScriptExists = Test-Path -LiteralPath $goalEvidenceScriptPath
Write-Check "goal evidence helper script" $goalEvidenceScriptExists $goalEvidenceScriptPath
if (-not $goalEvidenceScriptExists) {
  $failures.Add("Goal evidence helper script is missing.")
}
$apkSurfaceScriptPath = Join-Path $projectRoot "scripts\Inspect-RokidAiuiApkSurface.ps1"
$apkSurfaceScriptExists = Test-Path -LiteralPath $apkSurfaceScriptPath
Write-Check "APK surface helper script" $apkSurfaceScriptExists $apkSurfaceScriptPath
if (-not $apkSurfaceScriptExists) {
  $failures.Add("APK surface helper script is missing.")
}
$runtimeProofScriptPath = Join-Path $projectRoot "scripts\Test-RabiLinkAiuiRuntimeProof.ps1"
$runtimeProofScriptExists = Test-Path -LiteralPath $runtimeProofScriptPath
Write-Check "runtime proof helper script" $runtimeProofScriptExists $runtimeProofScriptPath
if (-not $runtimeProofScriptExists) {
  $failures.Add("Runtime proof helper script is missing.")
}

if (-not (Test-Path -LiteralPath $resolvedAixPath)) {
  Write-Check "AIX package" $false $resolvedAixPath
  $failures.Add("AIX package is missing.")
} else {
  $aixInfo = Get-Item -LiteralPath $resolvedAixPath
  Write-Check "AIX package" $true ("{0} bytes at {1}" -f $aixInfo.Length, $aixInfo.FullName)
}

$aixPackageVersion = ""
$craftPackageVersion = ""
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rabilink-aiui-readiness-" + [System.Guid]::NewGuid().ToString("N"))
try {
  if (Test-Path -LiteralPath $resolvedAixPath) {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $tempZipPath = Join-Path ([System.IO.Path]::GetTempPath()) ("rabilink-aiui-readiness-" + [System.Guid]::NewGuid().ToString("N") + ".zip")
    try {
      Copy-Item -LiteralPath $resolvedAixPath -Destination $tempZipPath -Force
      Expand-Archive -LiteralPath $tempZipPath -DestinationPath $tempRoot -Force
    }
    finally {
      if (Test-Path -LiteralPath $tempZipPath) {
        Remove-Item -LiteralPath $tempZipPath -Force
      }
    }

    $requiredFiles = @(
      ".aixignore",
      "AGENTS.md",
      "app.js",
      "app.json",
      "pages/home/index.js",
      "pages/home/index.json",
      "pages/home/index.wxml",
      "pages/home/index.wxss",
      "VERSION"
    )
    foreach ($relative in $requiredFiles) {
      $exists = Test-Path -LiteralPath (Join-Path $tempRoot $relative)
      Write-Check ("package file " + $relative) $exists
      if (-not $exists) { $failures.Add("Package is missing $relative.") }
    }

    $aixVersionPath = Join-Path $tempRoot "VERSION"
    if (Test-Path -LiteralPath $aixVersionPath) {
      $aixPackageVersion = (Get-Content -LiteralPath $aixVersionPath -Raw -Encoding UTF8).Trim()
      $aixVersionValid = $aixPackageVersion -match '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      Write-Check "AIX VERSION UUIDv4" $aixVersionValid $aixPackageVersion
      if (-not $aixVersionValid) { $failures.Add("AIX VERSION is not UUIDv4.") }
    }

    $sourceOnlyFiles = @(
      "README.md",
      "pages/home/index.ink",
      "package.json",
    "scripts/check-rabilink-aiui.mjs",
    "scripts/Build-RabiLinkAiuiPackage.mjs",
    "scripts/Write-DeterministicZip.mjs"
  )
    foreach ($relative in $sourceOnlyFiles) {
      $exists = Test-Path -LiteralPath (Join-Path $tempRoot $relative)
      Write-Check ("source-only excluded " + $relative) (-not $exists)
      if ($exists) { $failures.Add("Package should not include $relative.") }
    }

    $allText = Read-TextTree $tempRoot
    $tokenPattern = "rbl_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}"
    $hasToken = [bool](($allText -join "`n") -match $tokenPattern)
    Write-Check "no real token pattern in package" (-not $hasToken)
    if ($hasToken) { $failures.Add("Package appears to contain a real token-like secret.") }

    if ($normalizedExpectedRelayBaseUrl) {
      $packageRelay = Read-RelayDefaults $tempRoot
      $defaultsMatch = $packageRelay.DefaultsRelayUrl -eq $normalizedExpectedRelayBaseUrl
      $appJsonMatch = $packageRelay.AppJsonRelayUrl -eq $normalizedExpectedRelayBaseUrl
      $tokenEmpty = -not $packageRelay.AppJsonToken
      Write-Check "package relay default" $defaultsMatch $packageRelay.DefaultsRelayUrl
      Write-Check "package app.json relay default" $appJsonMatch $packageRelay.AppJsonRelayUrl
      Write-Check "package app.json token empty" $tokenEmpty
      if (-not $defaultsMatch) { $failures.Add("Package utils/rabilink-defaults.js does not use expected Relay URL.") }
      if (-not $appJsonMatch) { $failures.Add("Package app.json does not use expected Relay URL.") }
      if (-not $tokenEmpty) { $failures.Add("Package app.json should not include a token.") }
    }
  }
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}

if (Test-Path -LiteralPath $resolvedCraftStagingPath) {
  Write-Check "Craft upload folder" $true $resolvedCraftStagingPath

    $requiredCraftFiles = @(
      ".aixignore",
      "AGENTS.md",
      "app.js",
      "app.json",
      "README.md",
      "pages/home/index.js",
      "pages/home/index.json",
      "pages/home/index.wxml",
      "pages/home/index.wxss",
      "VERSION"
  )
  foreach ($relative in $requiredCraftFiles) {
    $exists = Test-Path -LiteralPath (Join-Path $resolvedCraftStagingPath $relative)
    Write-Check ("Craft file " + $relative) $exists
    if (-not $exists) { $failures.Add("Craft upload folder is missing $relative.") }
  }

  $craftVersionPath = Join-Path $resolvedCraftStagingPath "VERSION"
  if (Test-Path -LiteralPath $craftVersionPath) {
    $craftPackageVersion = (Get-Content -LiteralPath $craftVersionPath -Raw -Encoding UTF8).Trim()
    $craftVersionValid = $craftPackageVersion -match '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    Write-Check "Craft VERSION UUIDv4" $craftVersionValid $craftPackageVersion
    if (-not $craftVersionValid) { $failures.Add("Craft upload VERSION is not UUIDv4.") }
    if ($aixPackageVersion) {
      $packageVersionsMatch = $aixPackageVersion -eq $craftPackageVersion
      Write-Check "AIX and Craft VERSION match" $packageVersionsMatch $craftPackageVersion
      if (-not $packageVersionsMatch) { $failures.Add("AIX and Craft upload folder VERSION values do not match.") }
    }
  }

  $forbiddenCraftPaths = @(
    "dist",
    "scripts",
    "node_modules",
    "package.json",
    "package-lock.json",
    "pages\home\index.ink",
    "utils"
  )
  foreach ($relative in $forbiddenCraftPaths) {
    $exists = Test-Path -LiteralPath (Join-Path $resolvedCraftStagingPath $relative)
    Write-Check ("Craft excludes " + $relative) (-not $exists)
    if ($exists) { $failures.Add("Craft upload folder should not include $relative.") }
  }

  $craftText = Read-TextTree $resolvedCraftStagingPath
  $craftHasToken = [bool](($craftText -join "`n") -match $tokenPattern)
  Write-Check "no real token pattern in Craft upload folder" (-not $craftHasToken)
  if ($craftHasToken) { $failures.Add("Craft upload folder appears to contain a real token-like secret.") }

  if ($normalizedExpectedRelayBaseUrl) {
    $craftRelay = Read-RelayDefaults $resolvedCraftStagingPath
    $defaultsMatch = $craftRelay.DefaultsRelayUrl -eq $normalizedExpectedRelayBaseUrl
    $appJsonMatch = $craftRelay.AppJsonRelayUrl -eq $normalizedExpectedRelayBaseUrl
    $tokenEmpty = -not $craftRelay.AppJsonToken
    Write-Check "Craft relay default" $defaultsMatch $craftRelay.DefaultsRelayUrl
    Write-Check "Craft app.json relay default" $appJsonMatch $craftRelay.AppJsonRelayUrl
    Write-Check "Craft app.json token empty" $tokenEmpty
    if (-not $defaultsMatch) { $failures.Add("Craft upload utils/rabilink-defaults.js does not use expected Relay URL.") }
    if (-not $appJsonMatch) { $failures.Add("Craft upload app.json does not use expected Relay URL.") }
    if (-not $tokenEmpty) { $failures.Add("Craft upload app.json should not include a token.") }
  }
} else {
  Write-Check "Craft upload folder" $false $resolvedCraftStagingPath
  if ($RequireCraftStaging) {
    $failures.Add("Craft upload folder is missing.")
  }
}

if (Test-Path -LiteralPath $resolvedDeliveryPath) {
  Write-Check "delivery folder" $true $resolvedDeliveryPath
  $deliveryAixPath = Join-Path $resolvedDeliveryPath "rabilink-aiui.aix"
  $deliveryManifestPath = Join-Path $resolvedDeliveryPath "install-manifest.json"
  $deliveryReadmePath = Join-Path $resolvedDeliveryPath "README-install.txt"
  $deliveryCraftPath = Join-Path $resolvedDeliveryPath "craft-upload"

  foreach ($relative in @(
    "rabilink-aiui.aix",
    "craft-release.json",
    "install-manifest.json",
    "README-install.txt",
    "craft-upload",
    "scripts\Invoke-RabiLinkAiuiCraftUpload.ps1",
    "scripts\RabiLinkAiuiCraftMetadata.ps1",
    "scripts\craft-browser-upload-helper.js",
    "scripts\craft-browser-embedded-aix-upload-helper.template.js",
    "scripts\Import-RabiLinkAiuiBrowserCraftReport.ps1",
    "scripts\Open-RabiLinkAiuiCraftUploadHelper.ps1",
    "scripts\Open-RabiLinkAiuiCraftEmbeddedUploadHelper.ps1",
    "scripts\Wait-RabiLinkAiuiBrowserCraftReport.ps1",
    "scripts\Test-RabiLinkAiuiCraftStatus.ps1",
    "scripts\Test-RabiLinkAiuiGoalEvidence.ps1",
    "scripts\Inspect-RokidAiuiApkSurface.ps1",
    "scripts\Test-RabiLinkAiuiRuntimeProof.ps1"
  )) {
    $exists = Test-Path -LiteralPath (Join-Path $resolvedDeliveryPath $relative)
    Write-Check ("delivery item " + $relative) $exists
    if (-not $exists) { $failures.Add("Delivery folder is missing $relative.") }
  }

  if ((Test-Path -LiteralPath $deliveryAixPath) -and (Test-Path -LiteralPath $deliveryManifestPath)) {
    $deliveryAixInfo = Get-Item -LiteralPath $deliveryAixPath
    $deliveryHash = Get-Sha256Hex $deliveryAixPath
    $deliveryAixVersion = Read-AixVersion -PathValue $deliveryAixPath
    $deliveryCraftVersionPath = Join-Path $deliveryCraftPath "VERSION"
    $deliveryCraftVersion = if (Test-Path -LiteralPath $deliveryCraftVersionPath) {
      (Get-Content -LiteralPath $deliveryCraftVersionPath -Raw -Encoding UTF8).Trim()
    } else { "" }
    $manifest = Get-Content -LiteralPath $deliveryManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestSizeMatch = [int64]$manifest.aix.size -eq [int64]$deliveryAixInfo.Length
    $manifestHashMatch = [string]$manifest.aix.sha256 -eq $deliveryHash
    Write-Check "delivery manifest AIX size" $manifestSizeMatch ([string]$manifest.aix.size)
    Write-Check "delivery manifest AIX sha256" $manifestHashMatch ([string]$manifest.aix.sha256)
    if (-not $manifestSizeMatch) { $failures.Add("Delivery manifest AIX size does not match the file.") }
    if (-not $manifestHashMatch) { $failures.Add("Delivery manifest AIX sha256 does not match the file.") }

    $deliveryVersionsMatch = [bool]$deliveryAixVersion `
      -and $deliveryAixVersion -eq $deliveryCraftVersion `
      -and $deliveryAixVersion -eq [string]$manifest.aix.version `
      -and $deliveryAixVersion -eq [string]$manifest.craft_upload.version
    Write-Check "delivery AIX/Craft/manifest VERSION" $deliveryVersionsMatch $deliveryAixVersion
    if (-not $deliveryVersionsMatch) { $failures.Add("Delivery AIX, Craft folder and manifest VERSION values do not match.") }
    if ($aixPackageVersion) {
      $deliveryMatchesPrimary = $deliveryAixVersion -eq $aixPackageVersion -and $deliveryHash -eq (Get-Sha256Hex $resolvedAixPath)
      Write-Check "delivery AIX matches primary package" $deliveryMatchesPrimary $deliveryAixVersion
      if (-not $deliveryMatchesPrimary) { $failures.Add("Delivery AIX does not match the primary package.") }
    }

    if ($normalizedExpectedRelayBaseUrl) {
      $manifestRelay = Normalize-RelayUrl ([string]$manifest.relay_base_url)
      $manifestRelayMatch = $manifestRelay -eq $normalizedExpectedRelayBaseUrl
      Write-Check "delivery manifest relay default" $manifestRelayMatch $manifestRelay
      if (-not $manifestRelayMatch) { $failures.Add("Delivery manifest does not use expected Relay URL.") }
    }

    $manifestHasCraftApiUpload = $manifest.PSObject.Properties.Name -contains "craft_api_upload"
    Write-Check "delivery manifest Craft API upload metadata" $manifestHasCraftApiUpload
    if (-not $manifestHasCraftApiUpload) {
      $failures.Add("Delivery manifest is missing Craft API upload metadata.")
    }
    if ($manifestHasCraftApiUpload) {
      $manifestHasMetadataHelper = $manifest.craft_api_upload.PSObject.Properties.Name -contains "metadata_helper"
      Write-Check "delivery manifest Craft AIX metadata helper" $manifestHasMetadataHelper
      if (-not $manifestHasMetadataHelper) {
        $failures.Add("Delivery manifest is missing Craft AIX metadata helper metadata.")
      }
      $manifestHasBrowserHelper = $manifest.craft_api_upload.PSObject.Properties.Name -contains "browser_helper"
      Write-Check "delivery manifest Craft browser upload helper metadata" $manifestHasBrowserHelper
      if (-not $manifestHasBrowserHelper) {
        $failures.Add("Delivery manifest is missing Craft browser upload helper metadata.")
      }
      $manifestHasEmbeddedBrowserHelper = $manifest.craft_api_upload.PSObject.Properties.Name -contains "embedded_browser_helper_template"
      Write-Check "delivery manifest Craft embedded browser helper metadata" $manifestHasEmbeddedBrowserHelper
      if (-not $manifestHasEmbeddedBrowserHelper) {
        $failures.Add("Delivery manifest is missing Craft embedded browser helper metadata.")
      }
      $manifestHasBrowserReportImportHelper = $manifest.craft_api_upload.PSObject.Properties.Name -contains "browser_report_import_helper"
      Write-Check "delivery manifest Craft browser report import helper metadata" $manifestHasBrowserReportImportHelper
      if (-not $manifestHasBrowserReportImportHelper) {
        $failures.Add("Delivery manifest is missing Craft browser report import helper metadata.")
      }
      $manifestHasBrowserReportWatchHelper = $manifest.craft_api_upload.PSObject.Properties.Name -contains "browser_report_watch_helper"
      Write-Check "delivery manifest Craft browser report watch helper metadata" $manifestHasBrowserReportWatchHelper
      if (-not $manifestHasBrowserReportWatchHelper) {
        $failures.Add("Delivery manifest is missing Craft browser report watch helper metadata.")
      }
      $manifestHasBrowserHelperLauncher = $manifest.craft_api_upload.PSObject.Properties.Name -contains "browser_helper_launcher"
      Write-Check "delivery manifest Craft browser helper launcher metadata" $manifestHasBrowserHelperLauncher
      if (-not $manifestHasBrowserHelperLauncher) {
        $failures.Add("Delivery manifest is missing Craft browser helper launcher metadata.")
      }
      $manifestHasEmbeddedBrowserHelperLauncher = $manifest.craft_api_upload.PSObject.Properties.Name -contains "embedded_browser_helper_launcher"
      Write-Check "delivery manifest Craft embedded browser helper launcher metadata" $manifestHasEmbeddedBrowserHelperLauncher
      if (-not $manifestHasEmbeddedBrowserHelperLauncher) {
        $failures.Add("Delivery manifest is missing Craft embedded browser helper launcher metadata.")
      }
    }
    $manifestHasCraftRelease = $manifest.PSObject.Properties.Name -contains "craft_release"
    Write-Check "delivery manifest Craft release metadata" $manifestHasCraftRelease
    if (-not $manifestHasCraftRelease) {
      $failures.Add("Delivery manifest is missing Craft release metadata.")
    }
    $manifestHasRuntimeProof = $manifest.PSObject.Properties.Name -contains "runtime_proof"
    Write-Check "delivery manifest runtime proof metadata" $manifestHasRuntimeProof
    if (-not $manifestHasRuntimeProof) {
      $failures.Add("Delivery manifest is missing runtime proof metadata.")
    }
  }

  if (Test-Path -LiteralPath $deliveryCraftPath) {
    $deliveryCraftFiles = @(Get-ChildItem -LiteralPath $deliveryCraftPath -Recurse -File)
    Write-Check "delivery Craft file count" ($deliveryCraftFiles.Count -ge 10) ([string]$deliveryCraftFiles.Count)
    if ($deliveryCraftFiles.Count -lt 10) { $failures.Add("Delivery Craft folder has too few files.") }
  }

  if ((Test-Path -LiteralPath $deliveryReadmePath) -and (Test-Path -LiteralPath $deliveryAixPath)) {
    $deliveryReadme = Get-Content -LiteralPath $deliveryReadmePath -Raw
    $readmeMentionsHash = $deliveryReadme -match [regex]::Escape((Get-Sha256Hex $deliveryAixPath))
    Write-Check "delivery README includes AIX hash" $readmeMentionsHash
    if (-not $readmeMentionsHash) { $failures.Add("Delivery README does not include the current AIX hash.") }
  }
} else {
  Write-Check "delivery folder" $false $resolvedDeliveryPath
  if ($RequireDelivery) {
    $failures.Add("Delivery folder is missing.")
  }
}

if (Test-Path -LiteralPath $resolvedCraftUploadStatusPath) {
  Write-Check "Craft upload status report" $true $resolvedCraftUploadStatusPath
  $craftStatus = Get-Content -LiteralPath $resolvedCraftUploadStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $craftStatusMatched = [bool]$craftStatus.matched
  $craftStatusHasToken = [bool]$craftStatus.account_token_present
  $craftStatusHasBrowserSession = [bool]$craftStatus.browser_session_present
  $craftStatusHasCredentialOrSession = $craftStatusHasToken -or $craftStatusHasBrowserSession
  Write-Check "Craft status account token or browser session was present" $craftStatusHasCredentialOrSession
  Write-Check "Craft status matched RabiLink AIUI" $craftStatusMatched
  if ($RequireCraftUploadStatus -and -not $craftStatusMatched) {
    $failures.Add("Craft upload status report does not show RabiLink AIUI in the account.")
  }
} else {
  Write-Check "Craft upload status report" $false $resolvedCraftUploadStatusPath
  if ($RequireCraftUploadStatus) {
    $failures.Add("Craft upload status report is missing.")
  }
}

if (Test-Path -LiteralPath $resolvedRuntimeProofStatusPath) {
  Write-Check "runtime proof status report" $true $resolvedRuntimeProofStatusPath
  $runtimeProofStatus = Get-Content -LiteralPath $resolvedRuntimeProofStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $runtimeProofAt = if ($runtimeProofStatus.latest_proof) { Convert-ToEvidenceTimestamp $runtimeProofStatus.latest_proof.time } else { $null }
  $runtimeProofNow = [System.DateTimeOffset]::UtcNow
  $runtimeProofCutoff = $runtimeProofNow.AddMinutes(-[Math]::Max(1, $RuntimeProofMaxAgeMinutes))
  $runtimeProofFutureLimit = $runtimeProofNow.AddMinutes(5)
  $runtimeProofFreshNow = $null -ne $runtimeProofAt `
    -and $runtimeProofAt -ge $runtimeProofCutoff `
    -and $runtimeProofAt -le $runtimeProofFutureLimit
  $runtimeProofFound = [bool]$runtimeProofStatus.proved `
    -and [bool]$runtimeProofStatus.fresh `
    -and [bool]$runtimeProofStatus.required_events_met `
    -and [string]$runtimeProofStatus.expected_app_version -eq $currentCraftReleaseVersion `
    -and -not [string]::IsNullOrWhiteSpace([string]$runtimeProofStatus.proof_session_id) `
    -and $runtimeProofFreshNow
  $latestProofEvent = if ($runtimeProofStatus.latest_proof) { [string]$runtimeProofStatus.latest_proof.event } else { "" }
  Write-Check "runtime proof found current same-session RabiLink AIUI activity" $runtimeProofFound ("event={0}; version={1}; session={2}; fresh now={3} (max {4}m)" -f $latestProofEvent, [string]$runtimeProofStatus.expected_app_version, [string]$runtimeProofStatus.proof_session_id, $runtimeProofFreshNow, [Math]::Max(1, $RuntimeProofMaxAgeMinutes))
  if ($RequireRuntimeProof -and -not $runtimeProofFound) {
    $failures.Add("Runtime proof status report does not show recent current-version startup plus Relay/configuration activity from one AIUI page session.")
  }
} else {
  Write-Check "runtime proof status report" $false $resolvedRuntimeProofStatusPath
  if ($RequireRuntimeProof) {
    $failures.Add("Runtime proof status report is missing.")
  }
}

if (Test-Path -LiteralPath $resolvedPhoneInstallSurfacePath) {
  Write-Check "phone install surface report" $true $resolvedPhoneInstallSurfacePath
  $phoneReport = Get-Content -LiteralPath $resolvedPhoneInstallSurfacePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $phoneHasRokidPackage = [bool](@($phoneReport.matching_packages | Where-Object { $_ -match "(?i)com\.rokid\.sprite\.aiapp" }).Count -gt 0)
  $phoneHasDeviceHash = -not [string]::IsNullOrWhiteSpace([string]$phoneReport.device_aix.sha256)
  $phoneNoPublicAixHandler = -not [bool]$phoneReport.conclusion.public_aix_file_handler_detected
  $phoneAgentManageNotExported = [bool]$phoneReport.conclusion.agent_manage_activity_not_exported
  Write-Check "phone report has Rokid AI package" $phoneHasRokidPackage ($phoneReport.matching_packages -join ", ")
  Write-Check "phone report has device AIX hash" $phoneHasDeviceHash ([string]$phoneReport.device_aix.sha256)
  Write-Check "phone report no public AIX handler" $phoneNoPublicAixHandler
  if ($phoneReport.conclusion.PSObject.Properties.Name -contains "agent_manage_activity_not_exported") {
    Write-Check "phone report agent manage activity not exported" $phoneAgentManageNotExported
  }
  if ($phoneReport.conclusion.PSObject.Properties.Name -contains "agent_store_public_path_reachable") {
    $phoneAgentStoreReachable = [bool]$phoneReport.conclusion.agent_store_public_path_reachable
    $phoneAgentManageReachable = [bool]$phoneReport.conclusion.agent_manage_public_path_reachable
    $phoneAgentSearchReachable = [bool]$phoneReport.conclusion.agent_search_public_path_reachable
    Write-Check "phone report agent store public path reachable" $phoneAgentStoreReachable
    Write-Check "phone report agent manage public path reachable" $phoneAgentManageReachable
    Write-Check "phone report agent search public path reachable" $phoneAgentSearchReachable
  }

  if (Test-Path -LiteralPath $resolvedAixPath) {
    $localAixHash = Get-Sha256Hex $resolvedAixPath
    $phoneHashMatch = ([string]$phoneReport.device_aix.sha256).Trim().ToLowerInvariant() -eq $localAixHash
    Write-Check "phone report AIX hash matches local package" $phoneHashMatch ([string]$phoneReport.device_aix.sha256)
    if ($RequirePhoneInstallSurface -and -not $phoneHashMatch) { $failures.Add("Phone install surface report AIX hash does not match the local package.") }
  }

  if ($RequirePhoneInstallSurface -and -not $phoneHasRokidPackage) { $failures.Add("Phone install surface report does not detect the Rokid AI package.") }
  if ($RequirePhoneInstallSurface -and -not $phoneHasDeviceHash) { $failures.Add("Phone install surface report does not include a device AIX hash.") }
} else {
  Write-Check "phone install surface report" $false $resolvedPhoneInstallSurfacePath
  if ($RequirePhoneInstallSurface) {
    $failures.Add("Phone install surface report is missing.")
  }
}

if (Test-Path -LiteralPath $resolvedApkSurfacePath) {
  Write-Check "APK surface report" $true $resolvedApkSurfacePath
  $apkSurface = Get-Content -LiteralPath $resolvedApkSurfacePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $apkNoPublicAixHandler = -not [bool]$apkSurface.conclusion.public_aix_file_handler_detected
  $apkRequiresSync = [bool]$apkSurface.conclusion.craft_or_store_sync_required
  $apkHasAiappDeepLink = [bool]$apkSurface.conclusion.has_rokid_aiapp_main_deeplink
  Write-Check "APK report no public AIX handler" $apkNoPublicAixHandler
  Write-Check "APK report Craft/store sync required" $apkRequiresSync
  Write-Check "APK report Rokid AI app main deeplink" $apkHasAiappDeepLink
} else {
  Write-Check "APK surface report" $false $resolvedApkSurfacePath
}

$hasCxrGlass = $false
if ((Test-Path -LiteralPath $resolvedRealGlassesStatusPath) -and (Test-Path -LiteralPath $resolvedDeviceStatusE2ePath)) {
  $realGlassesStatus = Get-Content -LiteralPath $resolvedRealGlassesStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $deviceStatusE2e = Get-Content -LiteralPath $resolvedDeviceStatusE2EPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $realEvidenceAt = Convert-ToEvidenceTimestamp $realGlassesStatus.observedAt
  if ($null -eq $realEvidenceAt) { $realEvidenceAt = Convert-ToEvidenceTimestamp $realGlassesStatus.checkedAt }
  $compiledEvidenceAt = Convert-ToEvidenceTimestamp $deviceStatusE2e.checkedAt
  $evidenceCutoff = [System.DateTimeOffset]::UtcNow.AddMinutes(-[Math]::Max(1, $DeviceEvidenceMaxAgeMinutes))
  $futureLimit = [System.DateTimeOffset]::UtcNow.AddMinutes(5)
  $evidenceFresh = $null -ne $realEvidenceAt `
    -and $null -ne $compiledEvidenceAt `
    -and $realEvidenceAt -ge $evidenceCutoff `
    -and $compiledEvidenceAt -ge $evidenceCutoff `
    -and $realEvidenceAt -le $futureLimit `
    -and $compiledEvidenceAt -le $futureLimit
  $hasCxrGlass = [bool]$realGlassesStatus.ok `
    -and [bool]$realGlassesStatus.statusOnlyConnection `
    -and -not [bool]$realGlassesStatus.customViewOpened `
    -and -not [bool]$realGlassesStatus.displaySessionConfigured `
    -and [int]$realGlassesStatus.glassInfoCallbacks -gt 0 `
    -and [string]$realGlassesStatus.source -eq "rokid-cxr-phone" `
    -and [bool]$deviceStatusE2e.ok `
    -and [string]$deviceStatusE2e.source -eq "relay-cxr" `
    -and [bool]$deviceStatusE2e.compiledInkPage `
    -and $evidenceFresh
  $evidenceFreshness = if ($evidenceFresh) { "fresh" } else { "stale or missing timestamp" }
  Write-Check "Rokid/glasses phone CXR evidence" $hasCxrGlass ("callbacks={0}; battery={1}%; charging={2}; AIUI source={3}; {4} (max {5}m)" -f [int]$realGlassesStatus.glassInfoCallbacks, [int]$realGlassesStatus.batteryLevel, [bool]$realGlassesStatus.charging, [string]$deviceStatusE2e.source, $evidenceFreshness, [Math]::Max(1, $DeviceEvidenceMaxAgeMinutes))
} else {
  Write-Check "Rokid/glasses phone CXR evidence" $false "real device-status evidence is missing"
}

$hasDirectGlassAdb = $false
if (Test-Path -LiteralPath $resolvedAdbPath) {
  Write-Check "adb executable" $true $resolvedAdbPath
  $adbOutput = & $resolvedAdbPath devices -l
  $deviceRows = @($adbOutput | Where-Object { $_ -match "\sdevice\s" })
  Write-Output "ADB devices:"
  if ($deviceRows.Count -eq 0) {
    Write-Output "  (none)"
  } else {
    $deviceRows | ForEach-Object { Write-Output ("  " + $_) }
  }
  $glassRows = @($deviceRows | Where-Object { $_ -match "(?i)rokid|glass" })
  $hasDirectGlassAdb = $glassRows.Count -gt 0
  Write-Check "Rokid/glasses direct ADB device" $hasDirectGlassAdb ("matched {0} of {1} device(s); CXR evidence may be used instead" -f $glassRows.Count, $deviceRows.Count)

  if ($deviceRows.Count -gt 0) {
    $packageOutput = & $resolvedAdbPath shell pm list packages 2>$null
    $companionPackages = @($packageOutput | Where-Object { $_ -match "(?i)com\.rokid\.sprite\.aiapp|rokid|sprite|glass|aiui" })
    $hasCompanion = $companionPackages.Count -gt 0
    Write-Check "Rokid companion app on ADB device" $hasCompanion ($companionPackages -join ", ")
    if ($RequireRokidCompanionApp -and -not $hasCompanion) {
      $failures.Add("No Rokid companion app was detected on the connected ADB device.")
    }
  } else {
    Write-Check "Rokid companion app on ADB device" $false "no ADB device"
    if ($RequireRokidCompanionApp) {
      $failures.Add("No ADB device was available for Rokid companion app detection.")
    }
  }
} else {
  Write-Check "adb executable" $false $resolvedAdbPath
}

$hasRealGlass = $hasDirectGlassAdb -or $hasCxrGlass
if ($RequireGlass -and -not $hasRealGlass) {
  $failures.Add("No direct glasses ADB device or verified phone CXR glasses evidence was detected.")
}

if ($failures.Count -gt 0) {
  Write-Output ""
  Write-Output "Readiness result: failed"
  foreach ($failure in $failures) {
    Write-Output ("- " + $failure)
  }
  exit 1
}

Write-Output ""
if ($hasRealGlass) {
  Write-Output "Readiness result: package ready and real glasses detected; final AIX runtime proof still requires Craft upload/sync."
} else {
  Write-Output "Readiness result: package ready; connect glasses through phone CXR or direct ADB, then complete Craft upload."
}
