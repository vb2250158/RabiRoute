param(
  [string] $CraftUrl = "",
  [string] $AgentId = "",
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

function Get-QueryValue {
  param(
    [string] $Url,
    [string[]] $Keys
  )
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  $uri = [System.Uri]::new($Url.Trim())
  $query = $uri.Query
  if ([string]::IsNullOrWhiteSpace($query)) { return "" }
  foreach ($key in $Keys) {
    $match = [regex]::Match($query, "(?:^\?|&)" + [regex]::Escape($key) + "=([^&]+)")
    if ($match.Success) {
      return [System.Uri]::UnescapeDataString($match.Groups[1].Value)
    }
  }
  return ""
}

function Read-LastCraftAgentId {
  param([string] $DistRoot)

  $statusPath = Join-Path $DistRoot "craft-upload-status.json"
  if (-not (Test-Path -LiteralPath $statusPath)) { return "" }

  try {
    $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($status.expected -and -not [string]::IsNullOrWhiteSpace([string]$status.expected.agent_id)) {
      return ([string]$status.expected.agent_id).Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$status.agent_id)) {
      return ([string]$status.agent_id).Trim()
    }
  }
  catch {
    return ""
  }

  return ""
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

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$distRoot = Join-Path $projectRoot "dist"
$CraftUrl = Get-EnvOrValue -Value $CraftUrl -EnvName "ROKID_CRAFT_URL"
$resolvedCraftUrl = Resolve-CraftUrl -Url $CraftUrl
$AgentId = Get-EnvOrValue -Value $AgentId -EnvName "ROKID_CRAFT_AGENT_ID"
if ([string]::IsNullOrWhiteSpace($AgentId)) {
  $AgentId = Get-QueryValue -Url $resolvedCraftUrl -Keys @("defaultAgentId", "agentId", "botId", "id")
}
if ([string]::IsNullOrWhiteSpace($AgentId)) {
  $AgentId = Read-LastCraftAgentId -DistRoot $distRoot
}

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

$templatePath = Join-Path $PSScriptRoot "craft-browser-embedded-aix-upload-helper.template.js"
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "Embedded browser helper template is missing: $templatePath"
}

$aixInfo = Get-Item -LiteralPath $resolvedAixPath
$aixBytes = [System.IO.File]::ReadAllBytes($resolvedAixPath)
$aixBase64 = [System.Convert]::ToBase64String($aixBytes)
$aixHash = Get-Sha256Hex $resolvedAixPath
$toolsJson = Get-RabiLinkAiuiCraftToolsJson -AixPath $resolvedAixPath
$toolsJsonString = ConvertTo-Json -InputObject $toolsJson -Compress
$helperText = Get-Content -LiteralPath $templatePath -Raw
$helperText = $helperText.Replace("__RABILINK_AIX_NAME__", $aixInfo.Name)
$helperText = $helperText.Replace("__RABILINK_AIX_SIZE__", [string]$aixInfo.Length)
$helperText = $helperText.Replace("__RABILINK_AIX_SHA256__", $aixHash)
$helperText = $helperText.Replace("__RABILINK_AIX_BASE64__", $aixBase64)
$helperText = $helperText.Replace("__RABILINK_FALLBACK_AGENT_ID__", $AgentId)
$helperText = $helperText.Replace("__RABILINK_TOOLS_JSON_STRING__", $toolsJsonString)

if (-not $NoClipboard) {
  Set-Clipboard -Value $helperText
}

if (-not $NoBrowser) {
  Start-Process $resolvedCraftUrl
}

if ($OpenDelivery -and (Test-Path -LiteralPath $resolvedDeliveryDir)) {
  Start-Process -FilePath "explorer.exe" -ArgumentList @($resolvedDeliveryDir)
}

Write-Output "RabiLink AIUI Craft embedded AIX upload helper is ready."
Write-Output ("Craft URL: {0}" -f $resolvedCraftUrl)
Write-Output ("Fallback agentId: {0}" -f $(if ($AgentId) { $AgentId } else { "(none)" }))
Write-Output ("AIX: {0}" -f $resolvedAixPath)
Write-Output ("AIX size: {0}" -f $aixInfo.Length)
Write-Output ("AIX sha256: {0}" -f $aixHash)
Write-Output ("Embedded helper chars: {0}" -f $helperText.Length)
Write-Output ("Helper copied to clipboard: {0}" -f (-not $NoClipboard))
Write-Output ("Browser opened: {0}" -f (-not $NoBrowser))
Write-Output ""
Write-Output "Next steps:"
Write-Output "1. In the Craft page, open DevTools Console."
Write-Output "2. Paste the embedded helper script from the clipboard and press Enter."
Write-Output "3. Click Find agentId if the agentId field is empty, then Check session, Upload embedded AIX, List agents, Download report."
Write-Output "4. Run npm run craft:import-browser-report or npm run craft:watch-browser-report."
