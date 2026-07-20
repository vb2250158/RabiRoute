param(
  [string] $CraftUrl = "",
  [string] $AixPath = "",
  [string] $DeliveryDir = "",
  [switch] $OpenDelivery,
  [switch] $NoClipboard,
  [switch] $NoBrowser
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "RabiLinkAiuiCraftMetadata.ps1")

function Resolve-OptionalPath {
  param([string] $PathValue)
  if (-not $PathValue) { return "" }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Get-EnvOrValue {
  param(
    [string] $Value,
    [string] $EnvName
  )
  if (-not [string]::IsNullOrWhiteSpace($Value)) { return $Value.Trim() }
  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) { return $envValue.Trim() }
  return ""
}

function Resolve-CraftUrl {
  param([string] $Url)

  if (-not [string]::IsNullOrWhiteSpace($Url)) {
    $uri = [System.Uri]::new($Url.Trim())
    if ($uri.Host -ne "js.rokid.com") {
      throw "CraftUrl must point to js.rokid.com."
    }
    return $uri.AbsoluteUri
  }

  return "https://js.rokid.com/craft?region=cn&lang=zh-CN"
}

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$distRoot = Join-Path $projectRoot "dist"
$CraftUrl = Get-EnvOrValue -Value $CraftUrl -EnvName "ROKID_CRAFT_URL"
$resolvedCraftUrl = Resolve-CraftUrl -Url $CraftUrl

if (-not $AixPath) {
  $AixPath = Resolve-RabiLinkAiuiDefaultAixPath -ProjectRoot $projectRoot
}
$resolvedAixPath = Resolve-OptionalPath $AixPath
if (-not (Test-Path -LiteralPath $resolvedAixPath)) {
  throw "AIX package is missing: $resolvedAixPath. Run npm run delivery first."
}

if (-not $DeliveryDir) {
  $DeliveryDir = if (Test-Path -LiteralPath (Join-Path $projectRoot "package.json")) {
    Join-Path $distRoot "delivery"
  } else {
    $projectRoot
  }
}
$resolvedDeliveryDir = Resolve-OptionalPath $DeliveryDir

$helperPath = Join-Path $PSScriptRoot "craft-browser-upload-helper.js"
if (-not (Test-Path -LiteralPath $helperPath)) {
  throw "Browser helper is missing: $helperPath"
}
$helperText = Get-Content -LiteralPath $helperPath -Raw

if (-not $NoClipboard) {
  Set-Clipboard -Value $helperText
}

if (-not $NoBrowser) {
  Start-Process $resolvedCraftUrl
}

if ($OpenDelivery -and (Test-Path -LiteralPath $resolvedDeliveryDir)) {
  Start-Process -FilePath "explorer.exe" -ArgumentList @($resolvedDeliveryDir)
}

Write-Output "RabiLink AIUI Craft browser upload helper is ready."
Write-Output ("Craft URL: {0}" -f $resolvedCraftUrl)
Write-Output ("AIX: {0}" -f $resolvedAixPath)
Write-Output ("Delivery: {0}" -f $resolvedDeliveryDir)
Write-Output ("Helper copied to clipboard: {0}" -f (-not $NoClipboard))
Write-Output ("Browser opened: {0}" -f (-not $NoBrowser))
Write-Output ""
Write-Output "Next steps:"
Write-Output "1. In the Craft page, open DevTools Console."
Write-Output "2. Paste the helper script from the clipboard and press Enter."
Write-Output "3. Select the AIX package above."
Write-Output "4. Click Check session, Upload selected AIX, List agents, Download report."
Write-Output "5. Run npm run craft:import-browser-report."
